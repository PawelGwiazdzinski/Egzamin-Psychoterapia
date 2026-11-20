#!/usr/bin/env bash
# Lektor – uruchomienie (macOS / Linux)
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
  .venv/bin/pip install -q -r requirements-offline.txt || echo "(Piper offline pominięty)"
fi
exec .venv/bin/python -m server.app
