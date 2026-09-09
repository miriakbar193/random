#!/usr/bin/env bash
# One-command local runner for the Nazir Paneli dashboard.
#
#   ./run-local.sh                 -> dashboard with mock AI (no key needed)
#   CURSOR_API_KEY=crsr_... ./run-local.sh   -> live AI via your Cursor subscription
#
# Optional overrides: PORT (default 8000), CURSOR_BRIDGE_PORT (default 8788),
# CURSOR_MODEL (default composer-2.5).
set -euo pipefail
cd "$(dirname "$0")"

# Remember settings: always load local-config.txt if present.
# (also carries optional corporate-network settings: HTTPS_PROXY, NODE_EXTRA_CA_CERTS, NODE_OPTIONS)
if [ -f local-config.txt ]; then
  echo "==> Loading settings from local-config.txt"
  set -a; . ./local-config.txt; set +a
fi

PY="${PYTHON:-python3}"
PORT="${PORT:-8000}"

echo "==> Setting up Python environment (.venv)"
if [ ! -d .venv ]; then "$PY" -m venv .venv; fi
./.venv/bin/python -m pip install --quiet -r server/requirements.txt

if [ -n "${CURSOR_API_KEY:-}" ]; then
  BRIDGE_PORT="${CURSOR_BRIDGE_PORT:-8788}"
  echo "==> CURSOR_API_KEY detected -> LIVE mode (Cursor bridge on :$BRIDGE_PORT)"
  echo "==> Installing bridge dependencies (npm)"
  ( cd server/cursor-bridge && npm install --silent )

  CURSOR_BRIDGE_PORT="$BRIDGE_PORT" node server/cursor-bridge/bridge.mjs &
  BRIDGE_PID=$!
  trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT

  echo -n "==> Waiting for bridge to be ready"
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then echo " ok"; break; fi
    echo -n "."; sleep 0.5
  done

  export LLM_MOCK=0
  export LLM_BASE_URL="http://127.0.0.1:$BRIDGE_PORT/v1"
  export LLM_MODEL="${CURSOR_MODEL:-composer-2.5}"
  export LLM_API_KEY=local
else
  echo "==> No CURSOR_API_KEY -> MOCK mode (canned AI replies)."
  echo "    For live AI: CURSOR_API_KEY=crsr_your_key ./run-local.sh"
  export LLM_MOCK=1
fi

echo ""
echo "==> Dashboard running at: http://localhost:$PORT   (Ctrl+C to stop)"

# Open the browser automatically once the server is up.
( sleep 4
  if command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT"
  fi ) >/dev/null 2>&1 &

exec ./.venv/bin/python -m uvicorn server.app:app --port "$PORT"
