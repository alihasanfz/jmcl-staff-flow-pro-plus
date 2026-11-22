@echo off
cd /d "%~dp0"
echo ========================================================
echo   Starting JMCL ZKTeco Biometric Gateway (Background)   
echo ========================================================
echo.
cscript //nologo start-gateway-silent.vbs
echo Gateway process started silently in background!
echo It will now run 24/7 even if Antigravity IDE is closed.
echo.
timeout /t 2 >nul
exit
