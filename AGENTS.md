# AGENTS.md

## Cursor Cloud specific instructions

### Services

- **Nazir Paneli dashboard** — FastAPI app (`server/app.py`) that serves the single-page frontend (`web/index.html`) and a chat endpoint (`POST /api/chat`). Python deps: `server/requirements.txt` (installed into `/workspace/.venv`).
  - Run (dev): `LLM_MOCK=1 /workspace/.venv/bin/python -m uvicorn server.app:app --reload --port 8000`
  - Health: `GET /api/health` → `{"ok":true,"mock":<bool>}`. `mock:true` means canned replies; `mock:false` means it is calling a real LLM endpoint.
  - The frontend is one monolithic file (`web/index.html`) containing HTML, CSS, JS and all mock data. Trilingual (AZ default, EN, RU) via `tx()`/`T()`.
  - Shared, testable executive logic lives in `web/lib/exec.js` (attached to `window.Exec`, also `require`-able in Node). It holds the decision age/overdue/due-window math, meeting-overlap detection, and priority/risk/readiness normalization. Prefer adding pure calculations here (not inline in `index.html`) so they stay unit-testable.

### Demo-mode conventions (P0 containment)

- The panel runs on a fixed demonstration snapshot: `FEED.meta.dataMode === 'demo'`. Freshness is three separate facts — `observedAt` (snapshot assembled), `lastFetchAt` (last successful retrieval), `asOf` (the instant to reason from). There is **no** scheduled refresh; do not reintroduce a "next sync"/auto-refresh promise.
- Age/overdue/due-window figures are measured against `decAsOf()` (= `FEED.meta.asOf` in demo mode, real Baku clock in live mode) via `Exec` — never a hard-coded date. `Exec` interprets naive timestamps as Asia/Baku and date-only deadlines as end-of-day Baku, so host timezone does not change results.
- Missing risk/readiness renders as **Not assessed** (`naLabel`), never a fabricated Medium. Meeting attendance priority (`prioLevel`) comes from importance/urgency (+ explicit `crit` override) only; a critical linked task is shown as a separate **delivery criticality** dimension.
- Unreconciled scenario outputs (net fiscal effect, fiscal payback, drought import/self-sufficiency) are withheld behind `mrRow()` → "Methodology review required"; only defensible quantities show numbers.
- Document review accepts text formats only and rejects binaries (`drSupported`); a capped review names the exact reviewed range and always shows a "not a full review" note. AI capability is probed at boot (`checkCapabilities()` → `/api/health`); when the backend is down the chat is disabled with a specific retryable banner.

### Tests / verification

- Pure-logic regression tests (no browser): `node --test tests/exec.test.mjs` (covers the handoff's required test matrix — decision age/overdue, meeting overlap, unknown assessments).
- Headless-Chrome smoke check + screenshots: needs Playwright (`/workspace/.venv/bin/pip install playwright`; the browser is the pre-installed system Chrome, no `playwright install` needed). Start the app in mock mode, then `/workspace/.venv/bin/python tests/verify_ui.py` (uses system Chrome via `channel="chrome"`, `--no-sandbox`; writes to `/workspace/artifacts/`, ignored by git). It walks the key pages, exercises the demo actions and a simulated backend-down state, and fails on any non-environmental console/page error. External CDN (Leaflet/Chart.js/tiles) and favicon failures are expected under restricted egress and are ignored.

### LLM configuration (`server/llm.py`)

The chat client is a standard **OpenAI-compatible** caller. It reads env vars:
`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (optional `LLM_API_VERSION`). With those set and
`LLM_MOCK=0`, it does `POST {LLM_BASE_URL}/chat/completions`. `LLM_MOCK=1` forces canned
replies and requires no endpoint. Any OpenAI-compatible endpoint works (OpenAI, Azure,
OpenRouter, a local Ollama at `http://localhost:11434/v1`, etc.).

### Cursor-subscription bridge (`server/cursor-bridge/`) — optional live AI

`server/cursor-bridge/bridge.mjs` is a small Node server that exposes an OpenAI-compatible
`POST /v1/chat/completions` backed by the **Cursor Agent SDK** (`@cursor/sdk`). It lets the
dashboard run live on a Cursor subscription API key with no change to the Python app or the
frontend. Deps install with `npm install` inside `server/cursor-bridge/`.

Run it (needs `CURSOR_API_KEY` in env, a `crsr_...` Cursor key):

```
# terminal 1 — bridge
cd server/cursor-bridge && CURSOR_BRIDGE_PORT=8788 node bridge.mjs
# terminal 2 — app pointed at the bridge
LLM_MOCK=0 LLM_BASE_URL=http://127.0.0.1:8788/v1 LLM_MODEL=composer-2.5 LLM_API_KEY=local \
  /workspace/.venv/bin/python -m uvicorn server.app:app --port 8000
```

**IMPORTANT egress caveat (why it may not answer in Cloud):** the Cursor Agent SDK routes
through `api.cursor.com` for model validation/routing. That host is **NOT** in the default
Cloud Agent egress allowlist (only `api2.cursor.sh` is). With just `api2.cursor.sh` the SDK
authenticates fine but fails at `GET /v1/models` (404 on that host). To use the bridge in a
Cloud Agent VM, **`api.cursor.com` must be added to Network Access**. On a normal machine
(no egress lock) it works out of the box. Each request creates a fresh Cursor **agent** run
(not a plain chat model), so it consumes the key owner's Cursor usage and is higher-latency.
The `crsr_` key is a Cursor API key, not an LLM provider key — there is no OpenAI-compatible
Cursor chat endpoint; the SDK bridge is the only way to use it here.
