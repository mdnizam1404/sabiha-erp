@echo off
title SABIHA ERP - Apply Patch
color 0D
echo ============================================================
echo   SABIHA ERP - Apply Update Patch
echo ============================================================
echo.
echo This applies a small update WITHOUT touching your data,
echo your login secret, or your installed dependencies (unless
echo the patch specifically needs a new one).
echo.

set /p PATCHFILE=Enter the patch zip filename (e.g. patch-3.1.0.zip): 

if not exist "%PATCHFILE%" (
    echo.
    echo [ERROR] Could not find "%PATCHFILE%" in this folder.
    echo Place the patch zip directly inside this toybox-server
    echo folder, next to start.bat, then try again.
    echo.
    pause
    exit /b 1
)

echo.
echo Step 1 of 3: Backing up your current app files...
echo   ^(Your data, backups, and login secret are NOT included in
echo    this backup because they are never touched by a patch.^)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ts = Get-Date -Format 'yyyyMMdd-HHmmss';" ^
  "$dest = \"patches\backup-$ts\";" ^
  "New-Item -ItemType Directory -Force -Path $dest | Out-Null;" ^
  "Get-ChildItem -Path . -Exclude 'data','backups','node_modules','patches','.env','dist' |" ^
  "  Copy-Item -Destination $dest -Recurse -Force;" ^
  "Write-Host \"  Backup saved to $dest\""

if %errorlevel% neq 0 (
    echo [ERROR] Backup step failed. Patch NOT applied. Nothing was changed.
    pause
    exit /b 1
)

echo.
echo Step 2 of 3: Applying patch files...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%PATCHFILE%' -DestinationPath '.' -Force"

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to extract the patch.
    echo Your previous files are safe in the backup folder shown above.
    echo Nothing else was changed.
    pause
    exit /b 1
)

echo.
echo Step 3 of 3: Checking dependencies ^(only downloads what changed^)...
call npm install

echo.
echo ============================================================
echo   Patch applied successfully!
echo.
echo   - Your database and settings were NOT touched.
echo   - A safety backup of your previous app files is saved in
echo     the "patches" folder, in case you ever need to roll back.
echo   - Start the app as usual with start.bat and check the
echo     version number shown in the sidebar to confirm it updated.
echo ============================================================
echo.
pause
