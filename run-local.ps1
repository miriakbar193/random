# One-command local runner for the Nazir Paneli dashboard (Windows PowerShell).
#
#   .\run-local.ps1                              -> dashboard with mock AI (no key)
#   $env:CURSOR_API_KEY="crsr_..."; .\run-local.ps1   -> live AI via Cursor subscription
#
# Optional: $env:PORT (default 8000), $env:CURSOR_BRIDGE_PORT (default 8788),
# $env:CURSOR_MODEL (default composer-2.5).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$port = if ($env:PORT) { $env:PORT } else { "8000" }

# Find a Python launcher: prefer the 'py' launcher, fall back to 'python'/'python3'.
$pyExe = $null; $pyArgs = @()
if     (Get-Command py      -ErrorAction SilentlyContinue) { $pyExe = "py";      $pyArgs = @("-3") }
elseif (Get-Command python  -ErrorAction SilentlyContinue) { $pyExe = "python" }
elseif (Get-Command python3 -ErrorAction SilentlyContinue) { $pyExe = "python3" }
if (-not $pyExe) {
    Write-Error "No Python found. Install Python 3.10+ from https://www.python.org/downloads/ (check 'Add to PATH')."
    exit 1
}

Write-Host "==> Setting up Python environment (.venv)"
if (-not (Test-Path .venv)) { & $pyExe @pyArgs -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --quiet -r server\requirements.txt

$bridge = $null
if ($env:CURSOR_API_KEY) {
    if (-not $env:CURSOR_BRIDGE_PORT) { $env:CURSOR_BRIDGE_PORT = "8788" }
    Write-Host "==> CURSOR_API_KEY detected -> LIVE mode (Cursor bridge on :$($env:CURSOR_BRIDGE_PORT))"
    Write-Host "==> Installing bridge dependencies (npm)"
    Push-Location server\cursor-bridge; npm install --silent; Pop-Location

    $bridge = Start-Process -PassThru -NoNewWindow node -ArgumentList "server\cursor-bridge\bridge.mjs"
    Write-Host "==> Waiting for bridge to be ready"
    Start-Sleep -Seconds 3

    $env:LLM_MOCK = "0"
    $env:LLM_BASE_URL = "http://127.0.0.1:$($env:CURSOR_BRIDGE_PORT)/v1"
    $env:LLM_MODEL = if ($env:CURSOR_MODEL) { $env:CURSOR_MODEL } else { "composer-2.5" }
    $env:LLM_API_KEY = "local"
} else {
    Write-Host "==> No CURSOR_API_KEY -> MOCK mode (canned AI replies)."
    Write-Host "    For live AI: `$env:CURSOR_API_KEY='crsr_your_key'; .\run-local.ps1"
    $env:LLM_MOCK = "1"
}

Write-Host ""
Write-Host "==> Dashboard running at: http://localhost:$port   (Ctrl+C to stop)"
try {
    & .\.venv\Scripts\python.exe -m uvicorn server.app:app --port $port
} finally {
    if ($bridge) { Stop-Process -Id $bridge.Id -ErrorAction SilentlyContinue }
}
