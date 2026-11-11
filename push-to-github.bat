@echo off
setlocal enabledelayedexpansion
title JMCL Staff Flow Pro - Push to GitHub
color 0A
cls

echo ====================================================================
echo        JMCL STAFF FLOW PRO - Push Updates to GitHub
echo ====================================================================
echo Repository: https://github.com/alihasanfz/jmcl-staff-flow-pro-plus
echo Live Cloud: https://jmcl-staff-flow-pro-plus.onrender.com
echo ====================================================================
echo.

cd /d "%~dp0"

echo [1/3] Checking Git status...
git status -s

echo.
echo [2/3] Paste your GitHub Personal Access Token below:
echo (Go to https://github.com/settings/tokens/new to copy your token)
echo.
set /p TOKEN="Enter Personal Access Token: "

if "%TOKEN%"=="" (
    color 0C
    echo.
    echo [ERROR] Token cannot be empty! Please generate and paste your token.
    echo.
    pause
    exit /b 1
)

echo.
echo [3/3] Pushing to GitHub (alihasanfz/jmcl-staff-flow-pro-plus)...
git remote set-url origin https://alihasanfz:%TOKEN%@github.com/alihasanfz/jmcl-staff-flow-pro-plus.git
git push -u origin main

if %errorlevel% equ 0 (
    color 0A
    echo.
    echo ====================================================================
    echo   SUCCESS! All changes have been pushed to GitHub!
    echo   Render Cloud is now automatically deploying the updated code:
    echo   https://jmcl-staff-flow-pro-plus.onrender.com
    echo ====================================================================
) else (
    color 0C
    echo.
    echo [ERROR] Push failed. Please check that your token has 'repo' or 'Contents: Read and write' permission.
)

echo.
pause

