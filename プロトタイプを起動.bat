@echo off
cd /d "%~dp0"
echo.
echo Media Compass prototype is starting...
echo After it starts, open http://localhost:3000 in your browser.
echo Do NOT close this window. Closing it stops the prototype.
echo If you see "address already in use", it is already running. Just open the browser.
echo.
"C:\Program Files\nodejs\node.exe" server.js
pause
