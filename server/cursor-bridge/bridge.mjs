#!/usr/bin/env node
/**
 * OpenAI-compatible bridge backed by the Cursor Agent SDK.
 *
 * Exposes `POST /v1/chat/completions` (non-streaming) so Nazir Paneli's
 * existing LLM client (`server/llm.py`) can run on a Cursor subscription API
 * key with no change to the Python app or the frontend. Point the app at this
 * server:
 *
 *   LLM_MOCK=0
 *   LLM_BASE_URL=http://127.0.0.1:8788/v1
 *   LLM_MODEL=composer-2.5
 *   LLM_API_KEY=local        # any non-empty string; the real key is CURSOR_API_KEY here
 *
 * Each request creates a fresh local agent, sends one prompt, collects the
 * assistant text and exits the run. The Cursor key is read from the
 * environment and never written to disk (credential store is in-memory) nor
 * echoed in responses.
 *
 * NOTE: the Cursor Agent SDK routes through `api.cursor.com` (model
 * validation / cloud routing). In a locked-down network that host must be
 * allowlisted; otherwise every request fails with an upstream/network error.
 */

import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Agent, JsonlLocalAgentStore, CursorAgentError } from "@cursor/sdk";

// Keep the Cursor credential in memory; do not persist it to ~/.config.
process.env.AGENT_CLI_CREDENTIAL_STORE = process.env.AGENT_CLI_CREDENTIAL_STORE || "memory";

const HOST = process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.CURSOR_BRIDGE_PORT || 8788);
const DEFAULT_MODEL = process.env.CURSOR_MODEL || "composer-2.5";
const API_KEY = (process.env.CURSOR_API_KEY || "").trim();
const STORE_DIR = path.join(os.tmpdir(), "nazir-cursor-bridge-store");
const MAX_BODY = 1024 * 1024; // 1 MB; the panel payload is ~20-40 KB

const CLAUDE_HINT = /claude/i;

function scrub(text) {
  // Never let the Cursor key surface in a response body or log line.
  if (API_KEY && typeof text === "string") return text.split(API_KEY).join("***");
  return text;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** Flatten OpenAI-style messages into a single prompt string for the agent. */
function buildPrompt(messages) {
  const systemParts = [];
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") systemParts.push(m.content);
    else if (m.role === "user") turns.push(`User: ${m.content}`);
    else if (m.role === "assistant") turns.push(`Assistant: ${m.content}`);
  }
  const preamble = systemParts.join("\n\n");
  const convo = turns.join("\n\n");
  return [preamble, convo].filter(Boolean).join("\n\n");
}

function modelSelection(id) {
  const model = { id };
  // Claude models on Cursor accept thinking/effort/context params.
  if (CLAUDE_HINT.test(id)) {
    model.params = { thinking: true, effort: process.env.CURSOR_EFFORT || "low", context: 300000 };
  }
  return model;
}

async function runAgent(prompt, modelId) {
  const agent = await Agent.create({
    apiKey: API_KEY,
    model: modelSelection(modelId),
    tools: ["mcp"], // disable built-in Shell/Read/Grep; this is a chat, not a coding task
    local: {
      cwd: process.cwd(),
      settingSources: [], // ignore the host's Cursor rules/settings
      sandboxOptions: { enabled: false },
      store: new JsonlLocalAgentStore(STORE_DIR),
    },
  });

  const run = await agent.send(prompt);

  let text = "";
  for await (const ev of run.stream()) {
    if (ev?.type === "assistant") {
      const blocks = ev.message?.content || [];
      const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (t) text = t; // the SDK re-sends cumulative assistant text
    }
  }

  const result = await run.wait();
  if (result?.status === "error") {
    throw new Error(scrub(String(result?.error?.message || "agent run failed")));
  }
  return (text || result?.result || "").trim();
}

function completion(model, content) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-${now}`,
    object: "chat.completion",
    created: now,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, model: DEFAULT_MODEL, keyPresent: Boolean(API_KEY) });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, { object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "cursor" }] });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!API_KEY) return json(res, 500, { error: { message: "CURSOR_API_KEY is not set on the bridge" } });

    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return json(res, 400, { error: { message: "invalid JSON body" } });
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (messages.length === 0) return json(res, 400, { error: { message: "no messages" } });
      const modelId = (typeof payload.model === "string" && payload.model) || DEFAULT_MODEL;
      const prompt = buildPrompt(messages);
      try {
        const content = await runAgent(prompt, modelId);
        if (!content) return json(res, 502, { error: { message: "agent returned an empty completion" } });
        return json(res, 200, completion(modelId, content));
      } catch (e) {
        const kind = e instanceof CursorAgentError ? e.name : "BridgeError";
        // Surface a clean, key-free message; details go to the bridge log only.
        console.error(`[bridge] ${kind}: ${scrub(String(e?.message || e)).slice(0, 300)}`);
        return json(res, 502, { error: { message: `cursor bridge failed: ${kind}` } });
      }
    });
    return;
  }

  return json(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}  model=${DEFAULT_MODEL}  key=${API_KEY ? "present" : "MISSING"}`);
});
