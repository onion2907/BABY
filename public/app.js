// camera-watch — browser side.
//
// Design rules learned the hard way:
//   * default to the smallest model, never the best one;
//   * prove one frame works before starting a loop;
//   * if the machine is drowning, stop, don't keep queueing work.

const el = (id) => document.getElementById(id);

const ui = {
  video: el("video"),
  overlay: el("overlay"),
  toggle: el("toggle"),
  lookOnce: el("look-once"),
  summariseNow: el("summarise-now"),
  status: el("status"),
  statusText: el("status-text"),
  banner: el("banner"),
  bannerText: el("banner-text"),
  badgeMotion: el("badge-motion"),
  badgeLatency: el("badge-latency"),
  visionModel: el("vision-model"),
  visionNote: el("vision-note"),
  summaryModel: el("summary-model"),
  interval: el("interval"),
  intervalOut: el("interval-out"),
  motion: el("motion"),
  summaryEvery: el("summary-every"),
  summaryEveryOut: el("summary-every-out"),
  frameWidth: el("frame-width"),
  frameWidthOut: el("frame-width-out"),
  observePrompt: el("observe-prompt"),
  summary: el("summary"),
  summaryMeta: el("summary-meta"),
  log: el("log"),
  logMeta: el("log-meta"),
};

const FORCE_SEND_AFTER_MS = 90_000;
// A single look taking longer than this means the model does not fit
// comfortably on this machine. Two in a row and we stop, rather than pile up
// work until the laptop swaps itself to a standstill.
const TOO_SLOW_MS = 45_000;
const BIG_MODEL_BYTES = 3.5e9;
const DIFF_W = 64;
const DIFF_H = 48;

const state = {
  running: false,
  busy: false,
  stream: null,
  timer: null,
  observations: [],
  pending: [],
  summaryText: "",
  summarising: false,
  looks: 0,
  skipped: 0,
  lastSentAt: 0,
  prevGray: null,
  warmedModel: null,
  slowStreak: 0,
  backedOff: false,
};

const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
const diffCanvas = document.createElement("canvas");
diffCanvas.width = DIFF_W;
diffCanvas.height = DIFF_H;
const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

// ---------- helpers ----------

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);

const formatSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

function setStatus(stateName, text) {
  ui.status.dataset.state = stateName;
  ui.statusText.textContent = text;
}

// Renders plain text, but puts anything that looks like a terminal command on
// its own selectable line — these banners exist to be copied and pasted.
function showBanner(text, tone = "warn") {
  ui.banner.hidden = false;
  ui.banner.dataset.tone = tone;
  ui.bannerText.textContent = "";
  const parts = String(text).split(/\n{2,}/);
  parts.forEach((part, index) => {
    if (index > 0) ui.bannerText.append(document.createElement("br"));
    if (/^(ollama|npm|git|cd)\s/.test(part.trim())) {
      const code = document.createElement("code");
      code.textContent = part.trim();
      ui.bannerText.append(code);
    } else {
      ui.bannerText.append(document.createTextNode(part));
    }
  });
}

const hideBanner = () => { ui.banner.hidden = true; };

function bindRange(input, output, format) {
  const sync = () => { output.textContent = format(input.value); };
  input.addEventListener("input", sync);
  sync();
}

// ---------- setup ----------

let installed = [];

async function loadConfig() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (err) {
    setStatus("error", "Cannot reach the local server");
    showBanner(`The page loaded but the local server did not answer (${err.message}). Did the terminal window get closed?`, "bad");
    return false;
  }

  ui.observePrompt.value = cfg.observePrompt;
  installed = cfg.models ?? [];

  const fill = (select, list, preferred) => {
    select.innerHTML = "";
    for (const model of list) {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = `${model.name} — ${formatSize(model.size)}`;
      select.append(option);
    }
    if (list.some((m) => m.name === preferred)) select.value = preferred;
  };

  fill(ui.visionModel, installed.filter((m) => m.vision), cfg.visionModel);
  fill(ui.summaryModel, installed, cfg.summaryModel);

  if (!cfg.ok) {
    setStatus("error", cfg.models?.length ? "No model that can see images" : "Ollama not ready");
    showBanner(cfg.error ?? "Ollama is not ready.", "bad");
    return false;
  }

  hideBanner();
  describeChosenModel();
  noteSummaryModel();
  setStatus("idle", "Ready — try “Look once” first");
  return true;
}

