@echo off
title Sign in to Claude
echo.
echo   ============================================
echo     Sign in to Claude
echo   ============================================
echo.
echo   A browser will open for you to sign in.
echo   If it doesn't, this window shows a link - press "c" to copy it,
echo   then paste it into your browser.
echo.
echo   After you approve, copy the code Claude gives you, paste it
echo   here, and press Enter.
echo.
rem Use the claude.cmd shim (not claude.ps1) so PowerShell's execution policy can't block it.
set "CLAUDEBIN=claude"
where claude >nul 2>nul || set "CLAUDEBIN=%APPDATA%\npm\claude.cmd"
call "%CLAUDEBIN%" setup-token
echo.
echo   ============================================
echo     All done - you can close this window.
echo     Your assistant is finishing setup.
echo   ============================================
echo.
pause
