@echo off
REM One-command local runner for Windows Command Prompt (pure batch, no PowerShell).
REM   Mock AI:  run-local.cmd
REM   Live AI:  set CURSOR_API_KEY=crsr_your_real_key      (then)   run-local.cmd
REM Optional:  set PORT=8000 / set CURSOR_BRIDGE_PORT=8788 / set CURSOR_MODEL=composer-2.5
cd /d "%~dp0"

REM --- find Python ---
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY (
  echo [error] Python not found. Install Python 3.10+ from https://www.python.org/downloads/ and check "Add python.exe to PATH".
  exit /b 1
)

REM --- defaults (set BEFORE the block that uses them) ---
if not defined PORT set "PORT=8000"
if not defined CURSOR_BRIDGE_PORT set "CURSOR_BRIDGE_PORT=8788"
if not defined CURSOR_MODEL set "CURSOR_MODEL=composer-2.5"

REM --- Python env ---
if not exist ".venv" (
  echo ==^> Creating virtual environment .venv
  %PY% -m venv .venv
)
echo ==^> Installing Python dependencies
".venv\Scripts\python.exe" -m pip install --quiet -r server\requirements.txt

if defined CURSOR_API_KEY (
  where node >nul 2>&1 || (
    echo [error] Node.js not found. Install Node 18+ from https://nodejs.org/ then re-run.
    exit /b 1
  )
  echo ==^> LIVE mode: installing Cursor bridge dependencies
  pushd server\cursor-bridge
  call npm install --silent
  popd
  echo ==^> Launching Cursor bridge in a separate window on port %CURSOR_BRIDGE_PORT% ...
  start "Nazir Cursor Bridge" cmd /k node server\cursor-bridge\bridge.mjs
  echo ==^> Waiting a few seconds for the bridge to start ...
  timeout /t 4 /nobreak >nul
  set "LLM_MOCK=0"
  set "LLM_BASE_URL=http://127.0.0.1:%CURSOR_BRIDGE_PORT%/v1"
  set "LLM_MODEL=%CURSOR_MODEL%"
  set "LLM_API_KEY=local"
) else (
  echo ==^> MOCK mode ^(set CURSOR_API_KEY for live AI^)
  set "LLM_MOCK=1"
)

echo.
echo ==^> Dashboard: http://localhost:%PORT%   (Press Ctrl+C here to stop the app)
echo     (In live mode, close the "Nazir Cursor Bridge" window to stop the bridge.)
echo.
".venv\Scripts\python.exe" -m uvicorn server.app:app --port %PORT%
