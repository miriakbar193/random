# Deploying Nazir Paneli on Platform McKinsey

Target: a `*.apps.mckinsey.com` URL behind McKinsey ID sign-in, served by the
**Deployer K8s PaaS** service. That sign-in is what makes the dashboard safe to
open on a phone, which is the whole reason for deploying rather than emailing a
file.

Everything below is specific to this app. The generic guidance lives in the
Deployer service guide, linked at the bottom.

## What is being deployed

One container, one process: `uvicorn` serving

- the dashboard as static files from `web/` (a single self-contained
  `index.html` plus the logo and use-case screenshots), and
- `POST /api/chat`, which forwards the browser's question plus the panel's own
  data to whichever LLM endpoint the environment points at, and
- `GET /api/health`, which the readiness and liveness probes use.

**The app persists nothing.** No database, no S3 bucket, no session store, no
uploads. Chat history lives in the browser tab and is gone on reload. If a
provisioning form asks about storage, this app needs none.

**The only secret is `LLM_API_KEY`**, and it comes from Vault at runtime.
Nothing else is confidential at the configuration layer.

## Before you start

| Item | Value |
|---|---|
| Data classification | **Client-confidential** |
| GitHub org | **McK-Private**, named-user access |
| Charge code | TODO(engagement): the KTN engagement charge code |
| Why confidential | `web/assets/dash/*.jpg` are captures of the client's live eAgro operator interface |

Do not make the repo internal or public, and do not move the screenshots into
any repo that is.

## Step 1 — Project Workspace

