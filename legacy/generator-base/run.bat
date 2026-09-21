@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [Alpha 1.39] Ambiente virtual nao encontrado. Execute install.bat primeiro.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" run_launcher.py
if errorlevel 1 pause
