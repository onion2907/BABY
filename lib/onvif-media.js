// Asking an ONVIF camera, over its own protocol, for the exact address of its
// video stream — instead of guessing at known URL patterns.
//
// Two things make real cameras refuse a correct password, and both are handled
// here:
//
//   * The clock. WS-Security signs a timestamp, and a camera whose clock has
//     drifted rejects the signature as stale. ONVIF requires GetSystemDateAndTime
//     to answer WITHOUT authentication precisely so a client can learn the
//     camera's own time first, so that is what we sign with.
//   * The scheme. Firmwares vary: some want a hashed password in the SOAP
//     header, some want it in plain text there, some want ordinary HTTP auth,
//     and some want none at all. We try them in turn rather than assuming.
import crypto from "node:crypto";

const MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl";
const DEVICE_NS = "http://www.onvif.org/ver10/device/wsdl";
const SCHEMA_NS = "http://www.onvif.org/ver10/schema";
const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";

// Every authentication style worth trying, in the order most likely to work.
export const AUTH_MODES = ["digest", "text", "basic", "none"];

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Match <tt:Tag>...</tt:Tag> on the EXACT local name (ignoring prefix): a loose
// match for "Uri" also hits "GetStreamUriResponse" and "MediaUri", which wraps
// the real answer and would return markup instead of the URL.
function between(xml, tag) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9]+:)?${tag}\\s*>`, "i");
  const m = xml.match(re);
  return m ? decodeEntities(m[1].trim()) : null;
}

const isFault = (xml) => /<[^>]*Fault\b/i.test(xml);

const isAuthFault = (xml) =>
  /NotAuthorized|Unauthorized|auth.*fail|not.*authorized|InvalidUsername|password/i.test(xml);

// Pull something human out of a SOAP fault instead of a bare status code.
function faultReason(xml) {
  const text = between(xml, "Text") ?? between(xml, "Reason") ?? between(xml, "faultstring");
  const code = xml.match(/<[^>]*Value[^>]*>([^<]*(?:ter:|env:)[^<]*)<\//i)?.[1];
  return (text || code || "the camera refused the request").replace(/\s+/g, " ").trim().slice(0, 160);
}

function securityHeader(mode, user, password, clockOffsetMs) {
  if (mode === "none" || mode === "basic" || !user) return "";
  const created = new Date(Date.now() + clockOffsetMs).toISOString();

  if (mode === "text") {
    return `<s:Header><Security s:mustUnderstand="1" xmlns="${WSSE_NS}"><UsernameToken>
      <Username>${user}</Username>
      <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${password ?? ""}</Password>
      <Created xmlns="${WSU_NS}">${created}</Created>
    </UsernameToken></Security></s:Header>`;
  }

  const nonce = crypto.randomBytes(16);
  const digest = crypto.createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password ?? "")]))
    .digest("base64");
  return `<s:Header><Security s:mustUnderstand="1" xmlns="${WSSE_NS}"><UsernameToken>
    <Username>${user}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>
    <Created xmlns="${WSU_NS}">${created}</Created>
  </UsernameToken></Security></s:Header>`;
}

async function soap(url, body, { mode = "none", user, password, clockOffsetMs = 0, timeoutMs = 8000 } = {}) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="${MEDIA_NS}" xmlns:tds="${DEVICE_NS}" xmlns:tt="${SCHEMA_NS}">
  ${securityHeader(mode, user, password, clockOffsetMs)}
  <s:Body>${body}</s:Body>
</s:Envelope>`;

  const headers = { "Content-Type": "application/soap+xml; charset=utf-8" };
  if (mode === "basic" && user) {
    headers.Authorization = "Basic " + Buffer.from(`${user}:${password ?? ""}`).toString("base64");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body: envelope, signal: controller.signal });
    const text = await res.text();
    if (!text.includes("Envelope")) throw new Error(`the camera answered ${res.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ONVIF requires this to answer unauthenticated, so it doubles as a reachability
// check and as the way to learn the camera's clock.
export async function getClockOffsetMs(deviceXaddr) {
  const xml = await soap(deviceXaddr, `<tds:GetSystemDateAndTime/>`, { timeoutMs: 6000 });
  const utc = xml.match(/<[^>]*UTCDateTime[^>]*>([\s\S]*?)<\/[^>]*UTCDateTime>/i)?.[1];
  if (!utc) return 0;
  const num = (tag) => Number(between(utc, tag));
  const [y, mo, d, h, mi, sec] =
    ["Year", "Month", "Day", "Hour", "Minute", "Second"].map(num);
  if (![y, mo, d].every(Number.isFinite) || !y) return 0;
  const cameraMs = Date.UTC(y, mo - 1, d, h || 0, mi || 0, sec || 0);
  return cameraMs - Date.now();
}

// The media service can live at a different URL from the device service.
async function mediaUrl(deviceXaddr, auth) {
  try {
    const xml = await soap(deviceXaddr,
      `<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>`, auth);
    const media = xml.match(/<[^>]*Media[^>]*>([\s\S]*?)<\/[^>]*Media>/i)?.[1];
    const addr = media && between(media, "XAddr");
    if (addr) return addr;
  } catch { /* fall through to the conventional path */ }
  return deviceXaddr.replace(/device_service/i, "media_service");
}

// Work out which authentication style this firmware actually accepts, by
// asking for the video profiles — the first call that genuinely needs auth.
async function resolveAuth(deviceXaddr, user, password, clockOffsetMs, onNote) {
  let lastReason = "no response";
  for (const mode of AUTH_MODES) {
    const auth = { mode, user, password, clockOffsetMs };
    try {
      const url = await mediaUrl(deviceXaddr, auth);
      const xml = await soap(url, `<trt:GetProfiles/>`, auth);
      if (isFault(xml)) {
        lastReason = faultReason(xml);
        if (!isAuthFault(xml)) throw new Error(lastReason);
        continue;
      }
      const token = xml.match(/<[^>]*Profiles[^>]*\btoken="([^"]+)"/i)?.[1]
        ?? xml.match(/\btoken="([^"]+)"/i)?.[1];
      if (!token) { lastReason = "the camera returned no video profile"; continue; }
      onNote?.(`Authentication accepted (${mode === "none" ? "no password needed" : mode}).`);
      return { auth, url, token };
    } catch (err) {
      lastReason = err.message;
    }
  }
  throw new Error(lastReason);
}

// Returns the RTSP URL for the camera's first video profile.
export async function getStreamUri(deviceXaddr, user, password, { onNote } = {}) {
  let clockOffsetMs = 0;
  try {
    clockOffsetMs = await getClockOffsetMs(deviceXaddr);
    const driftMin = Math.round(Math.abs(clockOffsetMs) / 60000);
    if (driftMin >= 2) {
      onNote?.(`The camera's clock is about ${driftMin} minutes ${clockOffsetMs > 0 ? "ahead of" : "behind"} this computer — signing with the camera's time.`);
    }
  } catch {
    onNote?.("The camera did not report its clock; using this computer's time.");
  }

  const { auth, url, token } = await resolveAuth(deviceXaddr, user, password, clockOffsetMs, onNote);

  const uriXml = await soap(url,
    `<trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${token}</trt:ProfileToken>
    </trt:GetStreamUri>`, auth);

  if (isFault(uriXml)) throw new Error(faultReason(uriXml));
  const uri = between(uriXml, "Uri");
  if (!uri || !/^rtsp:/i.test(uri)) throw new Error("the camera did not return a stream address");
  return uri;
}
