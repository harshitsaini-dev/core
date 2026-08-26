@echo off
REM ---------------------------------------------------------------------------
REM Restart the Core development server.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"

call "%~dp0stop.bat" %PORT%

REM Give the OS a moment to release the socket. Without this the restart can
REM race the old process and bind-fail on a port that is still in TIME_WAIT.
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500"

call "%~dp0start.bat" %PORT%
endlocal
