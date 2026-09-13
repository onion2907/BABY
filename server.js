// camera-watch — the local server.
//
// Serves the page, and hosts the background watcher so the diary keeps running
// with no browser open. Nothing leaves the machine: pictures go from the camera
// to here to Ollama on localhost, and the text comes back the same way.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as ollama from "./lib/ollama.js";
import * as store from "./lib/store.js";
import * as watcher from "./lib/watcher.js";
import * as settings from "./lib/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------- plumbing ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

const sendJson = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });

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

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const rel = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, "Forbidden");
  }
  try {
    const data = await fs.readFile(target);
    send(res, 200, data, { "Content-Type": CONTENT_TYPES[path.extname(target)] ?? "application/octet-stream" });
  } catch {
    send(res, 404, "Not found");
  }
}

// ---------- models ----------

const VISION_FAMILIES = ["clip", "mllama", "qwen2vl", "qwen25vl", "gemma3", "siglip"];
const VISION_NAMES = /vl|vision|llava|moondream|bakllava|minicpm-v|gemma3/i;

const looksLikeVision = (model) =>
  (model.details?.families ?? []).some((f) => VISION_FAMILIES.includes(String(f).toLowerCase())) ||
  VISION_NAMES.test(model.name ?? "");

// Default to the SMALLEST capable model installed, never the best one. A big
// model on a small machine does not run slowly — it exhausts memory and takes
// the whole machine down with it.
function chooseModels(models, saved) {
  const vision = models.filter((m) => m.vision).sort((a, b) => a.size - b.size);
  const text = models.filter((m) => !m.vision).sort((a, b) => a.size - b.size);
  const installed = (name) => models.some((m) => m.name === name);
  return {
    visionModel: installed(saved.visionModel) ? saved.visionModel : vision[0]?.name ?? "",
    summaryModel: installed(saved.summaryModel) ? saved.summaryModel : text[0]?.name ?? vision[0]?.name ?? "",
  };
}

async function listModels() {
  return (await ollama.tags())
    .map((m) => ({ name: m.name, size: m.size ?? 0, vision: looksLikeVision(m) }))
    .sort((a, b) => a.size - b.size);
}

// Keep config.json's chosen models honest: if it names something no longer
// installed, fall back rather than failing every look with a 404.
async function resolveSettings() {
  const saved = settings.load();
  try {
    const models = await listModels();
    const chosen = chooseModels(models, saved);
    return { config: { ...saved, ...chosen }, models, ollamaUp: true };
  } catch {
    return { config: saved, models: [], ollamaUp: false };
  }
}

// ---------- endpoints ----------

async function handleConfig(res) {
  const { config, models, ollamaUp } = await resolveSettings();
  const hasVision = models.some((m) => m.vision);

  sendJson(res, 200, {
    ok: ollamaUp && hasVision,
    models,
    ...settings.redact(config),
    visionModel: config.visionModel,
    summaryModel: config.summaryModel,
    error: !ollamaUp
      ? "Could not reach Ollama. Start it with:\n\nollama serve"
      : hasVision
        ? undefined
        : "None of your installed models can see images. Run this in a terminal, then reload:\n\nollama pull moondream",
  });
}

async function handleWarmup(req, res) {
  const body = await readJsonBody(req);
  const { config } = await resolveSettings();
  const model = body.model || config.visionModel;
  if (!model) return sendJson(res, 400, { error: "no model to warm up" });
  const started = Date.now();
  try {
    await ollama.warmUp(model);
    sendJson(res, 200, { ok: true, model, ms: Date.now() - started });
  } catch (err) {
    const missing = /not found|no such model|pull/i.test(err.message);
    sendJson(res, 502, {
      error: missing ? `Ollama does not have "${model}". Install it with:\n\nollama pull ${model}` : err.message,
    });
  }
}

// Used by the browser-webcam mode, where the page supplies the picture.
async function handleObserve(req, res) {
  const body = await readJsonBody(req);
  const image = String(body.image ?? "").replace(/^data:image\/\w+;base64,/, "");
  if (!image) return sendJson(res, 400, { error: "no image in request" });

  const { config } = await resolveSettings();
  const model = body.model || config.visionModel;
  const started = Date.now();
  try {
    const { text, retried } = await ollama.describe(model, body.prompt || config.observePrompt, image);
    if (!text) {
      return sendJson(res, 502, {
        error:
          `"${model}" answered twice with nothing at all. Small models do this when the question is ` +
          `too long or too complicated. Open "What to ask about each frame" and replace it with ` +
          `something short, such as:\n\nDescribe what is happening in this image.`,
      });
    }
    store.append({ type: "look", time: new Date().toTimeString().slice(0, 8), text, retried });
    sendJson(res, 200, { text, ms: Date.now() - started, retried });
  } catch (err) {
    sendJson(res, 502, { error: err.message });
  }
}

