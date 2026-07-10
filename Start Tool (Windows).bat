@echo off
REM Double-click this file to start Accio.
REM First run takes a minute or two (it downloads what it needs); after that it's fast.
cd /d "%~dp0"

echo ==============================================
echo   Accio
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed yet - it's free, from the official site.
  echo Opening the download page. Install the big green "LTS" version,
  echo then double-click this file again.
  start https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [1/4] Getting the app's parts (only slow the first time)...
call npm install --no-audit --no-fund
if errorlevel 1 ( echo Something went wrong. & pause & exit /b 1 )

echo [2/4] Loading sample data (skipped if already loaded)...
call npm run seed

if not exist "client\dist\index.html" (
  echo [3/4] Preparing the app - first time only...
  call npm run build
  if errorlevel 1 ( echo Something went wrong. & pause & exit /b 1 )
) else (
  echo [3/4] App already prepared - skipping.
)

echo [4/4] Starting... your browser will open in a few seconds.
echo.
echo   The tool runs at:  http://localhost:3001
echo   To STOP it, just close this window.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3001"
call npm start