// A big model does not fail politely; it exhausts memory and takes the machine
// with it. Say so before it happens, not after.
function describeChosenModel() {
  const chosen = installed.find((m) => m.name === ui.visionModel.value);
  if (!chosen) return;
  ui.visionNote.textContent = `· ${formatSize(chosen.size)}`;

  const lighter = installed
    .filter((m) => m.vision && m.size < chosen.size)
    .sort((a, b) => a.size - b.size)[0];

  if (chosen.size >= BIG_MODEL_BYTES) {
    showBanner(
      `“${chosen.name}” needs roughly ${formatSize(chosen.size)} of memory kept free while it runs. ` +
      `On a laptop with 8 GB or 16 GB of memory this can slow everything to a crawl. ` +
      (lighter
        ? `A lighter model you already have is “${lighter.name}” (${formatSize(lighter.size)}) — pick it above.`
        : `To install a much lighter one, run this in a terminal and reload this page:\n\nollama pull moondream`),
    );
  } else {
    hideBanner();
  }
}

// The summariser only ever reads text. A vision model pressed into that job
// tends to parrot the input back — bare timestamps, no prose — so nudge
// towards a small text-only model if none is installed.
function noteSummaryModel() {
  const chosen = installed.find((m) => m.name === ui.summaryModel.value);
  const hasTextModel = installed.some((m) => !m.vision);
  if (!chosen?.vision || hasTextModel) return;
  showBanner(
    `The summary is being written by "${chosen.name}", which is built to look at pictures, not to write prose — ` +
    `expect the summary to read poorly. For a much better one, install a small text model by running this in a ` +
    `terminal, then reload this page:\n\nollama pull llama3.2:3b`,
  );
}

async function ensureCamera() {
  if (state.stream) return true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    ui.video.srcObject = state.stream;
    await ui.video.play();
    ui.overlay.hidden = true;
    return true;
  } catch (err) {
    setStatus("error", "Camera blocked");
    showBanner(`The browser would not give this page the camera (${err.message}). Check the camera icon in the address bar, and make sure the address starts with http://localhost.`, "bad");
    return false;
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  ui.video.srcObject = null;
  ui.overlay.hidden = false;
}

// Ollama loads a model into memory on first use, which on a big model can take
// a minute of apparent silence. Do it explicitly so it can be reported.
async function warmUp() {
  const model = ui.visionModel.value;
  if (state.warmedModel === model) return true;

  setStatus("busy", "Loading the model into memory — the first time can take a minute…");
  try {
    const res = await fetch("/api/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `warmup failed (${res.status})`);
    state.warmedModel = model;
    return true;
  } catch (err) {
    setStatus("error", "The model would not load");
    showBanner(err.message, "bad");
    return false;
  }
}

// ---------- frame capture and the motion gate ----------

function grabFrame() {
  const width = Number(ui.frameWidth.value);
  const ratio = (ui.video.videoHeight || 3) / (ui.video.videoWidth || 4);
  frameCanvas.width = width;
  frameCanvas.height = Math.round(width * ratio);
  frameCtx.drawImage(ui.video, 0, 0, frameCanvas.width, frameCanvas.height);
  return frameCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

// Mean absolute per-pixel difference against the last frame we sent, on a tiny
// grayscale copy. Comparing against the last *sent* frame rather than the last
// captured one means a slow drift still eventually trips the threshold.
function motionScore() {
  diffCtx.drawImage(ui.video, 0, 0, DIFF_W, DIFF_H);
  const { data } = diffCtx.getImageData(0, 0, DIFF_W, DIFF_H);
  const gray = new Uint8Array(DIFF_W * DIFF_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  if (!state.prevGray) return { score: Infinity, gray };
  let total = 0;
  for (let i = 0; i < gray.length; i++) total += Math.abs(gray[i] - state.prevGray[i]);
  return { score: total / gray.length, gray };
}

// ---------- the watch loop ----------

async function tick() {
  if (!state.running) return;

  if (!state.busy && ui.video.readyState >= 2) {
    const { score, gray } = motionScore();
    const threshold = Number(ui.motion.value);
    const stale = Date.now() - state.lastSentAt > FORCE_SEND_AFTER_MS;

    ui.badgeMotion.textContent = `change ${Number.isFinite(score) ? score.toFixed(1) : "—"}`;
    ui.badgeMotion.dataset.hot = String(Number.isFinite(score) && score >= threshold);

    if (score >= threshold || stale) {
      state.prevGray = gray;
      state.lastSentAt = Date.now();
      observe().catch((err) => console.error(err));
    } else {
      state.skipped++;
      updateLogMeta();
      if (state.skipped === 12 && state.looks === 0) {
        showBanner('Nothing has been sent to the model yet — every frame looked too similar to send. Change “Which frames to send” to a setting nearer the top of the list.');
      }
    }
  }

  state.timer = setTimeout(tick, Number(ui.interval.value) * 1000);
}

async function observe() {
  state.busy = true;
  setStatus("busy", state.looks === 0 ? "Describing the first picture…" : "Looking…");
  const time = clock();

  try {
    const res = await fetch("/api/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: grabFrame(),
        model: ui.visionModel.value,
        prompt: ui.observePrompt.value,
      }),
    });
    const body = await res.json();

    if (!res.ok) {
      appendLog({ time, text: body.error ?? `request failed (${res.status})`, error: true });
      setStatus("error", "The model did not answer");
      showBanner(body.error ?? `The model did not answer (${res.status}).`, "bad");
      return;
    }

    if (!String(body.text ?? "").trim()) {
      appendLog({ time, text: "the model returned an empty answer", error: true });
      setStatus("error", "The model answered with nothing");
      showBanner('The model ran but produced no words. Open "What to ask about each frame" and make the question shorter and simpler.', "bad");
      return;
    }

    const entry = { time, text: body.text, ms: body.ms, retried: body.retried };
    state.observations.push(entry);
    state.pending.push(entry);
    state.looks++;
    appendLog(entry);
    ui.badgeLatency.textContent = `${(body.ms / 1000).toFixed(1)}s`;
    setStatus(state.running ? "live" : "idle", state.running ? "Watching" : "Done — one look");
    ui.summariseNow.disabled = false;

    guardAgainstOverload(body.ms);

    if (state.pending.length >= Number(ui.summaryEvery.value) && !state.summarising) {
      summarise().catch((err) => console.error(err));
    }
  } catch (err) {
    appendLog({ time, text: err.message, error: true });
    setStatus("error", err.message);
  } finally {
    state.busy = false;
    updateLogMeta();
  }
}

