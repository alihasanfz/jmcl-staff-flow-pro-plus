@echo off
title JMCL Staff Flow Pro - ZKTeco Device Gateway & Server
cls
echo ====================================================
echo JMCL STAFF FLOW PRO - Device Gateway & Server
echo ====================================================
echo Port: 3000
echo Cloud Relay: https://jmcl-staff-flow-pro-plus.onrender.com
echo ====================================================
echo.
cd /d "%~dp0attendance-payroll"
npm start
pause

