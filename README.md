# camera-watch

Point your laptop camera at something, and a vision model running on your own
machine describes what it sees in a pane beside the live feed.

Everything stays local. Frames go from the browser to a small Node server on
`localhost`, from there to Ollama on `localhost`, and the text comes back the
same way. No API key, no account, nothing leaves the machine.

```
camera ──► <video> ──► canvas ──► motion gate ──► Node server ──► Ollama
                │                                                    │
          live preview                summary pane ◄── SSE stream ◄───┘
```

## Requirements

- Node 18 or newer (uses built-in `fetch` — no npm dependencies at all)
- [Ollama](https://ollama.com) with a vision model pulled

## Setup

```bash
ollama pull qwen2.5vl:7b     # the eyes — needs ~6GB VRAM
ollama pull llama3.1:8b      # optional: a text model for the summaries
npm start
```

Then open **http://localhost:8080**. It has to be `localhost` — browsers only
hand over the camera on a secure origin, and plain `http://` to a LAN IP is not
one. Grant camera access when prompted and press **Start watching**.

### Configuration

All optional, all via environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port for the local UI |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is listening |
| `VISION_MODEL` | `qwen2.5vl:7b` | Model that looks at frames |
| `SUMMARY_MODEL` | same as vision | Model that writes the rolling summary |
| `REQUEST_TIMEOUT_MS` | `180000` | How long to wait on a slow model |

Both models can also be switched from the dropdowns in the page — it lists
whatever `ollama list` shows.

### Which model to pull

| Model | Size | Notes |
|---|---|---|
| `moondream` | ~1.7GB | Fastest. Terse, sometimes wrong. Fine on a CPU-only machine. |
| `llava:7b` | ~4.7GB | Older, widely available, adequate. |
| `qwen2.5vl:7b` | ~6GB | The default. Best quality-per-GB for scene description. |
| `qwen2.5vl:32b` | ~21GB | Noticeably better at actions and object detail, if you have the VRAM. |

The summariser only ever sees text, never images, so a plain text model
(`llama3.1:8b`) is both faster and better at it than a vision model.

## How it works

**Two tiers.** Per-frame captions on their own are unreadable noise — "a person
sitting at a desk" a thousand times over. So each frame gets one short
observation, and every few observations a second call folds them into a rolling
account: what is happening now, plus a timestamped list of what changed. That
account is fed back in as context on the next update, so it accumulates across
the whole session instead of resetting.

**The motion gate.** Sending every frame to a local model is pointless — it
can't keep up, and a still room produces a thousand identical captions. Each
candidate frame is downscaled to 64×48 grayscale and compared against the last
frame that was *actually sent*; if the mean per-pixel difference is under the
threshold, the frame is skipped. Comparing against the last sent frame rather
than the last captured one means a slow drift still eventually trips it. A
frame is forced through every 90 seconds regardless, so a long quiet stretch
still leaves a trace.

Raise **motion sensitivity** if a noisy sensor keeps triggering on an empty
room; drop it to 0 to send every frame.

**One at a time.** A local vision model takes seconds per frame. The loop never
has more than one request in flight — if the model is still thinking when the
next tick comes round, that tick is skipped rather than queued. Otherwise you
end up watching a summary of what happened two minutes ago.

## Tuning

| Symptom | Try |
|---|---|
| Summary lags far behind reality | Smaller frame width, a smaller model, or a longer look interval |
| Log full of near-identical lines | Raise motion sensitivity |
| Nothing is ever logged | Lower motion sensitivity; check the motion badge on the feed |
| Descriptions are vague or invented | Bigger vision model; tighten the observation prompt |
| Summary ignores the NOW/SINCE format | Use a dedicated text model for the summary — small VLMs follow format poorly |

The observation prompt is editable in the page (under **Observation prompt**)
and takes effect on the next frame, so you can aim it at whatever you actually
care about — "note only whether anyone enters or leaves", say.

## Layout

```
server.js           local HTTP server; serves the page, proxies to Ollama
public/index.html   the page
public/app.js       camera capture, motion gate, watch loop, rendering
public/styles.css   styling
```

## Limits worth knowing

- It describes, it does not track. There is no identity across frames — "a
  person" in two observations may or may not be the same person.
- Timestamps come from the browser clock at capture time, not from the model.
- The log keeps the last 300 entries in the DOM and nothing on disk. Close the
  tab and the session is gone.
- The server binds to `127.0.0.1` only, so nothing on your network can reach it.
