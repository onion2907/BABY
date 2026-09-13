// camera-watch — browser side.
//
// Two modes share this page. With a home camera the watching happens in the
// server and this is only a window onto it, so closing the tab changes
// nothing. With the laptop's own webcam the browser must do the capturing, so
// the page has to stay open.

const el = (id) => document.getElementById(id);

const ui = Object.fromEntries([
  "status", "status-text", "banner", "banner-text", "nudges", "toggle", "look-once",
  "video", "still", "overlay", "badge-a", "badge-b",
  "source", "camera-fields", "field-snapshot", "field-rtsp",
  "snapshotUrl", "rtspUrl", "cameraUser", "cameraPassword",
  "visionModel", "summaryModel", "vision-note", "observePrompt",
  "intervalSeconds", "summaryEveryLooks", "nudgeOnNobodySeenMinutes",
  "save-settings", "settings-wrap",
  "summary", "summary-meta", "log", "log-meta", "day-picker",
].map((id) => [id, el(id)]));

const BIG_MODEL_BYTES = 3.5e9;
const STATE_POLL_MS = 5000;

const local = {          // only used in webcam mode
  stream: null,
  busy: false,
  timer: null,
  observations: [],
  warmedModel: null,
};

let installed = [];
let settings = {};
let serverRunning = false;

// ---------- helpers ----------

const formatSize = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);

function setStatus(stateName, text) {
  ui.status.dataset.state = stateName;
  ui["status-text"].textContent = text;
}

function showBanner(text, tone = "warn") {
  ui.banner.hidden = false;
  ui.banner.dataset.tone = tone;
  ui["banner-text"].textContent = "";
  String(text).split(/\n{2,}/).forEach((part, index) => {
    if (index > 0) ui["banner-text"].append(document.createElement("br"));
    if (/^(ollama|npm|git|cd|brew)\s/.test(part.trim())) {
      const code = document.createElement("code");
      code.textContent = part.trim();
      ui["banner-text"].append(code);
    } else {
      ui["banner-text"].append(document.createTextNode(part));
    }
  });
}

const hideBanner = () => { ui.banner.hidden = true; };

const isWebcamMode = () => ui.source.value === "webcam";

function bindRange(id, format) {
  const input = ui[id];
  const output = el(`${id}-out`);
  const sync = () => { output.textContent = format(input.value); };
  input.addEventListener("input", sync);
  sync();
}

// ---------- settings ----------

async function loadConfig() {
  let cfg;
  try {
    cfg = await (await fetch("/api/config")).json();
  } catch (err) {
    setStatus("error", "Cannot reach the program");
    showBanner(`This page loaded but the program behind it did not answer (${err.message}). Did the terminal window get closed?`, "bad");
    return false;
  }

  settings = cfg;
  installed = cfg.models ?? [];

  ui.source.value = cfg.source ?? "webcam";
  ui.snapshotUrl.value = cfg.snapshotUrl ?? "";
  ui.rtspUrl.value = cfg.rtspUrl ?? "";
  ui.cameraUser.value = cfg.cameraUser ?? "";
  ui.cameraPassword.placeholder = cfg.hasCameraPassword ? "saved — leave blank to keep" : "";
  ui.observePrompt.value = cfg.observePrompt ?? "";
  ui.intervalSeconds.value = cfg.intervalSeconds ?? 30;
  ui.summaryEveryLooks.value = cfg.summaryEveryLooks ?? 10;
  ui.nudgeOnNobodySeenMinutes.value = cfg.nudgeOnNobodySeenMinutes ?? 0;
  ["intervalSeconds", "summaryEveryLooks", "nudgeOnNobodySeenMinutes"]
    .forEach((id) => ui[id].dispatchEvent(new Event("input")));

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

  applyMode();

  if (!cfg.ok) {
    setStatus("error", "Not ready");
    showBanner(cfg.error ?? "Ollama is not ready.", "bad");
    ui.toggle.disabled = true;
    ui["settings-wrap"].open = true;
    return false;
  }

  hideBanner();
  describeChosenModel();
  noteSummaryModel();
  ui.toggle.disabled = false;
  return true;
}

