@echo off
REM ---------------------------------------------------------------------------
REM Start the Core development server.
REM
REM Safe to run twice: if something is already listening on the port it reports
REM that and leaves it alone rather than starting a second one.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -Command "exit ([bool](Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue))"
if errorlevel 1 (
  echo [core] already running on http://localhost:%PORT%
  echo [core] use restart.bat to reload it, or stop.bat to shut it down
  exit /b 0
)

if not exist ".dev.vars" (
  echo [core] .dev.vars is missing.
  echo [core] copy .dev.vars.example to .dev.vars and set AUTH_PEPPER, or the
  echo [core] auth routes will fail at runtime.
  exit /b 1
)

echo [core] starting dev server on port %PORT% ...
start "core dev server" /min cmd /c "pnpm dev"

REM Poll rather than sleeping a fixed amount: a cold start and a warm one differ
REM by several seconds, and guessing wrong either wastes time or reports failure
REM on a server that was about to come up.
set /a TRIES=0
:wait
set /a TRIES+=1
if %TRIES% gtr 60 (
  echo [core] did not come up within 60s. Check the "core dev server" window.
  exit /b 1
)
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1000; try { $null = Invoke-WebRequest -Uri 'http://localhost:%PORT%/' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }"
if errorlevel 1 goto wait

echo [core] ready at http://localhost:%PORT%
endlocal
