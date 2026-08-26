@echo off
REM ---------------------------------------------------------------------------
REM Report on the Core development server.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=3000"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -Command ^
  "$owners = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "if (-not $owners) { Write-Host '[core] stopped  - nothing listening on port %PORT%'; exit 0 }" ^
  "foreach ($procId in $owners) {" ^
  "  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue;" ^
  "  $up = if ($p) { [int]((Get-Date) - $p.StartTime).TotalSeconds } else { 0 };" ^
  "  Write-Host \"[core] running  - $($p.ProcessName) pid $procId, up ${up}s\"" ^
  "}" ^
  "try {" ^
  "  $r = Invoke-WebRequest -Uri 'http://localhost:%PORT%/' -UseBasicParsing -TimeoutSec 3;" ^
  "  Write-Host \"[core] app       - HTTP $($r.StatusCode) at http://localhost:%PORT%\"" ^
  "} catch { Write-Host '[core] app       - port is open but the app did not respond' }" ^
  "try {" ^
  "  $body = '{\"email\":\"status-probe@core.test\"}';" ^
  "  $a = Invoke-WebRequest -Uri 'http://localhost:%PORT%/api/auth/prelogin' -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 5;" ^
  "  Write-Host \"[core] api       - HTTP $($a.StatusCode) from /api/auth/prelogin (database reachable)\"" ^
  "} catch { Write-Host '[core] api       - /api/auth/prelogin failed; check .dev.vars and run db:migrate:local' }"

if not exist ".dev.vars" echo [core] warning   - .dev.vars is missing
endlocal