function applyMode() {
  const webcam = isWebcamMode();
  ui["camera-fields"].hidden = webcam;
  ui["field-snapshot"].hidden = ui.source.value !== "snapshot";
  ui["field-rtsp"].hidden = ui.source.value !== "rtsp";
  ui["look-once"].hidden = !webcam;
  ui.video.hidden = !webcam;
  ui.still.hidden = webcam;
  if (webcam) {
    ui.toggle.textContent = local.timer ? "Stop" : "Start watching";
  }
}

async function saveSettings() {
  const patch = {
    source: ui.source.value,
    snapshotUrl: ui.snapshotUrl.value.trim(),
    rtspUrl: ui.rtspUrl.value.trim(),
    cameraUser: ui.cameraUser.value.trim(),
    visionModel: ui.visionModel.value,
    summaryModel: ui.summaryModel.value,
    observePrompt: ui.observePrompt.value,
    intervalSeconds: Number(ui.intervalSeconds.value),
    summaryEveryLooks: Number(ui.summaryEveryLooks.value),
    nudgeOnNobodySeenMinutes: Number(ui.nudgeOnNobodySeenMinutes.value),
  };
  // Only send a password when one was actually typed, so saving other settings
  // does not wipe a stored one.
  if (ui.cameraPassword.value) patch.cameraPassword = ui.cameraPassword.value;

  ui["save-settings"].disabled = true;
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`could not save (${res.status})`);
    ui.cameraPassword.value = "";
    await loadConfig();
    showBanner("Settings saved.", "warn");
    setTimeout(hideBanner, 2500);
  } catch (err) {
    showBanner(err.message, "bad");
  } finally {
    ui["save-settings"].disabled = false;
  }
}

function describeChosenModel() {
  const chosen = installed.find((m) => m.name === ui.visionModel.value);
  if (!chosen) return;
  ui["vision-note"].textContent = `· ${formatSize(chosen.size)}`;
  if (chosen.size < BIG_MODEL_BYTES) return;
  const lighter = installed.filter((m) => m.vision && m.size < chosen.size).sort((a, b) => a.size - b.size)[0];
  showBanner(
    `“${chosen.name}” needs roughly ${formatSize(chosen.size)} of memory kept free while it runs, which can bring a modest computer to a crawl. ` +
    (lighter ? `A lighter one you already have is “${lighter.name}” (${formatSize(lighter.size)}).`
             : `To install a much lighter one, run this in a terminal and reload:\n\nollama pull moondream`),
  );
}

function noteSummaryModel() {
  const chosen = installed.find((m) => m.name === ui.summaryModel.value);
  if (!chosen?.vision || installed.some((m) => !m.vision)) return;
  showBanner(
    `The summary is being written by “${chosen.name}”, which is built to look at pictures, not write prose. For a much better one, run this in a terminal and reload:\n\nollama pull llama3.2:3b`,
  );
}

// ---------- the always-on watcher ----------

async function refreshState() {
  if (isWebcamMode()) return;
  let s;
  try {
    s = await (await fetch("/api/state")).json();
  } catch {
    setStatus("error", "Lost contact with the program");
    return;
  }

  serverRunning = s.running;
  ui.toggle.textContent = s.running ? "Stop" : "Start watching";
  ui.toggle.dataset.running = String(s.running);

  if (s.running && s.lastError) setStatus("busy", `Trouble: ${s.lastError}`);
  else if (s.running) setStatus("live", `Watching · ${s.looks} look${s.looks === 1 ? "" : "s"}`);
  else setStatus("idle", "Not watching");

  ui["badge-a"].textContent = s.lastFrameAt
    ? `picture ${new Date(s.lastFrameAt).toTimeString().slice(0, 5)}`
    : "no picture yet";
  ui["badge-b"].textContent = `${s.looks} looks`;

  if (s.lastFrameAt) {
    ui.still.hidden = false;
    ui.overlay.hidden = true;
    ui.still.src = `/api/frame?t=${s.lastFrameAt}`;
  }

  if (s.summaryText) {
    renderSummary(s.summaryText);
    ui["summary-meta"].textContent = s.summaryAt ? `updated ${s.summaryAt}` : "";
  }
  renderNudges(s.nudges ?? []);
}

