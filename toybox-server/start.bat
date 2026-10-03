@echo off
title SABIHA ERP Server
color 0A
echo ============================================================
echo   Starting SABIHA ERP...
echo   Package by SABIHA IT SOLUTION PVT. LTD.
echo ============================================================
echo.

if not exist "node_modules" (
    echo It looks like this is the first time running SABIHA ERP.
    echo Please run install.bat first, then try start.bat again.
    echo.
    pause
    exit /b 1
)

echo Do not close this window while you are using SABIHA ERP.
echo Opening your browser in a few seconds...
echo.

start "" cmd /c "timeout /t 3 >nul && start http://localhost:3000"

call npm start

echo.
echo Server stopped.
pause
