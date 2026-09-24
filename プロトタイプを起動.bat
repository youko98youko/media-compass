@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo メディアコンパス極 プロトタイプを起動しています…
echo 起動したら、このウィンドウは閉じずに、ブラウザで http://localhost:3000 を開いてください。
echo このウィンドウを閉じると、プロトタイプも終了します。
echo.
"C:\Program Files\nodejs\node.exe" server.js
pause
