@echo off
cd /d "%~dp0"
echo Stopping JMCL ZKTeco Biometric Gateway...
powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*zkteco-gateway.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host 'Stopped Gateway Process PID:' $_.ProcessId }"
echo Gateway stopped.
pause
