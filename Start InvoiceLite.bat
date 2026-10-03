@echo off
rem InvoiceLite launcher — double-click to start the app and open your browser.
cd /d "%~dp0"

rem Already running? Just open the app.
curl -s -o nul http://localhost:4173/healthz >nul 2>&1
if %errorlevel%==0 (
  echo InvoiceLite is already running - opening it in your browser.
  start "" http://localhost:4173
  timeout /t 2 /nobreak >nul
  exit /b 0
)

rem Start the server minimized, wait for it to boot, then open the browser.
set PORT=4173
start "InvoiceLite" /min node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:4173
echo.
echo InvoiceLite is running at http://localhost:4173
echo It lives in the minimized window titled "InvoiceLite" -
echo close that window (or run this file again and it will just open the app).
timeout /t 4 /nobreak >nul
