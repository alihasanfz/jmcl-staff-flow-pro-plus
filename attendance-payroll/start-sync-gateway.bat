@echo off
title JMCL Staff Flow Pro - ZKTeco Cloud Sync Gateway
cls
echo ====================================================
echo JMCL STAFF FLOW PRO - ZKTeco Cloud Sync Gateway
echo ====================================================
echo Relaying ZKTeco Biometric Punches to Live Render Cloud:
echo https://jmcl-staff-flow-pro-plus.onrender.com
echo ====================================================
echo.
if "%SERVER_URL%"=="" set SERVER_URL=https://jmcl-staff-flow-pro-plus.onrender.com
if "%PROXY_PORT%"=="" set PROXY_PORT=8080
if exist scripts\zkteco-gateway.js (
    node scripts\zkteco-gateway.js --proxy-port %PROXY_PORT% --server-url %SERVER_URL%
) else if exist attendance-payroll\scripts\zkteco-gateway.js (
    node attendance-payroll\scripts\zkteco-gateway.js --proxy-port %PROXY_PORT% --server-url %SERVER_URL%
)
pause

