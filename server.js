// camera-watch — a local HTTP server that serves the UI and proxies to Ollama.
//
// Nothing leaves your machine: the browser posts frames here, this process
// forwards them to Ollama on localhost, and the text comes back the same way.
// The only reason this server exists at all is that a browser page cannot
// reach Ollama directly (CORS), and keeping the proxy here keeps the page
// free of any configuration.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");

const PORT = Number(process.env.PORT ?? 8080);
const OLLAMA = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const VISION_MODEL = process.env.VISION_MODEL ?? "qwen2.5vl:7b";
// The summariser only ever sees text, so a plain text model is faster and
// usually better at it. Falls back to the vision model if you have only one.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? VISION_MODEL;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 180000);

const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const DEFAULT_OBSERVE_PROMPT =
  "Describe what is happening in this camera frame in one or two short sentences. " +
  "Report only what is visibly present: people, their posture and actions, objects " +
  "being held or moved, and any change of activity. Do not speculate about intent, " +
  "identity, mood, or anything outside the frame. If the frame shows an empty or " +
  "static scene, say exactly that and nothing more.";

const SUMMARY_SYSTEM =
  "You keep a running account of what a single fixed camera has been showing. " +
  "You are given the account you wrote last, plus the observations recorded since. " +
  "Rewrite the account so it reflects the whole session up to now.\n\n" +
  "Reply in exactly this shape:\n" +
  "NOW: one or two sentences on the current state of the scene.\n" +
  "SINCE: three to six bullets, each starting with a HH:MM:SS timestamp, covering " +
  "only things that changed — someone arriving or leaving, an activity starting or " +
  "stopping, an object appearing. Merge repeats: a person sitting still for ten " +
  "minutes is one bullet, not forty.\n\n" +
  "Be factual and terse. Never invent detail the observations do not contain.";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(new Error(`malformed JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

async function ollama(pathname, payload, signal) {
  const res = await fetch(`${OLLAMA}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Ollama ${pathname} returned ${res.status}: ${detail}`);
  }
  return res;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const rel = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);

  // Refuse anything that resolves outside public/.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, "Forbidden");
  }
  try {
    const data = await fs.readFile(target);
    const type = CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  } catch {
    send(res, 404, "Not found");
  }
}

// GET /api/config — defaults plus whatever models Ollama actually has, so the
// page can populate its dropdowns instead of guessing.
async function handleConfig(res) {
  const defaults = {
    visionModel: VISION_MODEL,
    summaryModel: SUMMARY_MODEL,
    observePrompt: DEFAULT_OBSERVE_PROMPT,
  };
  try {
    const { signal, done } = withTimeout(5000);
    const tags = await fetch(`${OLLAMA}/api/tags`, { signal }).finally(done);
    if (!tags.ok) throw new Error(`status ${tags.status}`);
    const body = await tags.json();
    const models = (body.models ?? []).map((m) => m.name).sort();
    sendJson(res, 200, { ok: true, ollama: OLLAMA, models, ...defaults });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      ollama: OLLAMA,
      models: [],
      error: `Could not reach Ollama at ${OLLAMA} (${err.message}). Is \`ollama serve\` running?`,
      ...defaults,
    });
  }
}

// POST /api/observe — one frame in, one caption out.
async function handleObserve(req, res) {
  const body = await readJsonBody(req);
  const image = String(body.image ?? "").replace(/^data:image\/\w+;base64,/, "");
  if (!image) return sendJson(res, 400, { error: "no image in request" });

  const started = Date.now();
  const { signal, done } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const upstream = await ollama(
      "/api/generate",
      {
        model: body.model || VISION_MODEL,
        prompt: body.prompt || DEFAULT_OBSERVE_PROMPT,
        images: [image],
        stream: false,
        // Captions should be short and repeatable; creativity here just
        // produces embellishment the summariser then has to believe.
        options: { temperature: 0.1, num_predict: 120 },
      },
      signal,
    );
    const result = await upstream.json();
    sendJson(res, 200, {
      text: (result.response ?? "").trim(),
      ms: Date.now() - started,
    });
  } catch (err) {
    const reason = err.name === "AbortError"
      ? `the model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
      : err.message;
    sendJson(res, 502, { error: reason });
  } finally {
    done();
  }
}

// POST /api/summarize — observations in, rolling account out, streamed as SSE
// so the pane fills in as the model writes rather than after it finishes.
async function handleSummarize(req, res) {
  const body = await readJsonBody(req);
  const observations = Array.isArray(body.observations) ? body.observations : [];
  if (observations.length === 0) {
    return sendJson(res, 400, { error: "no observations to summarise" });
  }

  const transcript = observations.map((o) => `[${o.time}] ${o.text}`).join("\n");
  const previous = String(body.previous ?? "").trim();
  const userContent =
    (previous ? `Your previous account:\n${previous}\n\n` : "No previous account — this is the first summary.\n\n") +
    `Observations recorded since:\n${transcript}`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  const { signal, done } = withTimeout(REQUEST_TIMEOUT_MS);
  try {
    const upstream = await ollama(
      "/api/chat",
      {
        model: body.model || SUMMARY_MODEL,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM },
          { role: "user", content: userContent },
        ],
        stream: true,
        options: { temperature: 0.2 },
      },
      signal,
    );

    // Ollama streams newline-delimited JSON; a chunk can split a line, so
    // carry the remainder forward instead of parsing per chunk. The chunks are
    // Uint8Array, not Buffer - decode them rather than calling toString on them.
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of upstream.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const delta = parsed.message?.content;
        if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        if (parsed.done) res.write("data: {\"done\":true}\n\n");
      }
    }
    res.end();
  } catch (err) {
    const reason = err.name === "AbortError"
      ? `the model did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
      : err.message;
    res.write(`data: ${JSON.stringify({ error: reason })}\n\n`);
    res.end();
  } finally {
    done();
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && pathname === "/api/config") return await handleConfig(res);
    if (req.method === "POST" && pathname === "/api/observe") return await handleObserve(req, res);
    if (req.method === "POST" && pathname === "/api/summarize") return await handleSummarize(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    send(res, 405, "Method not allowed");
  } catch (err) {
    console.error(`${req.method} ${pathname} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`camera-watch  →  http://localhost:${PORT}`);
  console.log(`ollama        →  ${OLLAMA}`);
  console.log(`vision model  →  ${VISION_MODEL}`);
  console.log(`summary model →  ${SUMMARY_MODEL}`);
  console.log("\nOpen the URL above in a browser. It must be localhost —");
  console.log("browsers only grant camera access on a secure origin.");
});
