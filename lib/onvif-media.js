// Asking an ONVIF camera, over its own protocol, for the exact address of its
// video stream — instead of guessing at known URL patterns. This is the
// reliable path: the camera tells us the port and path itself.
import crypto from "node:crypto";

const MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl";
const DEVICE_NS = "http://www.onvif.org/ver10/device/wsdl";
const SCHEMA_NS = "http://www.onvif.org/ver10/schema";

// ONVIF authenticates with a WS-Security UsernameToken: a digest of a random
// nonce, a timestamp, and the password, so the password itself never crosses
// the network in the clear.
function securityHeader(user, password) {
  if (!user) return "";
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password ?? "")]))
    .digest("base64");
  return `<s:Header>
    <Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <UsernameToken>
        <Username>${user}</Username>
        <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>
        <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>
        <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>
      </UsernameToken>
    </Security>
  </s:Header>`;
}

async function soap(url, user, password, body, timeoutMs = 8000) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="${MEDIA_NS}" xmlns:tds="${DEVICE_NS}" xmlns:tt="${SCHEMA_NS}">
  ${securityHeader(user, password)}
  <s:Body>${body}</s:Body>
</s:Envelope>`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/soap+xml; charset=utf-8" },
      body: envelope,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok && !text.includes("Envelope")) throw new Error(`camera answered ${res.status}`);
    if (/NotAuthorized|auth.*fail|Sender.*not.*authorized/i.test(text)) {
      throw new Error("the camera rejected the username or password");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Camera XML escapes the stream URL (&amp; for the & between channel and
// subtype), so decode the handful of entities that appear in these values.
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

const between = (xml, tag) => {
  // Match <tt:Tag>...</tt:Tag> on the EXACT local name (ignoring prefix): a
  // loose match for "Uri" also hits "GetStreamUriResponse" and "MediaUri".
  const m = xml.match(new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9]+:)?${tag}\\s*>`, "i"));
  return m ? decodeEntities(m[1].trim()) : null;
};

// The media service can live at a different URL from the device service; ask,
// and fall back to swapping the path on the same host and port.
async function mediaUrl(deviceXaddr, user, password) {
  try {
    const xml = await soap(deviceXaddr, user, password,
      `<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>`);
    // The Media XAddr sits inside the <tt:Media> block.
    const media = xml.match(/<[^>]*Media[^>]*>([\s\S]*?)<\/[^>]*Media>/i)?.[1];
    const addr = media && between(media, "XAddr");
    if (addr) return addr;
  } catch { /* fall through to the guessed path */ }
  return deviceXaddr.replace(/device_service/i, "media_service");
}

// Returns the RTSP URL for the camera's first video profile, or throws with a
// message worth showing.
export async function getStreamUri(deviceXaddr, user, password) {
  const media = await mediaUrl(deviceXaddr, user, password);

  const profilesXml = await soap(media, user, password, `<trt:GetProfiles/>`);
  // Profile tokens appear as a token="…" attribute on each <trt:Profiles>.
  const token = profilesXml.match(/<[^>]*Profiles[^>]*\btoken="([^"]+)"/i)?.[1]
    ?? profilesXml.match(/\btoken="([^"]+)"/i)?.[1];
  if (!token) throw new Error("the camera did not return a video profile");

  const uriXml = await soap(media, user, password,
    `<trt:GetStreamUri>
      <trt:StreamSetup>
        <tt:Stream>RTP-Unicast</tt:Stream>
        <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
      </trt:StreamSetup>
      <trt:ProfileToken>${token}</trt:ProfileToken>
    </trt:GetStreamUri>`);

  const uri = between(uriXml, "Uri");
  if (!uri || !/^rtsp:/i.test(uri)) throw new Error("the camera did not return a stream address");
  return uri;
}
