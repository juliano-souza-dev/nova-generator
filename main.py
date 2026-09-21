"""Vercel entrypoint for the source-layout FastAPI application."""

from pathlib import Path
import sys


source_root = Path(__file__).parent / "src"
if str(source_root) not in sys.path:
    sys.path.insert(0, str(source_root))

from nova_generator.main import app  # noqa: E402

