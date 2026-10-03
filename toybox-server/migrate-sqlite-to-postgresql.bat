@echo off
setlocal
cd /d "%~dp0"
title SABIHA ERP - Import old SQLite data into PostgreSQL
color 0E
echo ============================================================
echo   SABIHA ERP - IMPORT OLD SQLITE DATA INTO POSTGRESQL
echo ============================================================
echo.
echo This copies the data from your OLD version (data\erp.sqlite)
echo into the PostgreSQL database configured in the .env file.
echo Your SQLite file is only READ - it is never changed or deleted.
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  pause
  exit /b 3
)
if not exist "data\erp.sqlite" (
  echo ERROR: data\erp.sqlite was not found.
  echo Copy your old database file into the "data" folder, then run this again.
  echo ^(Or run:  node migrate-sqlite-to-postgresql.js --sqlite "C:\path\to\erp.sqlite"^)
  pause
  exit /b 2
)
if not exist "node_modules\better-sqlite3" (
  echo Installing the one-time migration helper ^(better-sqlite3^)...
  call npm install better-sqlite3 --no-save
)
node migrate-sqlite-to-postgresql.js
echo.
pause
