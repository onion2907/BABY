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
ollama pull moondream        # the eyes — ~1.7GB, runs on a modest laptop
ollama pull llama3.2:3b      # the writer — ~2GB, for readable summaries
npm start
```

Then open **http://localhost:8080**. It has to be `localhost` — browsers only
hand over the camera on a secure origin, and plain `http://` to a LAN IP is not
one. Grant camera access when prompted, then press **Look once** before
**Start watching**: it takes a single picture and describes it, which tells you
in one step whether the model is a workable size for your machine.

Start with `moondream` even if your machine could run more. A 7B vision model
holds ~6GB of memory open, and on an 8GB or 16GB laptop that does not run
slowly — it exhausts memory and drags the whole system down. Trade up only
after `moondream` is working, and watch the seconds-per-look figure on the
feed as you do.

### Configuration

All optional, all via environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port for the local UI |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama is listening |
| `VISION_MODEL` | smallest installed | Model that looks at frames |
| `SUMMARY_MODEL` | smallest text-only installed | Model that writes the rolling summary |
| `REQUEST_TIMEOUT_MS` | `180000` | How long to wait on a slow model |

There is deliberately no hard-coded default model. The server asks Ollama what
is installed and picks the **smallest** capable one, with its size shown beside
it, so the first run works rather than impresses. The dropdowns in the page
list only models you have already pulled — to offer a different one, pull it in
a terminal and reload.

### Which model to pull

| Model | Size | Notes |
|---|---|---|
| `moondream` | ~1.7GB | Start here. Fastest, terse, occasionally wrong. Works on a CPU-only machine. |
| `llava:7b` | ~4.7GB | Older, widely available, adequate. |
| `qwen2.5vl:7b` | ~6GB | Best quality-per-GB, but only on a machine with memory to spare. |
| `qwen2.5vl:32b` | ~21GB | Noticeably better at actions and object detail, if you have the VRAM. |

The summariser only ever sees text, never images, so a plain text model
(`llama3.2:3b`) is both faster and far better at it than a vision model. Ask a
vision model to summarise and it tends to parrot its input back — bare
timestamps with no prose. The page warns you if that is the setup you are on.

**Keep the question short.** The observation prompt defaults to one sentence
for a reason: small vision models are templated as `Question: … Answer:` and
return an *empty string* when handed a paragraph of rules and prohibitions.
They do not error — they answer with nothing. The server retries once with the
shortest possible question and reports a blank answer plainly if that fails
too, but the fix is a shorter question, not a retry. A 7B model tolerates a
long prompt; a 1.8B one does not.

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

**It stops itself.** Two consecutive looks over 45 seconds means the chosen
model does not fit this machine, so watching halts and the page names a lighter
model you already have. A model that is merely slower than the look interval
just widens the interval to match. Without this, an oversized model does not
degrade — it swaps the machine to a standstill.

## Tuning

| Symptom | Try |
|---|---|
| Descriptions are blank, timings look normal | The question is too long for the model. Shorten it to one plain sentence. |
| Summary is just a row of timestamps | A vision model is writing it. Install `llama3.2:3b` and pick it as the summary model. |
| Whole machine slows or freezes | The model is too big. Switch to `moondream` and reduce picture size. |
| Summary lags far behind reality | Smaller picture size, a smaller model, or a longer look interval |
| Log full of near-identical lines | Move "Which frames to send" *down* the list |
| Nothing is ever logged | Move "Which frames to send" *up* the list; watch the `change` badge on the feed |
| Descriptions are vague or invented | Bigger vision model, if the machine can take it; tighten the prompt |
| Summary ignores the NOW/SINCE format | Use a dedicated text model for the summary — small vision models follow format poorly |

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
