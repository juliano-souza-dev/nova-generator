from pathlib import Path

import run_launcher


def test_cloudflared_windows_asset():
    url, filename = run_launcher._cloudflared_download_spec("Windows", "AMD64")
    assert url.endswith("/cloudflared-windows-amd64.exe")
    assert filename == "cloudflared.exe"


def test_cloudflared_linux_arm64_asset():
    url, filename = run_launcher._cloudflared_download_spec("Linux", "aarch64")
    assert url.endswith("/cloudflared-linux-arm64")
    assert filename == "cloudflared"


def test_mobile_layer_is_scoped_to_mobile():
    css = (Path(__file__).parents[1] / "static" / "styles.css").read_text(encoding="utf-8")
    marker = "Alpha 1.39 · Mobile workspace layer"
    assert marker in css
    mobile = css.split(marker, 1)[1]
    assert "@media(max-width:767px)" in mobile
    assert ".flow-nav{top:60px" in mobile


def test_all_html_pages_load_mobile_helper():
    static = Path(__file__).parents[1] / "static"
    pages = list(static.glob("*.html"))
    assert pages
    for page in pages:
        text = page.read_text(encoding="utf-8")
        assert "/static/mobile.js?v=alpha-1.39" in text, page.name


def test_qr_dependency_is_declared():
    requirements = (Path(__file__).parents[1] / "requirements.txt").read_text(encoding="utf-8")
    lines = [line.strip().lower() for line in requirements.splitlines() if line.strip()]
    assert any(line.startswith("qrcode[pil]>=8") for line in lines)
    assert "\\n" not in requirements


def test_show_mobile_access_creates_png(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(run_launcher, "ROOT", tmp_path)
    url = "https://mobile-test.trycloudflare.com"
    qr_path = run_launcher._show_mobile_access(url)
    out = capsys.readouterr().out
    assert url in out
    assert "QR Code" in out
    assert qr_path == tmp_path / "mobile_access_qr.png"
    assert qr_path.is_file()
    assert qr_path.stat().st_size > 0
