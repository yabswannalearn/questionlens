"""Start the local HTTPS app, certificate setup page, and Wi-Fi discovery."""

import argparse
import ipaddress
import os
import socket
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import uvicorn
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from dotenv import load_dotenv
from zeroconf import IPVersion, ServiceInfo, Zeroconf

ROOT = Path(__file__).resolve().parent
HOSTNAME = 'questionlens.local'


@dataclass(frozen=True)
class Certificates:
    authority: Path
    server: Path
    server_key: Path


def detect_address():
    override = os.getenv('QUESTIONLENS_HOST_IP')
    if override:
        return str(ipaddress.IPv4Address(override))
    try:
        # Connecting a UDP socket selects an interface without sending data.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('8.8.8.8', 53))
            address = ipaddress.IPv4Address(sock.getsockname()[0])
        if address.is_loopback or address.is_link_local or address.is_unspecified:
            raise OSError('No usable local address')
        return str(address)
    except OSError as exc:
        raise RuntimeError('Could not detect a local IPv4 address. Connect to Wi-Fi or set QUESTIONLENS_HOST_IP in .env.') from exc


def _write_key(path, key):
    path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption(),
    ))
    path.chmod(0o600)


def _public_bytes(key):
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


def ensure_certificates(directory, address):
    address = ipaddress.IPv4Address(address)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    ca_path = directory / 'rootCA.pem'
    ca_key_path = directory / 'rootCA-key.pem'
    server_path = directory / 'server.pem'
    server_key_path = directory / 'server-key.pem'
    now = datetime.now(timezone.utc)

    if ca_path.exists() != ca_key_path.exists():
        raise RuntimeError('The local certificate authority is incomplete. Restore both rootCA files or create a new certificate and trust it again on the phone.')
    if not ca_path.exists():
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Question Lens Local CA')])
        ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
              .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=3650))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                  key_encipherment=False, data_encipherment=False, key_agreement=False,
                  key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
              .sign(ca_key, hashes.SHA256()))
        _write_key(ca_key_path, ca_key)
        ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    else:
        ca = x509.load_pem_x509_certificate(ca_path.read_bytes())
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
        if _public_bytes(ca.public_key()) != _public_bytes(ca_key.public_key()):
            raise RuntimeError('The local certificate authority key does not match its certificate.')
        if ca.not_valid_after_utc <= now + timedelta(days=30):
            raise RuntimeError('The local certificate authority is expiring. Create a new certificate and trust it again on the phone.')

    valid = False
    if server_path.is_file() and server_key_path.is_file():
        try:
            server = x509.load_pem_x509_certificate(server_path.read_bytes())
            server_key = serialization.load_pem_private_key(server_key_path.read_bytes(), password=None)
            names = server.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            ca.public_key().verify(server.signature, server.tbs_certificate_bytes, padding.PKCS1v15(), server.signature_hash_algorithm)
            valid = (server.issuer == ca.subject and server.not_valid_before_utc <= now
                     and server.not_valid_after_utc > now + timedelta(days=30)
                     and HOSTNAME in names.get_values_for_type(x509.DNSName)
                     and address in names.get_values_for_type(x509.IPAddress)
                     and _public_bytes(server.public_key()) == _public_bytes(server_key.public_key()))
        except (ValueError, TypeError, x509.ExtensionNotFound, InvalidSignature):
            valid = False

    if not valid:
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, HOSTNAME)])
        server = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca.subject)
                  .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
                  .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=365))
                  .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                  .add_extension(x509.SubjectAlternativeName([
                      x509.DNSName(HOSTNAME), x509.DNSName('localhost'),
                      x509.IPAddress(address), x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
                  ]), critical=False)
                  .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                  .sign(ca_key, hashes.SHA256()))
        _write_key(server_key_path, server_key)
        server_path.write_bytes(server.public_bytes(serialization.Encoding.PEM))
    return Certificates(ca_path, server_path, server_key_path)


