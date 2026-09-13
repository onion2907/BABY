// Known stream and snapshot addresses, in the order worth trying.
//
// CP Plus is rebadged Dahua, so the Dahua patterns come first. A camera wired
// into a recorder box answers on the recorder's address with a channel number,
// which is why the channel is a parameter rather than baked in.

export const RTSP_PATHS = [
  // Dahua / CP Plus. subtype=1 is the low-resolution sub-stream: far lighter
  // on both the network and the model, and we shrink the picture anyway.
  "/cam/realmonitor?channel={ch}&subtype=1",
  "/cam/realmonitor?channel={ch}&subtype=0",
  // Hikvision, in case the badge is misleading
  "/Streaming/Channels/{ch}02",
  "/Streaming/Channels/{ch}01",
  "/h264/ch{ch}/sub/av_stream",
  // Generic firmwares
  "/live/ch{ch}",
  "/live",
  "/stream{ch}",
  "/11",
  "/video{ch}",
  "/onvif{ch}",
];

export const SNAPSHOT_PATHS = [
  "/cgi-bin/snapshot.cgi?channel={ch}",
  "/cgi-bin/snapshot.cgi",
  "/onvif/snapshot",
  "/snapshot.jpg",
  "/image/jpeg.cgi",
];

export const RTSP_PORTS = [554, 8554];
export const HTTP_PORTS = [80, 8000, 8080];

export const buildRtsp = (host, port, path, channel) =>
  `rtsp://${host}:${port}${path.replace(/\{ch\}/g, String(channel))}`;

export const buildSnapshot = (host, port, path, channel) =>
  `http://${host}:${port}${path.replace(/\{ch\}/g, String(channel))}`;
