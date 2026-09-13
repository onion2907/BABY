// Finding a camera on the home network, and working out which address it
// answers on. Written so a non-technical owner never has to know their camera's
// model number: probe the network, then try every address pattern in turn.
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  RTSP_PATHS, SNAPSHOT_PATHS, RTSP_PORTS, HTTP_PORTS, buildRtsp, buildSnapshot,
} from "./camera-urls.js";

const PROBE_TIMEOUT_MS = 600;
const PROBE_BATCH = 48;
const TRY_TIMEOUT_MS = 12_000;

export function localSubnets() {
  const subnets = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      // Home networks are /24 in practice; scanning wider would take hours.
      const base = entry.address.split(".").slice(0, 3).join(".");
      if (!subnets.includes(base)) subnets.push(base);
    }
  }
  return subnets;
}

function portOpen(host, port, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

// The ports a camera is likely to answer on: video stream, then the HTTP
// ports ONVIF and snapshots use. A camera that ignores 554 but answers ONVIF
// on 80 still gets found.
const SCAN_PORTS = [...RTSP_PORTS, ...HTTP_PORTS];

// Sweep a /24 for anything listening on any likely camera port.
export async function scan(subnet, ports = SCAN_PORTS, onProgress = () => {}) {
  const found = [];
  const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
  for (let i = 0; i < hosts.length; i += PROBE_BATCH) {
    const batch = hosts.slice(i, i + PROBE_BATCH);
    const results = await Promise.all(batch.map(async (host) => {
      for (const port of ports) {
        if (await portOpen(host, port)) return true;
      }
      return false;
    }));
    results.forEach((open, index) => { if (open) found.push(batch[index]); });
    onProgress(Math.min(i + PROBE_BATCH, hosts.length), hosts.length, found);
  }
  return found;
}

function withAuth(url, user, password) {
  if (!user) return url;
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password ?? "");
  return parsed.toString();
}

// A stream address only counts as working if ffmpeg gets a real picture out of
// it. Anything less and we would be handing back an address that fails later.
function tryRtsp(url, user, password) {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", withAuth(url, user, password),
      "-frames:v", "1", "-an", "-q:v", "5",
      "-f", "image2", "-vcodec", "mjpeg", "pipe:1",
    ]);
    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => { ffmpeg.kill("SIGKILL"); resolve({ ok: false, reason: "timed out" }); }, TRY_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    ffmpeg.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.code === "ENOENT" ? "ffmpeg-missing" : err.message });
    });
    ffmpeg.on("close", () => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks).length;
      if (bytes > 1000) return resolve({ ok: true, bytes });
      const last = stderr.trim().split("\n").pop() ?? "";
      resolve({ ok: false, reason: /401|[Uu]nauthor/.test(last) ? "wrong username or password" : last || "no picture" });
    });
  });
}

async function trySnapshot(url, user, password) {
  const headers = {};
  if (user) headers.Authorization = "Basic " + Buffer.from(`${user}:${password ?? ""}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 8);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 401) return { ok: false, reason: "wrong username or password (or needs digest auth)" };
    if (!res.ok) return { ok: false, reason: `answered ${res.status}` };
    const bytes = (await res.arrayBuffer()).byteLength;
    return bytes > 1000 ? { ok: true, bytes } : { ok: false, reason: "empty picture" };
  } catch (err) {
    return { ok: false, reason: err.name === "AbortError" ? "timed out" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// A short list of factory defaults worth trying when the owner does not know
// the password. This is the owner's own camera on the owner's own network —
// trying its default login is recovering access to a device you own, the same
// as pressing its reset button. Kept deliberately short: a long guessing list
// is neither faster nor more honest than a factory reset.
export const DEFAULT_CREDENTIALS = [
  { user: "admin", password: "" },
  { user: "admin", password: "admin" },
  { user: "admin", password: "admin12345" },
  { user: "admin", password: "12345" },
  { user: "admin", password: "123456" },
  { user: "admin", password: "password" },
];

// Once we know an address that responds, try each candidate login against just
// that one address, rather than re-walking every path per credential.
export async function tryDefaultCredentials(kind, url, candidates = DEFAULT_CREDENTIALS) {
  for (const cred of candidates) {
    const result = kind === "rtsp"
      ? await tryRtsp(url, cred.user, cred.password)
      : await trySnapshot(url, cred.user, cred.password);
    if (result.ok) return { ...cred, bytes: result.bytes };
  }
  return null;
}

// Try every known address for one device. Channels matter because a camera
// wired into a recorder answers on the recorder's address, one channel each.
//
// The stream paths need ffmpeg but the snapshot paths do not, so a missing
// ffmpeg must never end the search — for many cameras the snapshot works with
// nothing installed at all, and sending someone off to install software they
// do not need is the wrong answer.
export async function probeHost(host, { user, password, channels = [1], onTry = () => {} } = {}) {
  let ffmpegMissing = false;
  let authFailed = null;

  outer:
  for (const port of RTSP_PORTS) {
    if (!(await portOpen(host, port))) continue;
    for (const channel of channels) {
      for (const path of RTSP_PATHS) {
        const url = buildRtsp(host, port, path, channel);
        onTry("stream", url);
        const result = await tryRtsp(url, user, password);
        if (result.ok) return { kind: "rtsp", url, channel, bytes: result.bytes };
        if (result.reason === "ffmpeg-missing") { ffmpegMissing = true; break outer; }
        // Credentials are the same for every path, so stop rather than grind
        // through forty addresses that will all be refused.
        if (result.reason === "wrong username or password") {
          authFailed = { url, reason: result.reason, authKind: "rtsp" };
          break outer;
        }
      }
    }
  }

  for (const port of HTTP_PORTS) {
    if (!(await portOpen(host, port))) continue;
    for (const channel of channels) {
      for (const path of SNAPSHOT_PATHS) {
        const url = buildSnapshot(host, port, path, channel);
        onTry("snapshot", url);
        const result = await trySnapshot(url, user, password);
        if (result.ok) return { kind: "snapshot", url, channel, bytes: result.bytes };
        // A refusal is the likeliest failure of all, and deserves a better
        // message than "no address worked".
        if (/password/.test(result.reason) && !authFailed) {
          authFailed = { url, reason: result.reason, authKind: "snapshot" };
        }
      }
    }
  }

  if (authFailed) return { kind: "auth-failed", ...authFailed };
  return { kind: "none", ffmpegMissing };
}
