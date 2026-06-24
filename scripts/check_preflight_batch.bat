@echo off
REM Double-click to self-check the newest preflight FLAGGED/PASS pair in Downloads.
REM Looks for python on PATH, then the common Windows install location.
setlocal
set SCRIPT=%~dp0check_preflight_batch.py

where python >nul 2>nul
if %errorlevel%==0 (
    python "%SCRIPT%" %*
    goto end
)
if exist "C:\Python314\python.exe" (
    "C:\Python314\python.exe" "%SCRIPT%" %*
    goto end
)
echo Could not find Python. Install it, or run:  python "%SCRIPT%"

:end
echo.
pause