function renderNudges(nudges) {
  ui.nudges.hidden = nudges.length === 0;
  ui.nudges.innerHTML = "";
  for (const nudge of nudges) {
    const row = document.createElement("div");
    row.className = "nudge";
    const time = document.createElement("time");
    time.textContent = nudge.time;
    const text = document.createElement("span");
    text.textContent = nudge.message;
    row.append(time, text);
    ui.nudges.append(row);
  }
  if (nudges.length) {
    const dismiss = document.createElement("button");
    dismiss.className = "ghost small";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", async () => {
      await fetch("/api/nudges/dismiss", { method: "POST" });
      refreshState();
    });
    ui.nudges.append(dismiss);
  }
}

async function toggleServerWatch() {
  ui.toggle.disabled = true;
  try {
    const res = await fetch("/api/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: !serverRunning }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `could not start (${res.status})`);
    hideBanner();
    await refreshState();
    await loadDay();
  } catch (err) {
    showBanner(err.message, "bad");
  } finally {
    ui.toggle.disabled = false;
  }
}

// ---------- the diary ----------

async function loadDays() {
  try {
    const { days } = await (await fetch("/api/days")).json();
    const current = ui["day-picker"].value;
    ui["day-picker"].innerHTML = "";
    for (const day of days) {
      const option = document.createElement("option");
      option.value = option.textContent = day;
      ui["day-picker"].append(option);
    }
    if (days.includes(current)) ui["day-picker"].value = current;
  } catch { /* the diary is empty until the first look */ }
}

async function loadDay() {
  const day = ui["day-picker"].value;
  try {
    const { entries } = await (await fetch(`/api/day${day ? `?date=${encodeURIComponent(day)}` : ""}`)).json();
    renderLog(entries);
  } catch { /* nothing saved yet */ }
}

function renderLog(entries) {
  ui.log.innerHTML = "";
  const looks = entries.filter((e) => e.type === "look");
  ui["log-meta"].textContent = `${looks.length} look${looks.length === 1 ? "" : "s"}`;

  for (const entry of [...entries].reverse()) {
    if (entry.type === "summary") continue;   // the summary has its own panel
    const li = document.createElement("li");
    li.classList.add(entry.type);
    const stamp = document.createElement("time");
    stamp.textContent = entry.time;
    const text = document.createElement("span");
    text.className = "text";
    text.textContent =
      entry.type === "look" ? entry.text
      : entry.type === "nudge" ? entry.message
      : entry.type === "started" ? "— watching started —"
      : "— watching stopped —";
    const tag = document.createElement("span");
    tag.className = "ms";
    tag.textContent = entry.activity ?? "";
    li.append(stamp, text, tag);
    ui.log.append(li);
  }
}

// ---------- webcam mode ----------

async function ensureCamera() {
  if (local.stream) return true;
  try {
    local.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    ui.video.srcObject = local.stream;
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
  local.stream?.getTracks().forEach((track) => track.stop());
  local.stream = null;
  ui.video.srcObject = null;
  ui.overlay.hidden = false;
}

async function warmUp() {
  if (local.warmedModel === ui.visionModel.value) return true;
  setStatus("busy", "Loading the model into memory — the first time can take a minute…");
  try {
    const res = await fetch("/api/warmup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ui.visionModel.value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `warmup failed (${res.status})`);
    local.warmedModel = ui.visionModel.value;
    return true;
  } catch (err) {
    setStatus("error", "The model would not load");
    showBanner(err.message, "bad");
    return false;
  }
}

function grabFrame() {
  const canvas = document.createElement("canvas");
  const width = 448;
  const ratio = (ui.video.videoHeight || 3) / (ui.video.videoWidth || 4);
  canvas.width = width;
  canvas.height = Math.round(width * ratio);
  canvas.getContext("2d").drawImage(ui.video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
}

async function localObserve() {
  if (local.busy) return;
  local.busy = true;
  setStatus("busy", "Looking…");
  try {
    const res = await fetch("/api/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: grabFrame(), model: ui.visionModel.value, prompt: ui.observePrompt.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      showBanner(body.error ?? `the model did not answer (${res.status})`, "bad");
      setStatus("error", "The model did not answer");
      return;
    }
    local.observations.push({ time: clock(), text: body.text });
    ui["badge-b"].textContent = `${(body.ms / 1000).toFixed(1)}s`;
    setStatus(local.timer ? "live" : "idle", local.timer ? "Watching" : "Done — one look");
    await loadDays();
    await loadDay();
  } catch (err) {
    showBanner(err.message, "bad");
  } finally {
    local.busy = false;
  }
}

function localTick() {
  if (!local.timer) return;
  localObserve().finally(() => {
    if (local.timer) local.timer = setTimeout(localTick, Number(ui.intervalSeconds.value) * 1000);
  });
}

async function toggleLocalWatch() {
  if (local.timer) {
    clearTimeout(local.timer);
    local.timer = null;
    stopCamera();
    ui.toggle.textContent = "Start watching";
    ui.toggle.dataset.running = "false";
    setStatus("idle", "Stopped");
    return;
  }
  if (!(await ensureCamera())) return;
  if (!(await warmUp())) return;
  ui.toggle.textContent = "Stop";
  ui.toggle.dataset.running = "true";
  local.timer = setTimeout(localTick, 0);
}

// ---------- summary rendering ----------

function renderSummary(text) {
  const nowMatch = text.match(/NOW:\s*([\s\S]*?)(?=\n\s*SINCE:|$)/i);
  const sinceMatch = text.match(/SINCE:\s*([\s\S]*)$/i);

  ui.summary.innerHTML = "";
  if (!nowMatch && !sinceMatch) {
    const p = document.createElement("p");
    p.className = "now";
    p.textContent = text;
    ui.summary.append(p);
    return;
  }

  if (nowMatch?.[1].trim()) {
    const head = document.createElement("h3");
    head.textContent = "Now";
    const p = document.createElement("p");
    p.className = "now";
    p.textContent = nowMatch[1].trim();
    ui.summary.append(head, p);
  }

  const bullets = (sinceMatch?.[1] ?? "")
    .split("\n").map((line) => line.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
  if (!bullets.length) return;

  const head = document.createElement("h3");
  head.textContent = "Earlier";
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

// ---------- wiring ----------

bindRange("intervalSeconds", (v) => (v >= 60 ? `${(v / 60).toFixed(v % 60 ? 1 : 0)} min` : `${v}s`));
bindRange("summaryEveryLooks", (v) => `${v} looks`);
bindRange("nudgeOnNobodySeenMinutes", (v) => (Number(v) === 0 ? "off" : `${v} min`));

ui.source.addEventListener("change", applyMode);
ui.visionModel.addEventListener("change", () => { local.warmedModel = null; hideBanner(); describeChosenModel(); });
ui.summaryModel.addEventListener("change", () => { hideBanner(); noteSummaryModel(); });
ui["save-settings"].addEventListener("click", () => saveSettings());
ui.toggle.addEventListener("click", () => (isWebcamMode() ? toggleLocalWatch() : toggleServerWatch()));
ui["look-once"].addEventListener("click", async () => {
  ui["look-once"].disabled = true;
  try {
    if (await ensureCamera() && await warmUp()) {
      await new Promise((r) => setTimeout(r, 400));
      await localObserve();
    }
  } finally {
    ui["look-once"].disabled = false;
  }
});
ui["day-picker"].addEventListener("change", loadDay);
window.addEventListener("beforeunload", () => local.stream && stopCamera());

(async function begin() {
  await loadConfig();
  await loadDays();
  await loadDay();
  await refreshState();
  // Poll rather than push: the watcher runs whether or not anyone is looking,
  // so the page just asks how things are every few seconds.
  setInterval(() => { refreshState(); }, STATE_POLL_MS);
  setInterval(() => { if (!isWebcamMode() && serverRunning) loadDay(); }, STATE_POLL_MS * 3);
})();
