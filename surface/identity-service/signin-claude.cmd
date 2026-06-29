@echo off
title Sign in to Claude
echo.
echo   Opening your browser to sign in to Claude...
echo   Just click Approve - this finishes on its own.
echo.
rem `auth login` uses the loopback flow: it opens the browser and auto-completes on
rem approve (no code to copy). claude.cmd shim dodges the PowerShell execution policy.
set "CLAUDEBIN=claude"
where claude >nul 2>nul || set "CLAUDEBIN=%APPDATA%\npm\claude.cmd"
call "%CLAUDEBIN%" auth login --claudeai
if errorlevel 1 (
  echo.
  echo   Sign-in didn't complete. You can close this window and try again.
  echo.
  pause
)