In [Platform McKinsey](https://platform.mckinsey.com), create a **Project
Workspace**, attach the engagement charge code, and set the data classification
to client-confidential. That choice is what fixes the GitHub org to McK-Private
with named-user access; it is not a separate setting you can correct later
without rework.

## Step 2 — Add Deployer K8s PaaS

From the [Marketplace](https://platform.mckinsey.com/marketplace), add the
**Deployer K8s PaaS** service and set the app URL prefix. That prefix becomes
the hostname, so choose it deliberately — something recognisable to the team,
not to the client's staff.

Provisioning takes roughly 20 minutes and produces the GitHub repo, Vault, the
CI/CD wiring, the Argo CD application and the URL with McKinsey ID auth in
front of it. This app does not use the S3 bucket that comes with it.

Write down what it gives you; those values fill the TODOs in `values.yaml`.

## Step 3 — Put the app in the provisioned repo

Copy this repo's contents in, keeping `deploy/Dockerfile` as the build file and
the build context at the repository root:

```
docker build -f deploy/Dockerfile -t nazir-paneli:local .
```

The image runs as uid 10001, keeps the application files root-owned so the
runtime user cannot rewrite its own code, pins the Python base image by digest,
and bakes in no secrets. Confirm all four survive any local edits before the
first push — Platform McKinsey requires the first two and Wiz will flag the
third.

Then reconcile `deploy/values.yaml` against the chart the Deployer actually
provisioned. The provisioned chart is authoritative on key names; our file is
authoritative on what this app needs:

- probes on `/api/health`, container port 8000
- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_VERSION`, `LLM_MOCK=0` as plain env
- `LLM_API_KEY` from the Vault-synced secret, never as a literal
- ingress body limit of 1m, matching the 512 KiB cap in the chat handler

Put `LLM_API_KEY` in the provisioned Vault. Never in `values.yaml`, never in
the image, never in a commit.

## Step 4 — Build, scan, promote

CI is GitHub Actions → JFrog with a **mandatory Wiz scan**. Never bypass the
scan; a failing scan means the image does not ship.

`.github/workflows/build-image.yml` in this repo is a starting point, not a
working pipeline. It runs the compile and mock-mode smoke checks, then builds
the image locally, and stops at a deliberately failing placeholder where the
approved Wiz step belongs. It is `workflow_dispatch`-only so it cannot redden
CI before it is real. To finish it:

1. Fill the registry host and credential secret names from the provisioned repo
   (its own workflow is the best reference).
2. Replace the `Wiz scan` placeholder with the approved scan step.
3. Add the `push: branches: [main]` trigger.

Once an image is built and scanned, set `image.tag` in `values.yaml` to that
build's tag or digest and sync the Argo CD application. Check first whether the
provisioned setup already promotes tags automatically — if an image updater is
wired in, do not also edit the tag by hand.

`.github/workflows/pages.yml` is a different, static-only path. It has nothing
to do with this pipeline; see the static-hosting section of the top-level
`README.md` for what that mode can and cannot do.

## Step 5 — Give the team access

Grant teammates through the `manage-mckid-stack` workflow plus the app's McKID
user group (TODO(platform): the group name issued with the service).

Keep the group to the McKinsey team and the ministry counterparts who are meant
to see it. The URL is not a secret, but it is not a public page either.

## Step 6 — Verify the deployment

In order, against the real URL:

1. `GET /api/health` → `{"ok":true,"mock":false}`. If `mock` is `true`,
   `LLM_MOCK` leaked into the deployed environment; fix it before anyone sees
   the dashboard.
2. `GET /` → the dashboard renders, all three languages switch, the use-case
   tabs show their charts.
3. Ask the chat one question. With no gateway configured yet the expected
   result is a clean error state in the UI and a 503 with
   `{"error":"chat is not configured"}` — the operator detail stays in the pod
   log. With a gateway configured you get a reply and a model name.
4. Open it on a phone over mobile data, signed in with McKinsey ID. This is the
   acceptance test that matters.

## Rollback

Set `image.tag` in `values.yaml` back to the previous known-good tag and sync
Argo CD. There is no state to migrate and no data to restore, which makes
rollback safe at any time.

## Known limitations to raise before the client sees it

- **No approved LLM gateway exists for this engagement yet.** The app deploys
  and runs without one; only the chat tab is affected. Do not point it at an
  unapproved endpoint — the panel data goes upstream with every turn.
- **The dashboard loads Leaflet and Chart.js from public CDNs**
  (`unpkg.com`, `cdnjs.cloudflare.com`). If the cluster's egress policy or a
  future CSP blocks them, the map falls back to a schematic view and the charts
  do not render at all. Vendoring both into `web/assets/` would remove that
  dependency; that is a frontend change, not a deployment one.
- **The chat rate limit is per pod.** `RATE_LIMIT_REQUESTS` in `server/app.py`
  is enforced in process memory, so the real ceiling is `replicaCount` times
  that number per minute, and it resets on restart. It is cost protection
  behind an authenticated front door, not a defence against a determined
  caller.
- **Requirements are floor-pinned** (`>=`), so two builds a month apart can
  resolve different dependency versions. Pin exact versions if Wiz results need
  to be reproducible.

## TODOs a human must fill from Platform McKinsey

| Where | Placeholder | Source |
|---|---|---|
| `values.yaml` | `image.repository` | JFrog path from the Deployer service |
| `values.yaml` | `image.tag` | The scanned build |
| `values.yaml` | `imagePullSecrets[0].name` | Pull secret created by Deployer |
| `values.yaml` | `ingress.host` | The app URL prefix you chose |
| `values.yaml` | `secretEnv.LLM_API_KEY.secretName` / `.secretKey` | Provisioned Vault |
| `values.yaml` | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_VERSION` | Approved gateway, once one exists |
| `build-image.yml` | `TODO_JFROG_REGISTRY`, `TODO_JFROG_USERNAME`, `TODO_JFROG_PASSWORD` | Provisioned repo secrets |
| `build-image.yml` | The `Wiz scan` step | Deployer service guide / provisioned workflow |
| This file | Charge code, McKID group name | Engagement and Deployer service |

## Help

- Deployer K8s getting started:
  https://platform.mckinsey.com/knowledge-base/service-guide/1054572739/getting-started
- Application Deployment hub:
  https://platform.mckinsey.com/pages/d72d68e3-fa45-469c-9acf-4173289d7e73
- Slack **#dna-deployer-spoc**:
  https://mckinsey.enterprise.slack.com/archives/C2VKA7EBX
- Platform McKinsey Get Help: https://platform.mckinsey.com/get-help
