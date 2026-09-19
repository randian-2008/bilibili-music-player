@echo off
setlocal EnableExtensions

set "INSTALL_ROOT=%~dp0"
if "%INSTALL_ROOT:~-1%"=="\" set "INSTALL_ROOT=%INSTALL_ROOT:~0,-1%"
set "TEMP_UPDATER=%TEMP%\bpl-updater-%RANDOM%-%RANDOM%"

if not exist "%INSTALL_ROOT%\manifest.json" (
    echo This file must be placed in the extension directory containing manifest.json.
    pause
    exit /b 1
)
if not exist "%INSTALL_ROOT%\scripts\update.ps1" (
    echo The updater script is missing. Please download a complete release package.
    pause
    exit /b 1
)

mkdir "%TEMP_UPDATER%" >nul 2>&1
if not exist "%TEMP_UPDATER%" (
    echo Unable to create a temporary updater directory.
    pause
    exit /b 1
)

copy /y "%INSTALL_ROOT%\scripts\update.ps1" "%TEMP_UPDATER%\update.ps1" >nul
if errorlevel 1 (
    echo Unable to prepare the updater.
    rmdir /s /q "%TEMP_UPDATER%" >nul 2>&1
    pause
    exit /b 1
)

rem Leave the extension directory before the updater replaces it.
pushd "%TEMP_UPDATER%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TEMP_UPDATER%\update.ps1" -InstallRoot "%INSTALL_ROOT%"
set "UPDATE_EXIT=%ERRORLEVEL%"
popd

rmdir /s /q "%TEMP_UPDATER%" >nul 2>&1

if not "%UPDATE_EXIT%"=="0" (
    echo.
    echo Update failed. Check the error above for the installation and backup status.
)
pause
exit /b %UPDATE_EXIT%
