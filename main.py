"""Vercel entrypoint for the source-layout FastAPI application."""

from pathlib import Path
import sys


SOURCE_ROOT = Path(__file__).parent / "src"
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from nova_generator.main import app  # noqa: E402

__all__ = ["app"]
