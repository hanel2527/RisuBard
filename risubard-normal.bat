@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node "scripts\start-menu-launcher.mjs" normal %*
set "LAUNCHER_EXIT_CODE=%ERRORLEVEL%"
if not "%LAUNCHER_EXIT_CODE%"=="0" pause
endlocal & exit /b %LAUNCHER_EXIT_CODE%
