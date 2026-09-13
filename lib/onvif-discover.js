// Finding ONVIF cameras the way ONVIF itself intends: WS-Discovery. The
// computer sends one small "who's there?" message to a multicast address every
// camera on the local network listens on, and each ONVIF device answers with
// where it can be reached. This finds a camera whatever port it serves on, so
// it succeeds where a fixed-port scan gives up — as long as the camera is on
// the same network segment as this computer (multicast does not cross a
// router, which is exactly the guest / IoT-network trap).
import dgram from "node:dgram";
import os from "node:os";

const MULTICAST_ADDR = "239.255.255.250";
const MULTICAST_PORT = 3702;

// A minimal WS-Discovery Probe for NetworkVideoTransmitter (an ONVIF camera).
function probeMessage() {
  const uuid = "urn:uuid:" + crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${uuid}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>`;
}

// The reply is a SOAP envelope with one or more XAddrs — the camera's service
// URLs. Read the host ONLY out of the XAddrs elements: the envelope is full of
// namespace URLs (w3.org, xmlsoap.org) that would otherwise be mistaken for
// devices and probed.
function extractHosts(xml) {
  const hosts = new Set();
  for (const block of xml.matchAll(/<[^>]*XAddrs[^>]*>([\s\S]*?)<\/[^>]*XAddrs>/gi)) {
    for (const match of block[1].matchAll(/https?:\/\/([^/\s:]+)(?::\d+)?/g)) {
      if (match[1] !== MULTICAST_ADDR && !match[1].startsWith("127.")) hosts.add(match[1]);
    }
  }
  return [...hosts];
}

// Send the probe out of every real network interface, because a laptop on both
// wifi and ethernet has more than one, and the camera is only reachable from
// the one on its network.
export function discover({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const hosts = new Set();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const message = Buffer.from(probeMessage());

    socket.on("message", (msg) => {
      for (const host of extractHosts(msg.toString())) hosts.add(host);
    });

    socket.on("error", () => { try { socket.close(); } catch {} resolve([]); });

    socket.bind(() => {
      try { socket.setBroadcast(true); } catch {}
      const addresses = [];
      for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
          if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
        }
      }
      // Bind the multicast send to each interface in turn and probe twice —
      // UDP is lossy and a single lost probe should not read as "no camera".
      const send = () => socket.send(message, MULTICAST_PORT, MULTICAST_ADDR, () => {});
      for (const address of addresses) {
        try { socket.setMulticastInterface(address); send(); } catch {}
      }
      send();
      setTimeout(send, 500);

      setTimeout(() => {
        try { socket.close(); } catch {}
        resolve([...hosts]);
      }, timeoutMs);
    });
  });
}
