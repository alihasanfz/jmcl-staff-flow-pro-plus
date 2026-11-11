@echo off
setlocal enabledelayedexpansion
title JMCL Staff Flow Pro - ZKTeco Cloud Sync Gateway
color 0B
cls

echo ====================================================================
echo          JMCL STAFF FLOW PRO - ZKTeco Cloud Sync Gateway
echo ====================================================================
echo   Relaying local biometric punches to Render Cloud Server:
echo   https://jmcl-staff-flow-pro-plus.onrender.com
echo ====================================================================
echo.

:: Detect Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: Configuration
if "%SERVER_URL%"=="" set SERVER_URL=https://jmcl-staff-flow-pro-plus.onrender.com
if "%PROXY_PORT%"=="" set PROXY_PORT=8080

:: Change directory to script directory
cd /d "%~dp0"

if exist scripts\zkteco-gateway.js (
    node scripts\zkteco-gateway.js --proxy-port %PROXY_PORT% --server-url %SERVER_URL%
) else if exist attendance-payroll\scripts\zkteco-gateway.js (
    node attendance-payroll\scripts\zkteco-gateway.js --proxy-port %PROXY_PORT% --server-url %SERVER_URL%
) else (
    color 0C
    echo [ERROR] Could not find zkteco-gateway.js!
    echo.
    pause
)

pause
