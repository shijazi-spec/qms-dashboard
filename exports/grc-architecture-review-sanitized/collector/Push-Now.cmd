@echo off
REM ---------------------------------------------------------------------------
REM  ExampleOrg Documentation Live Tracker - manual push.
REM
REM  Double-click this before a meeting when you want certainty that the tracker
REM  reflects the library right now, rather than waiting for the watcher or the
REM  06:00 reconcile. Same code path as every other mode.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ExampleOrgDocCollector.ps1" -Mode Manual

echo.
if errorlevel 1 (
    echo Push FAILED - see the messages above.
    echo The snapshot has been queued and will be retried automatically.
) else (
    echo Push complete.
)
echo.
pause
