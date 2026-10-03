@echo off
title SABIHA ERP - Install
color 0B
echo ============================================================
echo   SABIHA ERP - Multi-Company First Time Setup
echo   Package by SABIHA IT SOLUTION PVT. LTD.
echo ============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was not found on this computer.
    echo.
    echo Please install Node.js first:
    echo   1. Go to https://nodejs.org
    echo   2. Download the "LTS" version for Windows
    echo   3. Run the installer, accepting all defaults
    echo   4. Restart this computer if prompted
    echo   5. Run this install.bat file again
    echo.
    pause
    exit /b 1
)

echo Node.js found. Checking version...
node -v
echo.

echo Installing SABIHA ERP dependencies - this may take a few minutes...
echo (This step needs an internet connection. It only has to run once.)
echo.
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Installation failed. Please check the messages above.
    echo If you see errors about "node-gyp" or a native module, you may
    echo need to install the free "Visual Studio Build Tools" from
    echo https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo ^(select "Desktop development with C++" during its setup^)
    echo then run install.bat again.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Installation complete!
echo.
echo   NEXT: SABIHA ERP needs PostgreSQL ^(free^).
echo     1. Install PostgreSQL from https://www.postgresql.org/download/windows/
echo     2. Open the file  .env  ^(it is created on first start^) and set
echo        PGPASSWORD to the password you chose for the "postgres" user.
echo     3. Double-click start.bat - the database is created automatically.
echo   Full guides: MULTI_TENANT_INSTALL.md and POSTGRESQL_SETUP_v13.md
echo ============================================================
echo.
pause
