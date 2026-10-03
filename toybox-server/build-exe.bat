@echo off
title SABIHA ERP - Standalone EXE (not available in v13)
color 0E
echo ============================================================
echo   The single-file .exe build is NOT available in v13
echo ============================================================
echo.
echo SABIHA ERP v13 uses PostgreSQL through a background worker
echo thread, which the "pkg" single-file packager cannot run.
echo.
echo Use one of these instead ^(both are simple^):
echo   1. Run start.bat  ^(needs Node.js + PostgreSQL installed^)
echo   2. Run it as a Windows service so it starts with the PC:
echo        npm install -g pm2 pm2-windows-startup
echo        pm2 start server.js --name sabiha-erp
echo        pm2 save ^&^& pm2-startup install
echo.
echo See POSTGRESQL_SETUP_v13.md, section "Running permanently".
echo.
pause