def make_setup_server(address, port, authority, app_port):
    certificate = x509.load_pem_x509_certificate(Path(authority).read_bytes()).public_bytes(serialization.Encoding.DER)

    class SetupHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split('?', 1)[0]
            if path == '/QuestionLens.cer':
                content = certificate
                content_type = 'application/x-x509-ca-cert'
            elif path == '/':
                content = (f'<!doctype html><meta name="viewport" content="width=device-width">'
                           f'<title>Question Lens setup</title><h1>Question Lens setup</h1>'
                           f'<p><a href="/QuestionLens.cer">Download the public certificate</a></p>'
                           f'<p>Install the downloaded profile in Settings, then enable it under '
                           f'Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings.</p>'
                           f'<p>After installing and trusting it, open '
                           f'<a href="https://{HOSTNAME}:{app_port}/">Question Lens</a>.</p>').encode()
                content_type = 'text/html; charset=utf-8'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(content)

    return ThreadingHTTPServer((address, port), SetupHandler)


def announce(address, port):
    zc = Zeroconf(interfaces=[address], ip_version=IPVersion.V4Only)
    info = ServiceInfo('_https._tcp.local.', 'Question Lens._https._tcp.local.',
                       addresses=[socket.inet_aton(address)], port=port, server=HOSTNAME + '.', host_ttl=15)
    try:
        zc.register_service(info)
    except Exception:
        zc.close()
        raise
    return zc, info


def main():
    parser = argparse.ArgumentParser(description='Run Question Lens on the local network.')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--setup-port', type=int, default=8444)
    parser.add_argument('--address', help='Laptop IPv4 address; normally detected automatically')
    parser.add_argument('--cert-dir', type=Path, default=ROOT / 'certs' / 'portable')
    args = parser.parse_args()
    os.chdir(ROOT)
    load_dotenv(ROOT / '.env', override=False)
    address = str(ipaddress.IPv4Address(args.address)) if args.address else detect_address()
    certificates = ensure_certificates(args.cert_dir, address)
    authority = x509.load_pem_x509_certificate(certificates.authority.read_bytes())
    fingerprint = authority.fingerprint(hashes.SHA256()).hex(':').upper()

    setup_server = None
    zc = None
    info = None
    try:
        try:
            setup_server = make_setup_server('0.0.0.0', args.setup_port, certificates.authority, args.port)
            threading.Thread(target=setup_server.serve_forever, daemon=True).start()
        except OSError:
            print(f'Certificate setup port {args.setup_port} is busy; copy the public rootCA.pem from {args.cert_dir} to your phone instead.', flush=True)
        try:
            zc, info = announce(address, args.port)
            print(f'App URL: https://{HOSTNAME}:{args.port}', flush=True)
        except Exception as exc:
            print(f'Local name unavailable ({type(exc).__name__}); use the IP address below.', flush=True)
        print(f'IP address fallback: https://{address}:{args.port}', flush=True)
        if setup_server:
            print(f'First-time phone setup: http://{address}:{args.setup_port}/', flush=True)
        print(f'Public certificate SHA-256: {fingerprint}', flush=True)
        if not os.getenv('GEMINI_API_KEY') or not os.getenv('GOOGLE_VISION_KEY_PATH'):
            print('Set GEMINI_API_KEY and GOOGLE_VISION_KEY_PATH in .env to use OCR and answers.', flush=True)
        uvicorn.run('app:app', host='0.0.0.0', port=args.port, log_level='info',
                    ssl_certfile=str(certificates.server), ssl_keyfile=str(certificates.server_key))
    finally:
        if zc:
            zc.unregister_service(info)
            zc.close()
        if setup_server:
            setup_server.shutdown()
            setup_server.server_close()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as exc:
        print(f'Could not start Question Lens: {exc}', flush=True)
        raise SystemExit(1) from None
