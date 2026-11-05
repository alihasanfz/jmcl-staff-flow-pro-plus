@echo off
title JMCL Staff Flow Pro - ZKTeco Local Sync Gateway
cls
echo ====================================================
echo JMCL STAFF FLOW PRO - ZKTeco Local Sync Gateway
echo ====================================================
echo Connecting local ZKTeco uFace 800 (192.168.0.201:4370)
echo to Server: %SERVER_URL%
echo ====================================================
echo.
if "%SERVER_URL%"=="" set SERVER_URL=http://localhost:3000
node scripts/zkteco-gateway.js --device-ip 192.168.0.201 --device-port 4370 --server-url %SERVER_URL%
pause

