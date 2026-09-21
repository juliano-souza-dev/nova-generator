import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from youtube_pipeline import download_video


def _first_selector(highest_quality):
    captured = []
    class Downloader:
        def __init__(self, options):
            captured.append(options['format'])
            self.options = options
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def download(self, _):
            Path(self.options['outtmpl'].replace('%(ext)s', 'mp4')).write_bytes(b'video')
            return 0
    with TemporaryDirectory() as temp, patch.dict(sys.modules, {'yt_dlp': SimpleNamespace(YoutubeDL=Downloader)}), patch('youtube_pipeline._ensure_ytdlp'), patch('youtube_pipeline._player_clients', return_value=['']):
        download_video('https://youtu.be/test', temp, highest_quality=highest_quality)
    return captured[0]


def test_dual_scene_requests_unrestricted_best_quality_first():
    assert _first_selector(True) == 'bestvideo+bestaudio/best'


def test_regular_download_keeps_720p_policy():
    assert 'height<=720' in _first_selector(False)
