// One editable settings file, so nothing has to be configured by typing
// environment variables into a terminal. Missing keys fall back to defaults,
// so an older config.json keeps working after an update.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_PATH = path.join(ROOT, "config.json");
export const DATA_DIR = path.join(ROOT, "data");

export const DEFAULTS = {
  // "webcam"   — the laptop's own camera, captured by the browser (needs the page open)
  // "snapshot" — a still-image web address the camera serves (no extra software)
  // "rtsp"     — a video stream from a home camera (needs ffmpeg installed)
  source: "webcam",
  snapshotUrl: "",
  rtspUrl: "",
  cameraUser: "",
  cameraPassword: "",

  visionModel: "",
  summaryModel: "",
  observePrompt: "Describe what is happening in this image in one or two short sentences.",

  // A diary wants regular samples, not event-driven ones, so this is a plain
  // fixed cadence rather than a motion trigger.
  intervalSeconds: 30,
  summaryEveryLooks: 10,
  frameWidth: 448,

  // The only nudge that is reliable enough to trust: the camera has stopped
  // answering. Everything else needs tuning against real footage first.
  nudgeOnCameraDownAfterFailures: 3,
  nudgeOnNobodySeenMinutes: 0, // 0 = off until tuned against your own camera
};

export function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Credentials belong in config.json, never in anything the page or the log can
// see — a camera password in a browser tab is a camera password on the network.
export function redact(config) {
  const { cameraPassword, snapshotUrl, rtspUrl, ...rest } = config;
  const hideAuth = (url) => url.replace(/\/\/[^@/]+@/, "//…@");
  return {
    ...rest,
    snapshotUrl: hideAuth(snapshotUrl),
    rtspUrl: hideAuth(rtspUrl),
    hasCameraPassword: Boolean(cameraPassword),
  };
}
