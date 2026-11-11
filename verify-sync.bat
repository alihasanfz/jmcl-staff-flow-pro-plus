@echo off
setlocal enabledelayedexpansion
title JMCL Staff Flow Pro - Biometric Device Connection Diagnostic
color 0E
cls

echo ====================================================================
echo         JMCL STAFF FLOW PRO - Device Connection Diagnostic
echo ====================================================================
echo.

cd /d "%~dp0"
node scripts\verify-sync.js

pause
