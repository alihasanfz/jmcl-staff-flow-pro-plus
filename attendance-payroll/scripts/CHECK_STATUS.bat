@echo off
cd /d "%~dp0"
echo ========================================================
echo        JMCL ZKTeco Biometric Gateway - Live Status      
echo ========================================================
echo.
echo [1] Active Background Gateway Process:
powershell -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*zkteco-gateway.js*' }; if ($p) { $p | Select-Object ProcessId, CreationDate, CommandLine } else { Write-Host 'No Gateway process currently running!' -ForegroundColor Red }"
echo.
echo [2] Listening Network Ports (8080 & 3000):
powershell -Command "$c = Get-NetTCPConnection -LocalPort 8080, 3000 -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object LocalAddress, LocalPort, State } else { Write-Host 'Ports 8080/3000 are not listening!' -ForegroundColor Red }"
echo.
echo [3] Recent 15 Lines from gateway.log:
echo --------------------------------------------------------
powershell -Command "if (Test-Path gateway.log) { Get-Content gateway.log -Tail 15 } else { Write-Host 'No log file generated yet.' }"
echo --------------------------------------------------------
echo.
pause
