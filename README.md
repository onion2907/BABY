# camera-watch

A written diary of what a camera sees, kept by a vision model running on your
own machine. It describes the room every so often, folds those descriptions
into a rolling summary, and saves the lot to disk so a day can be read back.

**This is a diary, not a safety alarm.** A small model glancing at a still
picture every half-minute cannot be relied on to catch anything dangerous —
those things happen in seconds, often look like nothing in a photograph, and it
has no sound at all. "Everything looks fine" from this program is not evidence
that everything is fine. Keep a real monitor.

Everything stays local. Pictures go from the camera to a small server on your
machine, from there to Ollama on the same machine, and the text comes back the
same way. No account, no API key, nothing leaves the house.

```
camera ──► server ──► vision model ──► description ──► text model ──► summary
             │                                │                          │
       latest picture                    saved to disk            shown in the page
```

## Requirements

- Node 18 or newer (uses built-in `fetch` — no npm dependencies at all)
- [Ollama](https://ollama.com) with a vision model and a small text model
- `ffmpeg`, but only for cameras that provide a video stream (`brew install ffmpeg`)

## Setup

```bash
ollama pull moondream        # the eyes — ~1.7GB, runs on a modest laptop
ollama pull llama3.2:3b      # the writer — ~2GB, for readable summaries
npm start
```

Open **http://localhost:8080**, expand **Camera and model settings**, and choose
where pictures should come from.

Start with `moondream` even if your machine could run more. A 7B vision model
holds ~6GB of memory open, and on an 8GB or 16GB machine that does not run
slowly — it exhausts memory and drags the whole system down.

## The three camera sources

| Source | Needs | Watching runs |
|---|---|---|
| **This laptop's own camera** | nothing | only while the page is open |
| **Still-picture address** | the camera's snapshot URL | in the background, no browser needed |
| **Video stream** | `ffmpeg`, the camera's RTSP URL | in the background, no browser needed |

The laptop webcam has to be captured by the browser, because that is the only
thing with access to it — so closing the tab stops the watching. Both home
camera options are fetched by the server instead, which is what lets the diary
keep running unattended.

**Snapshot vs stream.** A snapshot address needs no extra software and is the
easier of the two, but many cameras protect it with digest authentication,
which this cannot do — you get a clear message saying so. The video stream
handles any authentication the camera uses, at the cost of installing `ffmpeg`.
Try snapshot first; fall back to stream.

Credentials live in `config.json` on your machine. They are never sent back to
the page, never written to the diary, and are stripped out of any address shown
on screen.

## What gets saved

One file per day under `data/`, as plain text lines — readable in any text
editor, with or without this program:

```
data/2026-09-13.jsonl
```

Each line is one event: a look (with its description and a short activity
label), a summary, a nudge, or the watching starting and stopping. Nothing is
ever overwritten.

## Nudges

Only one is on by default, because it is the only one that is reliable:

- **The camera stopped answering.** Raised after a few failures in a row,
  recorded in the diary, and raised once — not once per attempt.

There is a second, off by default: **nobody visible for N minutes**. Leave it
off until you have watched a full day of real descriptions from your own
camera, including at night. Tuning it blind produces a program that nudges
constantly and gets ignored, which is worse than no nudge at all.

## Reading it from a phone

The server listens on your whole home network, so any phone on the same wifi
can open `http://<your computer's address>:8080`. On a Mac, find the address in
System Settings → Wi-Fi → Details → IP Address.

**There is no login.** That is fine on a home network you control. Never
forward this port to the internet — it would put a live camera and your child's
day on the public web. To read it from outside the house, use something like
Tailscale, which connects your phone privately to your own machine rather than
opening anything up.

## How it works

**Two models, two jobs.** The vision model only describes a single picture. A
small text model then turns that description into something a rule can act on,
and writes the rolling summary. Two cheap specialists beat one model doing both
jobs badly — ask a vision model to summarise and it parrots its input back.

**The summary accumulates.** Each update is given the previous summary plus the
descriptions recorded since, so the account grows across the day instead of
resetting. It is stored with the day's diary.

**Regular sampling, not motion triggers.** A diary wants an even record of the
day, so pictures are taken on a fixed cadence. Earlier versions gated on motion,
which suits a live monitor and produces a diary full of holes.

**Keep the question short.** The observation prompt defaults to one sentence
because small vision models are templated as `Question: … Answer:` and return an
*empty string* when handed a paragraph of rules. They do not error — they answer
with nothing. The server retries once with the shortest possible question and
reports a blank plainly if that fails too.

**One picture at a time.** Nothing is queued. If a look is still running when
the next is due, the next is skipped, so an overloaded machine falls behind
gracefully rather than accumulating work it cannot finish.

## Night vision

Cameras switch to infrared in the dark: grey, flat, no colour. These models are
noticeably worse at reading those pictures, and small ones especially so. Expect
the night diary to be vaguer than the day one, and test it before relying on it.

## Tuning

| Symptom | Try |
|---|---|
| Whole machine slows or freezes | The model is too big. Switch to `moondream`. |
| Descriptions are blank, timings look normal | The question is too long. Shorten it to one plain sentence. |
| Summary is just a row of timestamps | A vision model is writing it. Install `llama3.2:3b` and pick it as the summary model. |
| "the camera rejected the username and password" | The camera wants digest auth. Switch the source to the video stream. |
| "ffmpeg is not installed" | `brew install ffmpeg` |
| Diary too sparse / too repetitive | Change how often it looks, in the settings |

## Layout

```
server.js           the local server and its endpoints
lib/config.js       settings file, and keeping credentials out of the page
lib/capture.js      getting one picture out of a webcam, snapshot URL or RTSP stream
lib/store.js        the diary on disk, one file per day
lib/ollama.js       every call to the local model
lib/watcher.js      the background loop that survives the browser closing
public/             the page
```

## Limits worth knowing

- It describes, it does not track. There is no identity across pictures — "a
  person" in two entries may or may not be the same person.
- Timestamps come from the computer's clock at capture time, not the model.
- No sound at all.
- Descriptions are frequently wrong in detail. Treat the diary as a rough record
  of the shape of a day, not as a transcript.
