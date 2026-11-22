@echo off
rem Double-click to start the Dokkan team builder and open it in your browser.
cd /d "%~dp0"
start "" http://localhost:5177
node server.js
