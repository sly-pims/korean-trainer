@echo off
rem Korean Daily Trainer - local PC launcher (single, minimized console).
title Korean Daily Trainer
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js not found on PATH. Install via winget install OpenJS.NodeJS.LTS && pause && exit /b 1)

if not exist "web\dist\index.html" (
  echo Building the app first...
  call npm run build
)

rem Re-seed a clean database if it was deleted (empty data\ dir = fresh start).
echo Starting server on http://localhost:8787 (minimized window)...
start "Korean-Trainer-Server" /min cmd /k "cd /d "%~dp0" && npm start"

if not "%1"=="nobrowse" (
  timeout /t 3 /nobreak >nul
  start "" http://localhost:8787
)

echo.
echo To stop the server later: close its "Korean-Trainer-Server" console, or run:
echo   taskkill /f /im node.exe
echo.
pause