# Nazir Paneli — KTN Minister Executive Dashboard

Executive landing page for the Minister of Agriculture, Azerbaijan (Kənd Təsərrüfatı Nazirliyi).
Trilingual AZ / EN / RU. KTN green branding taken from the client template.

This repo is the **working source of truth**. The frozen workshop demo stays at
`06. Final deliverables/Minister Executive Dashboard/` and is not maintained here.

## Layout

```
web/                 the dashboard
  index.html         single-page app, all pages and data inline
  assets/
    ktn-logo.svg     ministry logo
    dash/*.jpg       use-case screenshots (client eAgro operator interface)
server/              chat backend (FastAPI)
  app.py             serves web/ and exposes POST /api/chat
  llm.py             provider-agnostic OpenAI-compatible client
  requirements.txt
deploy/              Dockerfile, Helm values and the Platform McKinsey runbook
```

## Data classification

**Client-confidential.** The screenshots under `web/assets/dash/` are captures of the
client's live eAgro operator interface. Repo belongs in **McK-Private** with named-user
access. Do not make this repo internal or public.

The statistics embedded in `web/index.html` are from published sources (stat.gov.az,
president.az, AZERTAC) and are individually cited in the UI. The use-case figures behind
the Use cases tabs are **mock data** built for demonstration, labelled as such in the UI.

## Running locally

The dashboard renders standalone — open `web/index.html` in a browser. The chat tab needs
the backend, and will say so clearly if you open the file directly.

To run with chat, from the repo root. These are the exact commands known to work on this
machine (Windows, PowerShell, Python 3.12):

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r server/requirements.txt
$env:LLM_MOCK="1"; .\.venv\Scripts\python.exe -m uvicorn server.app:app --host 127.0.0.1 --port 8000
```

Then open http://127.0.0.1:8000. `--reload` also works for editing.

To check it is up:

```powershell
Invoke-WebRequest http://127.0.0.1:8000/api/health -UseBasicParsing | Select-Object -Expand Content
# {"ok":true,"mock":true}
```

## Environment contract

The backend is deliberately provider-agnostic. It issues a standard
`POST {LLM_BASE_URL}/chat/completions` request, which Azure OpenAI and the common
McKinsey gateway variants all accept. Pointing it at whichever endpoint is approved for
the engagement is a configuration change, not a code change.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `LLM_BASE_URL` | yes, unless `LLM_MOCK=1` | — | Gateway base URL, e.g. `https://<host>/v1`. `/chat/completions` is appended |
| `LLM_MODEL` | yes, unless `LLM_MOCK=1` | — | Model or Azure deployment name |
| `LLM_API_KEY` | yes, unless `LLM_MOCK=1` | — | Sent as both `Authorization: Bearer` and `api-key` so Azure OpenAI works too |
| `LLM_API_VERSION` | no | unset | Sent as `?api-version=`; some Azure OpenAI deployments require it |
| `LLM_MOCK` | no | `0` | `1` returns canned replies and makes no external call |

All three of `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` must be set together. With any
of them missing and `LLM_MOCK` off, the dashboard still serves normally and `POST
/api/chat` answers `503 {"error":"chat is not configured"}`. The response says nothing
about which variable is missing; that detail goes to the server log only.

`LLM_API_KEY` is the only secret. In the deployed app it comes from the Vault instance
provisioned with the workspace — **never commit it, and never put it in
`deploy/values.yaml`**. The key is used server-side only: it is scrubbed from anything
logged, upstream exceptions are never chained into a traceback (their request objects
carry the auth headers), and no upstream error text is passed through to the browser.

> **Note on `.env` files.** A security guard on this machine blocks writing `.env*`, so
> there is no `.env.example` to copy. Set the variables in your shell as shown above, or
> in the pod environment when deployed. `.gitignore` already excludes `.env*` in case one
> is created elsewhere.

> **Open item.** No approved LLM gateway is documented for this engagement yet, and the
> June–July meeting notes record a data-sharing constraint pending sign-off. `LLM_MOCK=1`
> exists so the full chat experience can be built and demoed before that is resolved.
> The chatbot is grounded only in the mock use-case data, not in real EKTIS records.
> Do not point `LLM_BASE_URL` at an unapproved endpoint: the panel's data is sent
> upstream with every turn.

## API behaviour and limits

