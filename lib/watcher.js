// The background watcher. This is what makes the diary survive the browser
// being closed: the loop lives in the server process, and the page is only a
// window onto it.
import * as capture from "./capture.js";
import * as store from "./store.js";
import * as ollama from "./ollama.js";
import * as config from "./config.js";
import { resolveSettings } from "./models.js";

const clock = (d = new Date()) => d.toTimeString().slice(0, 8);

export const state = {
  running: false,
  startedAt: null,
  lastFrame: null,        // base64 JPEG, for the page to display
  lastFrameAt: null,
  lastError: null,
  consecutiveFailures: 0,
  looks: 0,
  pending: [],
  summaryText: "",
  summaryAt: null,
  nudges: [],
  lastSeenPersonAt: null,
};

let timer = null;

function raiseNudge(kind, message) {
  // One standing nudge per kind — a camera that has been down for an hour is
  // one problem, not one hundred and twenty.
  if (state.nudges.some((n) => n.kind === kind)) return;
  const nudge = { kind, message, time: clock(), at: Date.now() };
  state.nudges.unshift(nudge);
  store.append({ type: "nudge", time: nudge.time, kind, message });
}

const clearNudge = (kind) => { state.nudges = state.nudges.filter((n) => n.kind !== kind); };

export function dismissNudges() { state.nudges = []; }

async function summarise(settings) {
  const batch = state.pending;
  if (batch.length === 0) return;
  state.pending = [];

  const transcript = batch.map((o) => `[${o.time}] ${o.text}`).join("\n");
  const previous = state.summaryText.trim();
  const { signal, done } = ollama.withTimeout();
  try {
    const res = await ollama.call("/api/chat", {
      model: settings.summaryModel,
      stream: false,
      keep_alive: "15m",
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: ollama.SUMMARY_SYSTEM },
        {
          role: "user",
          content:
            (previous ? `Your previous account:\n${previous}\n\n` : "No previous account.\n\n") +
            `Observations recorded since:\n${transcript}`,
        },
      ],
    }, signal);
    const text = ((await res.json()).message?.content ?? "").trim();
    if (text) {
      state.summaryText = text;
      state.summaryAt = clock();
      store.append({ type: "summary", time: state.summaryAt, text });
    }
  } catch (err) {
    // Losing a summary must never lose the observations behind it.
    state.pending = batch.concat(state.pending);
    state.lastError = `summary failed: ${err.message}`;
  } finally {
    done();
  }
}

function checkQuiet(settings) {
  const minutes = Number(settings.nudgeOnNobodySeenMinutes ?? 0);
  if (!minutes || !state.lastSeenPersonAt) return;
  const quietFor = (Date.now() - state.lastSeenPersonAt) / 60_000;
  if (quietFor >= minutes) {
    raiseNudge("quiet", `Nobody has been visible in the room for ${Math.round(quietFor)} minutes.`);
  } else {
    clearNudge("quiet");
  }
}

async function tick() {
  // Resolve models here too — config.json often names none, and asking Ollama
  // for a model called "" is a 404 that looks like a camera problem.
  const { config: settings, ollamaUp } = await resolveSettings();

  if (!ollamaUp) {
    state.lastError = "Ollama is not responding. Start it with: ollama serve";
    return schedule(settings);
  }
  if (!settings.visionModel) {
    state.lastError = "No model that can see images is installed. Run: ollama pull moondream";
    raiseNudge("model", state.lastError);
    return schedule(settings);
  }
  clearNudge("model");

  let image;
  try {
    image = await capture.grab(settings);
    state.consecutiveFailures = 0;
    state.lastError = null;
    clearNudge("camera");
  } catch (err) {
    state.consecutiveFailures++;
    state.lastError = err.message;
    if (state.consecutiveFailures >= Number(settings.nudgeOnCameraDownAfterFailures ?? 3)) {
      raiseNudge("camera", `The camera has not sent a picture for ${state.consecutiveFailures} tries in a row. Last reason: ${err.message}`);
    }
    return schedule(settings);
  }

  state.lastFrame = image;
  state.lastFrameAt = Date.now();

  try {
    const { text, retried } = await ollama.describe(settings.visionModel, settings.observePrompt, image);
    if (text) {
      const classification = await ollama.classify(settings.summaryModel, text);
      const entry = {
        type: "look",
        time: clock(),
        text,
        retried,
        ...(classification ?? {}),
      };
      state.looks++;
      state.pending.push(entry);
      store.append(entry);

      if (classification?.personVisible) state.lastSeenPersonAt = Date.now();
      checkQuiet(settings);

      if (state.pending.length >= Number(settings.summaryEveryLooks ?? 10)) {
        await summarise(settings);
      }
    } else {
      state.lastError = "the model answered with nothing";
    }
  } catch (err) {
    state.lastError = err.message;
  }

  schedule(settings);
}

function schedule(settings) {
  if (!state.running) return;
  timer = setTimeout(() => { tick().catch((err) => { state.lastError = err.message; schedule(settings); }); },
    Math.max(5, Number(settings.intervalSeconds ?? 30)) * 1000);
}

export async function start() {
  if (state.running) return state;
  const { config: settings } = await resolveSettings({ fresh: true });
  if (!capture.canGrabWithoutBrowser(settings)) {
    throw new Error(
      'The camera source is still set to "webcam", which needs the browser page open. ' +
      'Set a home camera in config.json to watch around the clock.',
    );
  }
  state.running = true;
  state.startedAt = Date.now();
  state.nudges = [];
  store.append({ type: "started", time: clock() });
  await tick();
  return state;
}

export async function stop() {
  if (!state.running) return state;
  state.running = false;
  clearTimeout(timer);
  store.append({ type: "stopped", time: clock() });
  // Fold in anything seen since the last summary so the day's record is whole.
  await summarise((await resolveSettings()).config).catch(() => {});
  return state;
}