// The protection that matters most: notice the machine is struggling and stop,
// instead of letting a too-heavy model swap the laptop into the ground.
function guardAgainstOverload(ms) {
  if (ms <= TOO_SLOW_MS) {
    state.slowStreak = 0;
    // Still worth pacing the loop to the model's real speed.
    if (state.running && ms > Number(ui.interval.value) * 1000 && !state.backedOff) {
      const paced = Math.min(30, Math.ceil(ms / 1000) + 2);
      if (paced > Number(ui.interval.value)) {
        ui.interval.value = String(paced);
        ui.interval.dispatchEvent(new Event("input"));
        state.backedOff = true;
        showBanner(`Each look is taking about ${(ms / 1000).toFixed(0)} seconds, so the gap between looks has been widened to ${paced} seconds to match. Choose a smaller model or a smaller picture size to speed it up.`);
      }
    }
    return;
  }

  state.slowStreak++;
  if (state.slowStreak < 2) return;

  const lighter = installed
    .filter((m) => m.vision && m.size < (installed.find((x) => x.name === ui.visionModel.value)?.size ?? Infinity))
    .sort((a, b) => a.size - b.size)[0];

  if (state.running) stop();
  setStatus("error", "Stopped — the model is too slow for this machine");
  showBanner(
    `Watching has been stopped. Each look took over ${TOO_SLOW_MS / 1000} seconds, which means “${ui.visionModel.value}” is too heavy for this computer and would keep slowing it down. ` +
    (lighter
      ? `Pick “${lighter.name}” (${formatSize(lighter.size)}) in the Vision model list and try again.`
      : `Install a much lighter model by running this in a terminal, then reload this page:\n\nollama pull moondream`),
    "bad",
  );
}

// ---------- summarising ----------

