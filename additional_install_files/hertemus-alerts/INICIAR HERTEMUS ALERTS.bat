@echo off
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 exit /b 1
start "HERTEMUS Alerts" /min node.exe server.js
