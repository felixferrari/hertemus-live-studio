@echo off
cd /d "%~dp0"
where node.exe >nul 2>&1
if not errorlevel 1 (
  start "HERTEMUS Alerts" /min node.exe server.js
  exit /b 0
)
if exist "%~dp0node.exe" (
  start "HERTEMUS Alerts" /min "%~dp0node.exe" server.js
  exit /b 0
)
exit /b 1
