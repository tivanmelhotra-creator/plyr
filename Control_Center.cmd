@echo off
setlocal
 title PLYR Runtime Manager
 color 0B

:MENU
cls
echo ===================================================
echo              PLYR RUNTIME MANAGER
echo ===================================================
echo.
echo  [1] Start development mode
 echo  [2] Start built/native mode
 echo  [3] Stop active managed runtime
 echo  [4] Restart active managed runtime
 echo  [5] Status
 echo  [6] Doctor
 echo  [7] Exit
 echo.
set /p choice="Select an option (1-7): "

if "%choice%"=="1" goto DEV
if "%choice%"=="2" goto BUILD
if "%choice%"=="3" goto STOP
if "%choice%"=="4" goto RESTART
if "%choice%"=="5" goto STATUS
if "%choice%"=="6" goto DOCTOR
if "%choice%"=="7" exit /b 0
goto MENU

:CHECK_BASH
where bash >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  echo.
  echo ERROR: Bash is required for the canonical ./plyr manager.
  echo Install Git for Windows or use WSL, then run this launcher again.
  pause
  exit /b 1
)
exit /b 0

:DEV
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" start --dev
pause
goto MENU

:BUILD
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" start --build
pause
goto MENU

:STOP
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" stop
pause
goto MENU

:RESTART
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" restart
pause
goto MENU

:STATUS
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" status
pause
goto MENU

:DOCTOR
call :CHECK_BASH
if errorlevel 1 exit /b 1
call bash "%~dp0plyr" doctor --deep
pause
goto MENU
