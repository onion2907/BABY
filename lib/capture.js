// Getting one still picture out of whatever camera is configured.
//
// Home cameras speak RTSP, which browsers refuse to play, so for anything
// other than the laptop's own webcam the picture has to be fetched here
// rather than in the page. That is also what lets the watching carry on with
// no browser open at all.
import { spawn } from "node:child_process";

const FFMPEG_TIMEOUT_MS = 20_000;

function withCredentials(url, user, password) {
  if (!user || url.includes("@")) return url;
  try {
    const parsed = new URL(url);
    parsed.username = encodeURIComponent(user);
    parsed.password = encodeURIComponent(password ?? "");
    return parsed.toString();
  } catch {
    return url;
  }
}

// fetch() refuses any address carrying a username and password, so for the
// snapshot path the credentials have to be lifted out of the address and sent
// as a header instead. Accepts them either from the settings or already
// embedded in a pasted address.
function splitCredentials(url, user, password) {
  try {
    const parsed = new URL(url);
    const finalUser = decodeURIComponent(parsed.username || "") || user || "";
    const finalPassword = decodeURIComponent(parsed.password || "") || password || "";
    parsed.username = "";
    parsed.password = "";
    return { url: parsed.toString(), user: finalUser, password: finalPassword };
  } catch {
    return { url, user: user ?? "", password: password ?? "" };
  }
}

async function grabSnapshot(config) {
  if (!config.snapshotUrl) throw new Error("No snapshot address is set for the camera.");
  const { url, user, password } = splitCredentials(
    config.snapshotUrl, config.cameraUser, config.cameraPassword,
  );

  const headers = {};
  if (user) headers.Authorization = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FFMPEG_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 401) {
      // Many cameras use digest authentication, which fetch cannot do. The
      // video stream almost always accepts the same credentials, so say so.
      throw new Error(
        "the camera rejected the username and password. If they are definitely right, " +
        'this camera likely needs "digest" authentication — switch the source to "rtsp", ' +
        "which handles it.",
      );
    }
    if (!res.ok) throw new Error(`the camera answered ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) throw new Error("the camera returned an empty picture");
    return buffer.toString("base64");
  } finally {
    clearTimeout(timer);
  }
}

// One ffmpeg run per picture. A long-lived process would save a second or two
// per frame, but at one picture every thirty seconds that is not worth the
// reconnect logic a dropped stream would need — a fresh process is its own
// recovery.
function grabRtsp(config) {
  const url = withCredentials(config.rtspUrl, config.cameraUser, config.cameraPassword);
  if (!url) throw new Error("No video address is set for the camera.");

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-loglevel", "error",
      "-rtsp_transport", "tcp",   // UDP drops frames on wifi; TCP is slower but reliable
      "-i", url,
      "-frames:v", "1",
      "-an",
      "-q:v", "4",
      "-f", "image2",
      "-vcodec", "mjpeg",
      "pipe:1",
    ]);

    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error("the camera did not send a picture in time"));
    }, FFMPEG_TIMEOUT_MS);

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    ffmpeg.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(
        err.code === "ENOENT"
          ? "ffmpeg is not installed. Install it with:\n\nbrew install ffmpeg"
          : err.message,
      ));
    });

    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      const image = Buffer.concat(chunks);
      if (code === 0 && image.length > 1000) return resolve(image.toString("base64"));
      reject(new Error(stderr.trim().split("\n").pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

export async function grab(config) {
  if (config.source === "snapshot") return grabSnapshot(config);
  if (config.source === "rtsp") return grabRtsp(config);
  throw new Error(
    `The camera source is set to "${config.source}", which this cannot fetch on its own. ` +
    `Set it to "snapshot" or "rtsp" in config.json to watch without a browser open.`,
  );
}

export const canGrabWithoutBrowser = (config) =>
  config.source === "snapshot" || config.source === "rtsp";