`POST /api/chat` takes `{lang, messages, context}`. The browser sends the panel's own
data as `context` on every turn, which is what keeps answers inside what the dashboard
shows. Nothing is persisted server-side.

| Condition | Response |
|---|---|
| `lang` outside `az` / `en` / `ru` | `422 {"error":"invalid request"}` |
| No usable message in `messages` | `400 {"error":"no message"}` |
| Body over 512 KiB, a message over 8 000 chars, or `context` over 256 KiB | `413` |
| More than 12 chat requests a minute from one caller | `429`, with `Retry-After` |
| No endpoint configured | `503 {"error":"chat is not configured"}` |
| Endpoint configured but unreachable, erroring, or returning no completion | `502 {"error":"upstream request failed"}` |

The panel's grounding payload is about 20 KB today, so the size caps leave it ample room.
Only the last 12 turns are forwarded. The rate limit is enforced in process memory, so it
is per pod and resets on restart — it is cost protection behind an authenticated front
door, not a defence against a determined caller.

## Container

```
docker build -f deploy/Dockerfile -t nazir-paneli:local .
docker run --rm -p 8000:8000 -e LLM_MOCK=1 nazir-paneli:local
```

Runs as uid 10001, application files root-owned so the runtime user cannot rewrite its own
code, Python base image pinned by digest, no secrets baked in, and a `HEALTHCHECK` on
`/api/health`. Build context is the repo root; `deploy/Dockerfile.dockerignore` keeps
`.venv/` and `.git/` out of it.

## Deploying

Target is Platform McKinsey Deployer K8s PaaS, giving a `*.apps.mckinsey.com` URL behind
McKinsey ID sign-in — which is what makes the dashboard viewable on a phone.

**The runbook is `deploy/DEPLOY.md`.** It is specific to this app and lists every value a
human has to fill in from Platform McKinsey at provisioning time. `deploy/values.yaml`
holds the Helm input, with readiness and liveness probes on `/api/health`.
`.github/workflows/build-image.yml` is the JFrog build path and is deliberately
incomplete: the approved Wiz scan step and the registry credentials only exist once the
service is provisioned.

## Serving it without a backend (GitHub Pages and similar)

`web/` is entirely self-contained, so a static host serves the dashboard properly. This
is worth knowing because a static URL is the fastest way to get the panel onto a phone.

**Works, in full:** every page and tab, all KPIs, the use-case charts and tables, the
language switch, the logo and screenshots, source links, and the schematic map fallback.
There is no build step and no server-side rendering, so nothing is lost.

**Does not work:** the chat tab, and only the chat tab. The page posts to the relative
path `api/chat`; on a static host that returns the host's own 404, the request fails, and
the UI shows its error bubble. The dashboard stays usable — the chat simply cannot answer.

Two things to be deliberate about:

1. **Site visibility.** The screenshots under `web/assets/dash/` are client-confidential.
   A GitHub Pages site published from a private repo is only restricted if private Pages
   is in force for the org; otherwise the site is public and those captures are on the
   open internet. Confirm the Pages visibility before sharing the URL with anyone,
   including the client team.
2. **Third-party CDNs.** `index.html` loads Leaflet and Chart.js from `unpkg.com` and
   `cdnjs.cloudflare.com`. That is fine on an internet-facing host, but it means the
   charts do not render at all on a device or network that blocks those domains.

### Frontend changes this mode would want

These are in `web/index.html`, which this backend work does not touch. Listed here so
they are not lost:

- **Make the chat's unavailable state proactive and accurate.** Today the user types a
  question, waits, and then gets a generic failure. Better: probe `api/health` on load
  and, if it does not answer, show a standing notice on the AI tab and disable the
  composer. The current message ("if you opened this file directly in a browser, run the
  local server instead") also reads oddly on a hosted URL.
- **Distinguish 404 from 503.** No backend at all and a backend whose chat is not yet
  configured are different situations for the reader; both currently land on the same
  text. A 503 deserves wording closer to "the assistant is not switched on yet".
- **Consider vendoring Leaflet and Chart.js into `web/assets/`.** Removes the CDN
  dependency for both static hosting and a locked-down cluster.
- **Strip the embedded SharePoint metadata.** `index.html` carries an `mso:` XML block
  near the top with a `mckinsey.sharepoint.com` DocId URL, picked up from OneDrive. It is
  harmless locally but should not be published on a page that might be public.

Help: Platform McKinsey **Get Help**, or Slack **#dna-deployer-spoc**.
