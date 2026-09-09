@echo off
REM One-command local runner for Command Prompt (cmd.exe).
REM   Mock AI:  run-local.cmd
REM   Live AI:  set CURSOR_API_KEY=crsr_your_real_key   (then)   run-local.cmd
REM Runs the PowerShell runner with the execution policy bypassed for this call only.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" %*
