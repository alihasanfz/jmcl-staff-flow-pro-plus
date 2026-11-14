@echo off
setlocal enabledelayedexpansion
title JMCL Staff Flow Pro - Local Server & Device Gateway
color 0A
cls

echo ====================================================================
echo          JMCL STAFF FLOW PRO - Local Server & Device Gateway
echo ====================================================================
echo Local Dashboard : http://localhost:3000
echo Cloud Server    : https://jmcl-staff-flow-pro-plus-2846.onrender.com
echo ====================================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0attendance-payroll"

if not exist "node_modules\@electric-sql\pglite" (
    echo [INFO] First time setup: Installing server dependencies...
    echo Please wait a minute while packages are installed.
    echo.
    call npm.cmd install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

echo Starting local server on port 3000...
call npm.cmd start
pause
