@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul || (echo Python nao encontrado no PATH.& pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo FFmpeg nao encontrado no PATH.& pause & exit /b 1)
where ffprobe >nul 2>nul || (echo ffprobe nao encontrado no PATH.& pause & exit /b 1)
if not exist ".venv\Scripts\python.exe" python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (pause & exit /b 1)
echo.
echo Media and Subtitle Generator Alpha 1.39 instalado.
echo Execute run.bat. O terminal mostrara a URL publica e o QR Code para o celular.
pause