async function handleSummarize(req, res) {
  const body = await readJsonBody(req);
  const observations = Array.isArray(body.observations) ? body.observations : [];
  if (observations.length === 0) return sendJson(res, 400, { error: "no observations to summarise" });

  const { config } = await resolveSettings();
  const transcript = observations.map((o) => `[${o.time}] ${o.text}`).join("\n");
  const previous = String(body.previous ?? "").trim();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  const { signal, done } = ollama.withTimeout();
  try {
    const upstream = await ollama.call("/api/chat", {
      model: body.model || config.summaryModel,
      stream: true,
      keep_alive: "15m",
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: ollama.SUMMARY_SYSTEM },
        {
          role: "user",
          content:
            (previous ? `Your previous account:\n${previous}\n\n` : "No previous account — this is the first summary.\n\n") +
            `Observations recorded since:\n${transcript}`,
        },
      ],
    }, signal);

    // Ollama streams newline-delimited JSON; a chunk can split a line, so carry
    // the remainder forward. The chunks are Uint8Array, not Buffer — decode
    // them rather than calling toString on them.
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of upstream.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.message?.content) res.write(`data: ${JSON.stringify({ delta: parsed.message.content })}\n\n`);
        if (parsed.done) res.write('data: {"done":true}\n\n');
      }
    }
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    done();
  }
}

// ---------- the always-on watcher ----------

function watcherState(res) {
  const s = watcher.state;
  sendJson(res, 200, {
    running: s.running,
    startedAt: s.startedAt,
    lastFrameAt: s.lastFrameAt,
    lastError: s.lastError,
    consecutiveFailures: s.consecutiveFailures,
    looks: s.looks,
    summaryText: s.summaryText,
    summaryAt: s.summaryAt,
    nudges: s.nudges,
    day: store.today(),
  });
}

async function handleWatch(req, res) {
  const body = await readJsonBody(req);
  try {
    if (body.on) await watcher.start();
    else await watcher.stop();
    watcherState(res);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

// The most recent picture the watcher fetched, so the page can show the camera
// without opening a second connection to it.
function handleFrame(res) {
  if (!watcher.state.lastFrame) return send(res, 404, "no frame yet");
  send(res, 200, Buffer.from(watcher.state.lastFrame, "base64"), { "Content-Type": "image/jpeg" });
}

async function handleSettings(req, res) {
  if (req.method === "GET") {
    const { config } = await resolveSettings();
    return sendJson(res, 200, settings.redact(config));
  }
  const body = await readJsonBody(req);
  const allowed = [
    "source", "snapshotUrl", "rtspUrl", "cameraUser", "cameraPassword",
    "visionModel", "summaryModel", "observePrompt",
    "intervalSeconds", "summaryEveryLooks", "frameWidth",
    "nudgeOnCameraDownAfterFailures", "nudgeOnNobodySeenMinutes",
  ];
  const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
  sendJson(res, 200, settings.redact(settings.save(patch)));
}

// ---------- routing ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  try {
    if (req.method === "GET" && pathname === "/api/config") return await handleConfig(res);
    if (req.method === "GET" && pathname === "/api/state") return watcherState(res);
    if (req.method === "GET" && pathname === "/api/frame") return handleFrame(res);
    if (req.method === "GET" && pathname === "/api/days") return sendJson(res, 200, { days: store.listDays() });
    if (req.method === "GET" && pathname === "/api/day") {
      return sendJson(res, 200, { day: url.searchParams.get("date") ?? store.today(), entries: store.readDay(url.searchParams.get("date") ?? store.today()) });
    }
    if (pathname === "/api/settings") return await handleSettings(req, res);
    if (req.method === "POST" && pathname === "/api/watch") return await handleWatch(req, res);
    if (req.method === "POST" && pathname === "/api/nudges/dismiss") { watcher.dismissNudges(); return watcherState(res); }
    if (req.method === "POST" && pathname === "/api/warmup") return await handleWarmup(req, res);
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

// Listening on every interface, not just localhost, so a phone on the same
// wifi can read the diary. There is no login, so this is safe only on a home
// network you trust — never forward this port to the internet.
const HOST = process.env.HOST ?? "0.0.0.0";

server.listen(PORT, HOST, () => {
  const current = settings.load();
  console.log(`camera-watch  →  http://localhost:${PORT}`);
  console.log(`on your phone →  http://<this computer's address on your wifi>:${PORT}`);
  console.log(`camera source →  ${current.source}`);
  console.log(`diary saved   →  ${settings.DATA_DIR}`);
  if (current.source === "webcam") {
    console.log("\nStill set to the laptop webcam, so watching needs the page open.");
    console.log("Point it at a home camera in config.json to run around the clock.");
  }
});
