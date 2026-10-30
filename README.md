# Question Lens

A local, phone-friendly practice-question scanner. The iPhone captures snapshots; the Windows laptop sends them to Google Cloud Vision for OCR and calls Gemini Flash for answers. A local history is stored in `questions.sqlite3`.

## What you need

- Python 3.10 or newer on Windows, a Gemini API key, and a Google Cloud Vision service-account JSON credential with Vision API access.
- An iPhone and laptop on the same Wi-Fi network. The laptop needs internet access for Vision and Gemini.
- Each laptop needs its own one-time HTTPS certificate setup on the iPhone so the browser can use the camera.

## Setup on Windows

Copy `.env.example` to `.env`, put your Gemini API key in it, and set `GOOGLE_VISION_KEY_PATH` to your Google Cloud Vision service-account JSON file. For example, put that private file at `secrets\google-vision.json`. Copy your credentials securely to each laptop; they are not included in this repository. Windows environment variables work too.

```powershell
Copy-Item .env.example .env
notepad .env
.\start-backend.bat
```

You can also double-click `start-backend.bat`. It creates the Python environment and installs missing packages on the first run, then starts the app, its frontend, and the certificate setup page. Leave the window open for logs; press Ctrl+C to stop. A Python variable set only in a different terminal is not shared automatically.

## Connect the iPhone

1. Connect the phone and laptop to the same Wi-Fi. If Windows Firewall asks, allow Python on private networks.
2. On the phone, open the **First-time phone setup** HTTP address printed in the laptop terminal and download the certificate.
3. Install the downloaded profile in iPhone Settings, then enable it under **Settings → General → About → Certificate Trust Settings**.
4. Open **https://questionlens.local:8443** on the phone and allow camera access.

The same `questionlens.local` URL is advertised by each laptop; run one laptop server at a time. Each laptop creates its own certificate, so repeat steps 2–3 once per laptop. Keep the `certs` folder to retain that trust across restarts; the server updates its certificate automatically if the Wi-Fi IP changes. Never share `rootCA-key.pem` or any other private key.

If the name does not resolve, use the HTTPS IP address printed as **IP address fallback**. Some Wi-Fi networks block local discovery or communication between devices. If the wrong network adapter is selected, set `QUESTIONLENS_HOST_IP` in `.env` to the laptop's Wi-Fi IPv4 address and restart. If the setup port is already in use, the terminal shows where to find the public certificate for transfer to the phone.

Each laptop stores its own history in `questions.sqlite3`; the database is not synced between laptops. Credentials, certificates, the database, and JSON files are ignored by Git to help prevent accidental publication.

The default model is `gemini-3.5-flash-lite`. To use a different Gemini model available to your API key, set `GEMINI_MODEL` in `.env` or as an environment variable before starting the server.

## Use

Place the phone on its tripod, point it at one complete question and all its choices, and press **Start camera**. Keep the pointer outside the question. The phone checks the camera view every 15 seconds and sends selected snapshots for Cloud Vision OCR, without overlapping requests. A visible change triggers a new OCR request; an unchanged view is not repeatedly sent, except when the last reading was incomplete. Tap **Scan now** to take and process a snapshot without waiting for the next automatic check; if a scan is in progress, one manual scan runs immediately afterward. A readable new question is sent to Gemini after a single OCR reading. If Gemini fails, the app automatically retries up to five times, then offers a Retry button. A matching question answered earlier in the current page session reuses its answer.

Use **Stop polling** to stop automatic checks while leaving the camera and **Scan now** available. An OCR request already in progress can finish. Use **Start polling** to resume automatic checks.

Tap the **1.0×** control to open the zoom slider. Zoom is a digital crop, from 1× to 4×, so it cannot add detail beyond what the camera captured. The visible camera region, including the zoom, is sent for OCR.

Each confirmed question sent to Gemini is saved in the local SQLite database `questions.sqlite3`, along with its timestamp, status, and Gemini answer when available. Retries update the same record. The session cache is cleared when the page reloads; the saved database history is not automatically reused. The database is excluded from Git.

Starting the camera opens the full-screen-style scanning view so the current status and answer are visible. Use **Landscape** in full screen to request landscape orientation; if the browser cannot rotate the device, the button rotates the app view instead and becomes **Undo rotation**. Physically rotate the phone sideways to view it. Use **Exit full screen** to return to the regular page. iPhone browsers can still show browser controls; to open the app without the usual Safari address bar, use Safari's Share menu → **Add to Home Screen**, then open Question Lens from your Home Screen.

OCR reads the camera region visible in the preview. Keep surrounding text out of view. OCR may occasionally read incomplete or incorrect text, and Gemini's answers may be incorrect. Check the result against your study materials. Camera choice and OCR performance depend on the phone and browser; test the actual tripod setup. Cloud Vision is billed per image. Flicker or camera movement can be detected as a change and cause extra OCR requests; if a change is missed, use **Scan now**.

Exit full screen and use **View OCR reading** on the phone to inspect the latest recognized text. Selected camera snapshots are sent to the laptop and Google Cloud Vision. Screen glare, flicker, and small text can make readings inaccurate.

The server is intended for your trusted local network, has no login, and makes Gemini requests using the laptop's key. Do not expose it to the public internet.
