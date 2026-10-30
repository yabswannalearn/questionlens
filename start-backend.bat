@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  where py >nul 2>&1
  if not errorlevel 1 (
    py -3 -m venv .venv
  ) else (
    where python >nul 2>&1
    if errorlevel 1 (
      echo Python 3.10 or newer is required. Install Python and run this file again.
      exit /b 1
    )
    python -m venv .venv
  )
  if errorlevel 1 exit /b 1
)

.venv\Scripts\python.exe -c "import sys; sys.exit(sys.version_info < (3, 10))"
if errorlevel 1 (
  echo Python 3.10 or newer is required. Install it, remove the .venv folder, and run this file again.
  exit /b 1
)

.venv\Scripts\python.exe -c "import fastapi, uvicorn, google.genai, google.auth, cryptography, dotenv, zeroconf" >nul 2>&1
if errorlevel 1 (
  echo Installing required Python packages...
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 exit /b 1
)

echo Starting Question Lens. Keep this window open; press Ctrl+C to stop.
.venv\Scripts\python.exe local_server.py %*
