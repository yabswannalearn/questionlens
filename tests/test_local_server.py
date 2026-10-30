import ipaddress
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization

import local_server


class LocalServerTests(unittest.TestCase):
    def test_certificate_is_reused_and_updated_for_new_ip(self):
        with tempfile.TemporaryDirectory() as directory:
            first = local_server.ensure_certificates(directory, '192.168.1.10')
            authority = first.authority.read_bytes()
            server = first.server.read_bytes()
            local_server.ensure_certificates(directory, '192.168.1.10')
            self.assertEqual(server, first.server.read_bytes())
            local_server.ensure_certificates(directory, '192.168.1.11')
            self.assertEqual(authority, first.authority.read_bytes())
            self.assertNotEqual(server, first.server.read_bytes())
            cert = x509.load_pem_x509_certificate(first.server.read_bytes())
            names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            self.assertIn('questionlens.local', names.get_values_for_type(x509.DNSName))
            self.assertIn(ipaddress.ip_address('192.168.1.11'), names.get_values_for_type(x509.IPAddress))

    def test_setup_page_only_serves_public_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            certs = local_server.ensure_certificates(directory, '127.0.0.1')
            server = local_server.make_setup_server('127.0.0.1', 0, certs.authority, 8443)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f'http://127.0.0.1:{server.server_port}'
                with urllib.request.urlopen(base + '/QuestionLens.cer') as response:
                    downloaded = response.read()
                public = x509.load_pem_x509_certificate(certs.authority.read_bytes())
                self.assertEqual(downloaded, public.public_bytes(serialization.Encoding.DER))
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base + '/rootCA-key.pem')
                self.assertEqual(error.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
