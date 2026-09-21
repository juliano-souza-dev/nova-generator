from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("GENERATOR_PORT", "8080"))
LOCAL_URL = f"http://127.0.0.1:{PORT}"
TUNNEL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)


def _cloudflared_download_spec(system: str | None = None, machine: str | None = None) -> tuple[str, str]:
    system = (system or platform.system()).lower()
    machine = (machine or platform.machine()).lower()

    is_arm64 = machine in {"arm64", "aarch64"}
    is_x86 = machine in {"x86", "i386", "i686"}

    if system == "windows":
        asset = "cloudflared-windows-386.exe" if is_x86 else "cloudflared-windows-amd64.exe"
        filename = "cloudflared.exe"
    elif system == "linux":
        if is_arm64:
            asset = "cloudflared-linux-arm64"
        elif is_x86:
            asset = "cloudflared-linux-386"
        else:
            asset = "cloudflared-linux-amd64"
        filename = "cloudflared"
    elif system == "darwin":
        asset = "cloudflared-darwin-arm64.tgz" if is_arm64 else "cloudflared-darwin-amd64.tgz"
        raise RuntimeError(
            "Download automático no macOS não é usado. Instale com: brew install cloudflared"
        )
    else:
        raise RuntimeError(f"Sistema não suportado para download automático do cloudflared: {system}")

    url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}"
    return url, filename


def _download_cloudflared() -> Path:
    tools = ROOT / ".tools"
    tools.mkdir(exist_ok=True)
    url, filename = _cloudflared_download_spec()
    target = tools / filename
    partial = target.with_suffix(target.suffix + ".download")

    print("[RUN] cloudflared não encontrado. Baixando binário oficial da Cloudflare...")
    request = urllib.request.Request(url, headers={"User-Agent": "ImmersionHub-Generator/1.38"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
        partial.replace(target)
    finally:
        if partial.exists():
            partial.unlink(missing_ok=True)

    if os.name != "nt":
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return target


def _find_cloudflared() -> Path:
    installed = shutil.which("cloudflared")
    if installed:
        return Path(installed)

    local = ROOT / ".tools" / ("cloudflared.exe" if os.name == "nt" else "cloudflared")
    if local.is_file():
        return local
    return _download_cloudflared()


def _wait_for_server(process: subprocess.Popen[bytes], timeout: float = 25.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Uvicorn encerrou antes de iniciar (código {process.returncode}).")
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError(f"Servidor local não respondeu em {LOCAL_URL}.")


def _stop(process: subprocess.Popen | None) -> None:
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=4)
    except subprocess.TimeoutExpired:
        process.kill()



def _show_mobile_access(url: str) -> Path | None:
    """Print a scannable QR in the terminal and save a PNG copy."""
    print("\n" + "=" * 68)
    print(" ACESSO PELO CELULAR")
    print(f" {url}")

    try:
        try:
            import qrcode
        except ModuleNotFoundError:
            print(" [QR] Dependência ausente. Instalando suporte a QR Code uma única vez...")
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "qrcode[pil]>=8,<9"],
                cwd=ROOT,
            )
            import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)

        print("\n Escaneie o QR Code com a câmera do celular:\n")
        qr.print_ascii(invert=True)

        qr_path = ROOT / "mobile_access_qr.png"
        qr.make_image(fill_color="black", back_color="white").save(qr_path)
        print(f" QR salvo em: {qr_path.name}")
    except Exception as exc:
        qr_path = None
        print(f" [QR] Não foi possível gerar o QR Code: {exc}")
        print(" [QR] Execute install.bat/install.sh para instalar as dependências da versão atual.")

    print(" Abra a câmera do celular e aponte para o QR Code.")
    print("=" * 68 + "\n")
    return qr_path

def main() -> int:
    print("=" * 68)
    print(" Media and Subtitle Generator · Alpha 1.39")
    print(" Local + Mobile Quick Tunnel")
    print("=" * 68)

    server: subprocess.Popen | None = None
    tunnel: subprocess.Popen | None = None

    try:
        server_cmd = [
            sys.executable,
            "-m",
            "uvicorn",
            "app:app",
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
        ]
        print(f"[RUN] Iniciando Generator em {LOCAL_URL} ...")
        server = subprocess.Popen(server_cmd, cwd=ROOT)
        _wait_for_server(server)
        print(f"[RUN] Desktop/local: {LOCAL_URL}")

        try:
            cloudflared = _find_cloudflared()
        except Exception as exc:
            print(f"[TUNNEL] Não foi possível preparar o túnel: {exc}")
            print("[TUNNEL] O Generator continuará disponível somente localmente.")
            print("[RUN] Ctrl+C encerra o servidor.")
            return server.wait()

        print("[TUNNEL] Abrindo acesso público temporário para o celular...")
        tunnel = subprocess.Popen(
            [str(cloudflared), "tunnel", "--url", LOCAL_URL],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        shown_url = False
        assert tunnel.stdout is not None
        for raw_line in tunnel.stdout:
            line = raw_line.rstrip()
            match = TUNNEL_RE.search(line)
            if match and not shown_url:
                shown_url = True
                _show_mobile_access(match.group(0))
            else:
                print(f"[cloudflared] {line}")

        code = tunnel.wait()
        if not shown_url:
            print("[TUNNEL] O cloudflared encerrou sem fornecer uma URL pública.")
        return code

    except KeyboardInterrupt:
        print("\n[RUN] Encerrando Generator e túnel...")
        return 0
    except Exception as exc:
        print(f"[RUN] Erro: {exc}")
        return 1
    finally:
        _stop(tunnel)
        _stop(server)


if __name__ == "__main__":
    raise SystemExit(main())
