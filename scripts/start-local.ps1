[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$SkipBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$FrontendRoot = Join-Path $ProjectRoot "frontend"
$RuntimeRoot = Join-Path $ProjectRoot ".local-runtime"
$LogRoot = Join-Path $ProjectRoot "data\logs"
$BackendVenv = Join-Path $ProjectRoot ".venv"
$TtsVenv = Join-Path $ProjectRoot ".venv-tts"
$BackendPython = Join-Path $BackendVenv "Scripts\python.exe"
$TtsPython = Join-Path $TtsVenv "Scripts\python.exe"
$Processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Write-Step([string]$Message) {
    Write-Host "`n[Nova Generator] $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

function Find-Python312 {
    $launcher = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if ($launcher) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $launcher.Source -3.12 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" 2>$null
        $ErrorActionPreference = $previousPreference
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Executable = $launcher.Source; Prefix = @("-3.12") }
        }
    }
    $python = Get-Command "python.exe" -ErrorAction SilentlyContinue
    if ($python) {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $python.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" 2>$null
        $ErrorActionPreference = $previousPreference
        if ($LASTEXITCODE -eq 0) {
            return [pscustomobject]@{ Executable = $python.Source; Prefix = @() }
        }
    }
    return $null
}

function Install-WingetPackage([string]$Id, [string]$Label) {
    $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "$Label não foi encontrado. Instale-o e execute INICIAR.bat novamente."
    }
    Write-Step "Instalando $Label (uma vez)..."
    & $winget.Source install --id $Id --exact --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) {
        throw "A instalação de $Label falhou (winget código $LASTEXITCODE)."
    }
    Refresh-ProcessPath
}

function Invoke-Python([object]$PythonCommand, [string[]]$Arguments) {
    & $PythonCommand.Executable @($PythonCommand.Prefix) @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "O comando Python falhou (código $LASTEXITCODE)."
    }
}

