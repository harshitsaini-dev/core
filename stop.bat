@echo off
REM ---------------------------------------------------------------------------
REM Stop the Core development server.
REM
REM Kills only the process tree that owns the port. Killing every node.exe would
REM be simpler and would also take down whatever else you happen to be running.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -Command ^
  "$owners = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "if (-not $owners) { Write-Host '[core] nothing listening on port %PORT%'; exit 0 }" ^
  "foreach ($procId in $owners) {" ^
  "  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName;" ^
  "  Write-Host \"[core] stopping $name (pid $procId)\";" ^
  "  taskkill /PID $procId /T /F | Out-Null" ^
  "}" ^
  "Write-Host '[core] stopped'"

endlocal
