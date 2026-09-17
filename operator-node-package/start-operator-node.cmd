@echo off
REM Run this on the machine you want Operator to drive.
REM Right-click -> "Run as administrator" so it can accept connections
REM from your other computer rather than only from itself.
title Operator node
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-node.ps1" %*
echo.
echo The node has stopped. Press any key to close.
pause >nul