function Ensure-Prerequisites {
    Write-Step "Verificando Python, Node.js e FFmpeg..."
    $pythonCommand = Find-Python312
    if (-not $pythonCommand) {
        Install-WingetPackage "Python.Python.3.12" "Python 3.12"
        $pythonCommand = Find-Python312
    }
    if (-not $pythonCommand) {
        throw "Python 3.12 foi instalado, mas ainda não está acessível. Reinicie o Windows e clique em INICIAR.bat."
    }
    if (-not (Get-Command "node.exe" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"
    }
    if (-not (Get-Command "ffmpeg.exe" -ErrorAction SilentlyContinue) -or -not (Get-Command "ffprobe.exe" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "Gyan.FFmpeg" "FFmpeg/FFprobe"
    }
    if (-not (Get-Command "node.exe" -ErrorAction SilentlyContinue) -or -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) {
        throw "Node.js foi instalado, mas ainda não está acessível. Reinicie o Windows e clique em INICIAR.bat."
    }
    if (-not (Get-Command "ffmpeg.exe" -ErrorAction SilentlyContinue) -or -not (Get-Command "ffprobe.exe" -ErrorAction SilentlyContinue)) {
        throw "FFmpeg foi instalado, mas ainda não está acessível. Reinicie o Windows e clique em INICIAR.bat."
    }
    return $pythonCommand
}

function Get-ManifestHash([string[]]$Paths) {
    $builder = [System.Text.StringBuilder]::new()
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($path in $Paths) {
        if (Test-Path -LiteralPath $path) {
            $stream = [IO.File]::OpenRead($path)
            try {
                $fileHash = $sha.ComputeHash($stream)
                [void]$builder.Append(([BitConverter]::ToString($fileHash)).Replace("-", ""))
            } finally {
                $stream.Dispose()
            }
        }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $manifestHash = $sha.ComputeHash($bytes)
    $sha.Dispose()
    return ([BitConverter]::ToString($manifestHash)).Replace("-", "")
}

function Ensure-Backend([object]$PythonCommand) {
    Write-Step "Preparando backend e reconhecimento de voz..."
    if (-not (Test-Path -LiteralPath $BackendPython)) {
        Invoke-Python $PythonCommand @("-m", "venv", $BackendVenv)
    }
    $expected = Get-ManifestHash @((Join-Path $ProjectRoot "pyproject.toml"))
    $stamp = Join-Path $RuntimeRoot "backend.sha256"
    $current = if (Test-Path -LiteralPath $stamp) { (Get-Content -Raw $stamp).Trim() } else { "" }
    $rootStamp = Join-Path $RuntimeRoot "backend-project-root.txt"
    $installedRoot = if (Test-Path -LiteralPath $rootStamp) { (Get-Content -Raw $rootStamp).Trim() } else { "" }
    $importWorks = $false
    if (Test-Path -LiteralPath $BackendPython) {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & $BackendPython -c "import nova_generator" 2>$null
            $importWorks = $LASTEXITCODE -eq 0
        } finally {
            $ErrorActionPreference = $previousPreference
        }
    }
    if ($current -ne $expected -or $installedRoot -ne $ProjectRoot -or -not $importWorks) {
        & $BackendPython -m pip install --upgrade pip
        if ($LASTEXITCODE -ne 0) { throw "Falha ao atualizar pip do backend." }
        & $BackendPython -m pip install -e "$ProjectRoot[asr]"
        if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar backend/ASR." }
        Set-Content -LiteralPath $stamp -Value $expected -Encoding ASCII
        Set-Content -LiteralPath $rootStamp -Value $ProjectRoot -Encoding UTF8
    }
}

# The 0.1.7 PyPI wheel does not support nano=True. Keep the upstream
# revision pinned: version numbers alone are insufficient (both report 0.1.7).
$ChatterboxNanoCommit = "5de7a54aa4e5e2baadb0182dde554908b48b85c2"

function Test-TtsRuntime([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable)) { return $false }
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        # Checking imports alone reuses the incompatible 0.1.7 PyPI wheel.
        & $Executable -c "import inspect, torch, torchaudio; from chatterbox.tts_turbo import ChatterboxTurboTTS; assert 'nano' in inspect.signature(ChatterboxTurboTTS.from_pretrained).parameters" 2>$null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return $exitCode -eq 0
}

function Ensure-Tts([object]$PythonCommand) {
    Write-Step "Preparando Chatterbox Nano isolado..."
    $expected = "chatterbox-nano-source=$ChatterboxNanoCommit;torch=2.6.0;python=3.12"
    $stamp = Join-Path $RuntimeRoot "tts.sha256"
    $current = if (Test-Path -LiteralPath $stamp) { (Get-Content -Raw $stamp).Trim() } else { "" }
    if ((Test-Path -LiteralPath $TtsPython) -and $current -eq $expected -and (Test-TtsRuntime $TtsPython)) {
        return $TtsPython
    }
    if (-not (Test-Path -LiteralPath $TtsPython)) {
        Invoke-Python $PythonCommand @("-m", "venv", $TtsVenv)
    }
    # Git is required by the source package's resemble-perth dependency.
    if (-not (Get-Command "git.exe" -ErrorAction SilentlyContinue)) {
        Install-WingetPackage "Git.Git" "Git"
    }
    if (-not (Get-Command "git.exe" -ErrorAction SilentlyContinue)) {
        throw "Git não está disponível para instalar o Chatterbox Nano do código-fonte."
    }
    & $TtsPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "Falha ao atualizar pip do Chatterbox." }
    & $TtsPython -m pip install "torch==2.6.0" "torchaudio==2.6.0" --index-url "https://download.pytorch.org/whl/cpu"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar PyTorch CPU do Chatterbox." }
    # Do not silently switch to Turbo. Install a known Nano-capable revision.
    & $TtsPython -m pip install --upgrade --force-reinstall --no-deps "git+https://github.com/resemble-ai/chatterbox.git@$ChatterboxNanoCommit"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar Chatterbox Nano do código-fonte." }
    # Source dependencies beyond PyTorch may be missing on a fresh machine.
    & $TtsPython -m pip install "git+https://github.com/resemble-ai/chatterbox.git@$ChatterboxNanoCommit"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar dependências do Chatterbox Nano." }
    if (-not (Test-TtsRuntime $TtsPython)) {
        throw "Chatterbox incompatível: from_pretrained não aceita nano=True mesmo após a atualização. Confira data/logs e .venv-tts."
    }
    Set-Content -LiteralPath $stamp -Value $expected -Encoding ASCII
    return $TtsPython
}

