"""Serves the Nazir Paneli dashboard and its chat endpoint.

The browser sends the panel's own data as ``context`` with every turn, so the
model answers from what the dashboard actually shows rather than from its own
recollection. Nothing is persisted server-side.
"""

import json
import logging
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from .llm import LLMNotConfigured, LLMUpstreamError, complete, is_mock

log = logging.getLogger("nazir")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

LANGUAGE = {"az": "Azerbaijani", "en": "English", "ru": "Russian"}

# The panel's grounding payload is about 20 KB today. These caps leave it ample
# room while keeping a hostile caller from driving prompt cost, or the server's
# memory, through the request body.
MAX_BODY_BYTES = 512 * 1024
MAX_CONTEXT_CHARS = 256 * 1024
MAX_MESSAGE_CHARS = 8_000
MAX_TURNS = 12

# Cost protection rather than abuse protection: the deployed app sits behind
# McKinsey ID, so every caller is already a named user.
RATE_LIMIT_REQUESTS = 12
RATE_LIMIT_WINDOW = 60.0

SYSTEM_PROMPT = """\
You are the analytical assistant built into Nazir Paneli, the executive \
dashboard used by the Minister of Agriculture of Azerbaijan.

Ground every answer in the JSON supplied under CONTEXT below. It holds the \
panel's headline indicators, the ten eAgro AI use cases with their figures, \
charts and tables, and a set of curated answers with sources.

Rules:
- Use only figures that appear in CONTEXT. Never invent a number. If the answer \
is not in CONTEXT, say plainly that the panel does not carry that figure and \
name the closest thing it does carry.
- Quote figures with their units and, where CONTEXT gives one, the reference \
period and source.
- Everything under `use_cases` is demonstration data built to show the shape of \
each module. When you cite it, say so once, briefly. The `headline_indicators` \
and `curated_answers` come from published sources and can be quoted normally.
- Write for a minister: lead with the answer, then the evidence. Two to five \
sentences unless more is genuinely needed. Use short bullet lists for \
comparisons across districts, crops or regions.
- Where a use case is relevant, name it so the reader knows which tab to open.
- Reply in {language}. Use **bold** for emphasis; no headings, no tables.
"""


class ChatIn(BaseModel):
    lang: Literal["az", "en", "ru"] = "az"
    messages: list[dict] = Field(default_factory=list)
    context: dict = Field(default_factory=dict)


app = FastAPI(title="Nazir Paneli", docs_url=None, redoc_url=None)

_hits: dict[str, list[float]] = {}


def _client_id(request: Request) -> str:
    """Caller identity for rate limiting.

    Behind the Deployer ingress every request arrives from the same pod, so the
    forwarded address is the only thing that distinguishes callers.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_limited(client: str) -> bool:
    """Record a request and report whether the caller is over the window cap."""
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW
    for caller, hits in list(_hits.items()):
        fresh = [h for h in hits if h > cutoff]
        if fresh:
            _hits[caller] = fresh
        else:
            del _hits[caller]  # keeps the table from growing without bound

    hits = _hits.setdefault(client, [])
    if len(hits) >= RATE_LIMIT_REQUESTS:
        return True
    hits.append(now)
    return False


@app.get("/api/health")
async def health():
    return {"ok": True, "mock": is_mock()}


@app.post("/api/chat")
async def chat(request: Request):
    if _rate_limited(_client_id(request)):
        return JSONResponse(
            {"error": "too many requests"},
            status_code=429,
            headers={"Retry-After": str(int(RATE_LIMIT_WINDOW))},
        )

    # Read the body ourselves so an oversized post is cut off as it streams in
    # rather than after the framework has buffered all of it.
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY_BYTES:
            return JSONResponse({"error": "request too large"}, status_code=413)

    try:
        body = ChatIn.model_validate_json(bytes(raw))
    except ValidationError:
        return JSONResponse({"error": "invalid request"}, status_code=422)

    turns = [
        {"role": m["role"], "content": m["content"]}
        for m in body.messages
        if m.get("role") in ("user", "assistant")
        and isinstance(m.get("content"), str)
        and m["content"].strip()
    ][-MAX_TURNS:]  # keep the prompt bounded; the panel data dominates the token budget

    if not turns:
        return JSONResponse({"error": "no message"}, status_code=400)

    if any(len(t["content"]) > MAX_MESSAGE_CHARS for t in turns):
        return JSONResponse({"error": "message too long"}, status_code=413)

    context = json.dumps(body.context, ensure_ascii=False)
    if len(context) > MAX_CONTEXT_CHARS:
        return JSONResponse({"error": "context too large"}, status_code=413)

    system = SYSTEM_PROMPT.format(language=LANGUAGE[body.lang]) + "\n\nCONTEXT:\n" + context

    try:
        reply, model = await complete([{"role": "system", "content": system}, *turns])
    except LLMNotConfigured as exc:
        log.warning("chat unavailable: %s", exc)
        # The detail names environment variables; keep it in the log, not in the
        # response body.
        return JSONResponse({"error": "chat is not configured"}, status_code=503)
    except LLMUpstreamError as exc:
        log.warning("upstream chat call failed: %s", exc)
        return JSONResponse({"error": "upstream request failed"}, status_code=502)

    return {"reply": reply, "model": model}


# Mounted last so the API routes above take precedence.
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
