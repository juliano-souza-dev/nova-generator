@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Nova Generator - Inicializador

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
set "NOVA_EXIT_CODE=%ERRORLEVEL%"

if not "%NOVA_EXIT_CODE%"=="0" (
  echo.
  echo O Nova Generator nao iniciou. Leia a mensagem acima e os logs em data\logs.
  pause
)

exit /b %NOVA_EXIT_CODE%
