@echo off
setlocal
cd /d "%~dp0"
node provision-company.js %*
if errorlevel 1 pause
