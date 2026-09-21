#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x ".venv/bin/python" ]]; then
  echo "[Alpha 1.39] Ambiente virtual não encontrado. Execute ./install.sh primeiro."
  exit 1
fi
exec .venv/bin/python run_launcher.py