async function summarise() {
  if (state.pending.length === 0 || state.summarising) return;
  const batch = state.pending;
  state.pending = [];
  state.summarising = true;
  ui.summaryMeta.textContent = "writing…";
  ui.summary.classList.add("streaming");

  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        observations: batch,
        previous: state.summaryText,
        model: ui.summaryModel.value,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `summary failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let text = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const events = buffered.split("\n\n");
      buffered = events.pop() ?? "";
      for (const event of events) {
        const line = event.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.error) throw new Error(payload.error);
        if (payload.delta) {
          text += payload.delta;
          renderSummary(text);
        }
      }
    }

    if (text.trim()) state.summaryText = text.trim();
    ui.summaryMeta.textContent = `updated ${clock()} · ${state.observations.length} looks`;
  } catch (err) {
    ui.summaryMeta.textContent = "failed";
    setStatus("error", "The summary failed");
    showBanner(err.message, "bad");
    // The batch never made it into an account, so put it back rather than
    // silently lose it.
    state.pending = batch.concat(state.pending);
  } finally {
    state.summarising = false;
    ui.summary.classList.remove("streaming");
  }
}

// The model is asked for NOW: / SINCE: — render that shape, but degrade to
// plain paragraphs if it wanders off format, which small models do.
function renderSummary(text) {
  const nowMatch = text.match(/NOW:\s*([\s\S]*?)(?=\n\s*SINCE:|$)/i);
  const sinceMatch = text.match(/SINCE:\s*([\s\S]*)$/i);

  if (!nowMatch && !sinceMatch) {
    ui.summary.innerHTML = "";
    const p = document.createElement("p");
    p.className = "now";
    p.textContent = text;
    ui.summary.append(p);
    return;
  }

  ui.summary.innerHTML = "";

  if (nowMatch?.[1].trim()) {
    const head = document.createElement("h3");
    head.textContent = "Now";
    const p = document.createElement("p");
    p.className = "now";
    p.textContent = nowMatch[1].trim();
    ui.summary.append(head, p);
  }

  const bullets = (sinceMatch?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);

  if (bullets.length) {
    const head = document.createElement("h3");
    head.textContent = "Since you started";
    const list = document.createElement("ul");
    for (const bullet of bullets) {
      const li = document.createElement("li");
      const stamp = bullet.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*/);
      if (stamp) {
        const b = document.createElement("b");
        b.textContent = stamp[1];
        li.append(b, document.createTextNode(bullet.slice(stamp[0].length)));
      } else {
        li.textContent = bullet;
      }
      list.append(li);
    }
    ui.summary.append(head, list);
  }
}

// ---------- log ----------

function appendLog({ time, text, ms, error, retried }) {
  const li = document.createElement("li");
  if (error) li.classList.add("error");
  li.classList.add("fresh");

  const stamp = document.createElement("time");
  stamp.textContent = time;
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  const latency = document.createElement("span");
  latency.className = "ms";
  latency.textContent = ms ? `${retried ? "retried · " : ""}${(ms / 1000).toFixed(1)}s` : "";

  li.append(stamp, body, latency);
  ui.log.prepend(li);
  setTimeout(() => li.classList.remove("fresh"), 1200);

  while (ui.log.children.length > 300) ui.log.lastElementChild.remove();
}

function updateLogMeta() {
  ui.logMeta.textContent = `${state.looks} look${state.looks === 1 ? "" : "s"} · ${state.skipped} skipped`;
}

// ---------- start / stop ----------

async function lookOnce() {
  ui.lookOnce.disabled = true;
  try {
    if (!(await ensureCamera())) return;
    if (!(await warmUp())) return;
    // Give the camera a moment to expose properly before judging the picture.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await observe();
  } finally {
    ui.lookOnce.disabled = false;
  }
}

async function start() {
  if (!(await ensureCamera())) return;
  if (!(await warmUp())) return;
  state.running = true;
  state.lastSentAt = 0;
  state.prevGray = null;
  state.slowStreak = 0;
  state.backedOff = false;
  ui.toggle.textContent = "Stop";
  ui.toggle.dataset.running = "true";
  setStatus("live", "Watching");
  tick();
}

function stop() {
  state.running = false;
  clearTimeout(state.timer);
  stopCamera();
  ui.toggle.textContent = "Start watching";
  ui.toggle.dataset.running = "false";
  ui.badgeMotion.textContent = "—";
  ui.badgeMotion.dataset.hot = "false";
  setStatus("idle", "Stopped");

  // Fold in whatever was seen after the last summary so the final account
  // covers the whole session.
  if (state.pending.length && !state.summarising) summarise().catch(console.error);
}

// ---------- wiring ----------

bindRange(ui.interval, ui.intervalOut, (v) => `${v}s`);
bindRange(ui.summaryEvery, ui.summaryEveryOut, (v) => `${v} looks`);
bindRange(ui.frameWidth, ui.frameWidthOut, (v) => `${v}px`);

ui.summaryModel.addEventListener("change", () => { hideBanner(); noteSummaryModel(); });
ui.visionModel.addEventListener("change", () => {
  state.warmedModel = null;
  state.slowStreak = 0;
  describeChosenModel();
});
ui.toggle.addEventListener("click", () => (state.running ? stop() : start()));
ui.lookOnce.addEventListener("click", () => lookOnce().catch(console.error));
ui.summariseNow.addEventListener("click", () => summarise().catch(console.error));
window.addEventListener("beforeunload", () => state.stream && stopCamera());

loadConfig().then((ready) => {
  ui.toggle.disabled = !ready;
  ui.lookOnce.disabled = !ready;
});
