// camera-watch — browser side.
//
// The loop is deliberately conservative: one frame in flight at a time, and a
// frame is only sent if it actually differs from the last one that was sent.
// A local vision model takes seconds per frame, so anything eager just builds
// a queue of stale pictures.

const el = (id) => document.getElementById(id);

const ui = {
  video: el("video"),
  overlay: el("overlay"),
  toggle: el("toggle"),
  status: el("status"),
  statusText: el("status-text"),
  badgeMotion: el("badge-motion"),
  badgeLatency: el("badge-latency"),
  visionModel: el("vision-model"),
  summaryModel: el("summary-model"),
  interval: el("interval"),
  intervalOut: el("interval-out"),
  threshold: el("threshold"),
  thresholdOut: el("threshold-out"),
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

// Send a frame at least this often even if the scene is perfectly still, so a
// long static stretch still leaves a trace in the log.
const FORCE_SEND_AFTER_MS = 90_000;
const DIFF_W = 64;
const DIFF_H = 48;

const state = {
  running: false,
  busy: false,
  stream: null,
  timer: null,
  observations: [],      // every caption, in order
  pending: [],           // captions not yet folded into a summary
  summaryText: "",
  summarising: false,
  looks: 0,
  skipped: 0,
  lastSentAt: 0,
  prevGray: null,        // grayscale of the last frame actually sent
};

const frameCanvas = document.createElement("canvas");
const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
const diffCanvas = document.createElement("canvas");
diffCanvas.width = DIFF_W;
diffCanvas.height = DIFF_H;
const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

// ---------- small helpers ----------

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);

function setStatus(stateName, text) {
  ui.status.dataset.state = stateName;
  ui.statusText.textContent = text;
}

function bindRange(input, output, format) {
  const sync = () => { output.textContent = format(input.value); };
  input.addEventListener("input", sync);
  sync();
}

// ---------- setup ----------

async function loadConfig() {
  const res = await fetch("/api/config");
  const cfg = await res.json();

  ui.observePrompt.value = cfg.observePrompt;

  const fill = (select, models, preferred) => {
    select.innerHTML = "";
    const names = models.length ? models : [preferred];
    for (const name of names) {
      const option = document.createElement("option");
      option.value = option.textContent = name;
      select.append(option);
    }
    if (names.includes(preferred)) select.value = preferred;
  };
  fill(ui.visionModel, cfg.models, cfg.visionModel);
  fill(ui.summaryModel, cfg.models, cfg.summaryModel);

  if (!cfg.ok) {
    setStatus("error", cfg.error);
    return false;
  }
  if (cfg.models.length === 0) {
    setStatus("error", "Ollama is up but has no models. Try: ollama pull qwen2.5vl:7b");
    return false;
  }
  setStatus("idle", `Ollama ready · ${cfg.models.length} model${cfg.models.length === 1 ? "" : "s"}`);
  return true;
}

async function startCamera() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  ui.video.srcObject = state.stream;
  await ui.video.play();
  ui.overlay.hidden = true;
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  ui.video.srcObject = null;
  ui.overlay.hidden = false;
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
    const threshold = Number(ui.threshold.value);
    const stale = Date.now() - state.lastSentAt > FORCE_SEND_AFTER_MS;

    ui.badgeMotion.textContent = `motion ${Number.isFinite(score) ? score.toFixed(1) : "—"}`;
    ui.badgeMotion.dataset.hot = String(Number.isFinite(score) && score >= threshold);

    if (score >= threshold || stale) {
      state.prevGray = gray;
      state.lastSentAt = Date.now();
      observe().catch((err) => console.error(err));
    } else {
      state.skipped++;
      updateLogMeta();
    }
  }

  state.timer = setTimeout(tick, Number(ui.interval.value) * 1000);
}

async function observe() {
  state.busy = true;
  setStatus("busy", "Looking…");
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
      setStatus("error", body.error ?? "Observation failed");
      return;
    }

    const entry = { time, text: body.text, ms: body.ms };
    state.observations.push(entry);
    state.pending.push(entry);
    state.looks++;
    appendLog(entry);
    ui.badgeLatency.textContent = `${(body.ms / 1000).toFixed(1)}s`;
    setStatus("live", "Watching");

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

// ---------- summarising ----------

async function summarise() {
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
    setStatus("error", err.message);
    // The batch never made it into an account, so put it back at the front to
    // be folded into the next attempt rather than silently lost.
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

function appendLog({ time, text, ms, error }) {
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
  latency.textContent = ms ? `${(ms / 1000).toFixed(1)}s` : "";

  li.append(stamp, body, latency);
  ui.log.prepend(li);
  setTimeout(() => li.classList.remove("fresh"), 1200);

  while (ui.log.children.length > 300) ui.log.lastElementChild.remove();
}

function updateLogMeta() {
  ui.logMeta.textContent = `${state.looks} look${state.looks === 1 ? "" : "s"} · ${state.skipped} skipped`;
}

// ---------- start / stop ----------

async function start() {
  try {
    await startCamera();
  } catch (err) {
    setStatus("error", `Camera blocked: ${err.message}`);
    return;
  }
  state.running = true;
  state.lastSentAt = 0;
  state.prevGray = null;
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

  // Fold in whatever was observed after the last summary so the final account
  // covers the whole session.
  if (state.pending.length && !state.summarising) summarise().catch(console.error);
}

// ---------- wiring ----------

bindRange(ui.interval, ui.intervalOut, (v) => `${v}s`);
bindRange(ui.threshold, ui.thresholdOut, (v) => (Number(v) === 0 ? "off" : v));
bindRange(ui.summaryEvery, ui.summaryEveryOut, (v) => `${v} looks`);
bindRange(ui.frameWidth, ui.frameWidthOut, (v) => `${v}px`);

ui.toggle.addEventListener("click", () => (state.running ? stop() : start()));
window.addEventListener("beforeunload", () => state.stream && stopCamera());

loadConfig().then((ready) => { ui.toggle.disabled = !ready; });
