"""Guard the local Windows launcher against accidental port hijacking."""

from pathlib import Path


def test_launcher_recycles_only_vite_from_current_project() -> None:
    launcher = (
        Path(__file__).resolve().parents[2] / "scripts" / "start-local.ps1"
    ).read_text(encoding="utf-8")

    assert "function Clear-PreviousFrontend" in launcher
    assert 'Get-NetTCPConnection -LocalPort 5173 -State Listen' in launcher
    assert 'Join-Path $FrontendRoot "node_modules\\vite\\bin\\vite.js"' in launcher
    assert '$instance.Name -ne "node.exe"' in launcher
    assert "$normalizedCommand.IndexOf($viteScriptPath" in launcher
    assert "Stop-Process -Id $owningProcessId" in launcher
    before_start = launcher.split('Write-Step "Iniciando API, worker e interface..."')[0]
    assert "Clear-PreviousFrontend" in before_start
    assert '"--strictPort"' in launcher
    assert "não foi identificado como Vite deste projeto" in launcher
