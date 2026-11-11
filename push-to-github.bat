@echo off
setlocal enabledelayedexpansion
title JMCL Staff Flow Pro - Push to GitHub
color 0B
cls

echo ====================================================================
echo        JMCL STAFF FLOW PRO - Push Updates to GitHub
echo ====================================================================
echo  Target Repo : https://github.com/alihasanfz/jmcl-staff-flow-pro-plus
echo  Live Cloud  : https://jmcl-staff-flow-pro-plus.onrender.com
echo ====================================================================
echo.

cd /d "%~dp0"

echo [1] Browser Sign-in (Auto Login - No Token Needed)
echo [2] Paste Personal Access Token (PAT)
echo.
set /p CHOICE="Choose an option (1 or 2): "

if "%CHOICE%"=="2" (
    echo.
    set /p TOKEN="Paste your Personal Access Token: "
    if "!TOKEN!"=="" (
        echo [ERROR] Token cannot be empty!
        pause
        exit /b 1
    )
    git remote set-url origin https://alihasanfz:!TOKEN!@github.com/alihasanfz/jmcl-staff-flow-pro-plus.git
    echo.
    echo Pushing with Token...
    git push -u origin main
) else (
    echo.
    echo Opening GitHub Sign-in...
    git remote set-url origin https://github.com/alihasanfz/jmcl-staff-flow-pro-plus.git
    git push -u origin main
)

if %errorlevel% equ 0 (
    color 0A
    echo.
    echo ====================================================================
    echo   SUCCESS! All updates have been pushed to GitHub!
    echo   Render Cloud is now automatically deploying the live website:
    echo   https://jmcl-staff-flow-pro-plus.onrender.com
    echo ====================================================================
) else (
    color 0C
    echo.
    echo [Notice] If the browser window did not open or failed, run this file again and choose Option 2 to paste your token.
)

echo.
pause
