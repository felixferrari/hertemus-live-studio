@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0bin\64bit\obs64.exe" (
  echo HERTEMUS Live Studio nao foi encontrado nesta pasta.
  pause
  exit /b 1
)
start "HERTEMUS Live Studio" "%~dp0bin\64bit\obs64.exe" --portable
endlocal
