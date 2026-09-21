#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v python3 >/dev/null
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
echo "Pronto. Execute ./run.sh. O terminal mostrará a URL pública e o QR Code para o celular."
