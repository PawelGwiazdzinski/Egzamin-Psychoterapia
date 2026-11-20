@echo off
REM Lektor - uruchomienie (Windows)
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\pip install -q -r requirements.txt
  .venv\Scripts\pip install -q -r requirements-offline.txt
)
.venv\Scripts\python -m server.app
pause