function Ensure-Frontend {
    Write-Step "Preparando interface..."
    $lock = Join-Path $FrontendRoot "package-lock.json"
    $expected = Get-ManifestHash @($lock, (Join-Path $FrontendRoot "package.json"))
    $stamp = Join-Path $RuntimeRoot "frontend.sha256"
    $current = if (Test-Path -LiteralPath $stamp) { (Get-Content -Raw $stamp).Trim() } else { "" }
    if ($current -ne $expected -or -not (Test-Path -LiteralPath (Join-Path $FrontendRoot "node_modules"))) {
        Push-Location $FrontendRoot
        try {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar dependências do frontend." }
        } finally {
            Pop-Location
        }
        Set-Content -LiteralPath $stamp -Value $expected -Encoding ASCII
    }
}

function Wait-Http([string]$Url, [System.Diagnostics.Process]$Process, [string]$Name) {
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if ($Process.HasExited) {
            throw "$Name encerrou durante a inicialização. Consulte data\logs."
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "$Name não respondeu em $Url. Consulte data\logs."
}

function Start-ServiceProcess(
    [string]$Name,
    [string]$Executable,
    [string[]]$Arguments,
    [string]$WorkingDirectory
) {
    $stdout = Join-Path $LogRoot "$Name.log"
    $stderr = Join-Path $LogRoot "$Name-error.log"
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $Processes.Add($process)
    return $process
}

try {
    Set-Location $ProjectRoot
    New-Item -ItemType Directory -Force -Path $RuntimeRoot, $LogRoot | Out-Null
    $pythonCommand = Ensure-Prerequisites
    Ensure-Backend $pythonCommand
    $ttsExecutable = Ensure-Tts $pythonCommand
    Ensure-Frontend

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".env"))) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot ".env.example") -Destination (Join-Path $ProjectRoot ".env")
    }

    Write-Step "Atualizando banco de dados..."
    & $BackendPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Falha ao aplicar as migrations Alembic." }

    if ($CheckOnly) {
        Write-Host "`nAmbiente pronto. Verificação concluída sem iniciar os servidores." -ForegroundColor Green
        exit 0
    }

    $env:NOVA_GENERATOR_TTS_PYTHON = $ttsExecutable
    Write-Step "Iniciando API, worker e interface..."
    $api = Start-ServiceProcess "api" $BackendPython @("-m", "uvicorn", "nova_generator.main:app", "--host", "127.0.0.1", "--port", "8000") $ProjectRoot
    $worker = Start-ServiceProcess "worker" $BackendPython @("-m", "nova_generator.worker") $ProjectRoot
    $frontend = Start-ServiceProcess "frontend" (Get-Command "npm.cmd").Source @("run", "dev", "--", "--host", "127.0.0.1", "--port", "5173") $FrontendRoot

    Wait-Http "http://127.0.0.1:8000/api/health" $api "API"
    Wait-Http "http://127.0.0.1:5173" $frontend "Frontend"

    Write-Host "`nNova Generator disponível em http://127.0.0.1:5173" -ForegroundColor Green
    Write-Host "API: http://127.0.0.1:8000/docs"
    Write-Host "Logs: $LogRoot"
    Write-Host "Feche esta janela ou pressione Ctrl+C para encerrar os serviços.`n"
    if (-not $SkipBrowser) {
        Start-Process "http://127.0.0.1:5173"
    }
    while ($true) {
        foreach ($process in $Processes) {
            if ($process.HasExited) {
                throw "Um dos serviços encerrou. Consulte data\logs."
            }
        }
        Start-Sleep -Seconds 2
    }
} catch {
    Write-Host "`nERRO: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    foreach ($process in $Processes) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
