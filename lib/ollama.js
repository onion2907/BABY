// Every call to the local model lives here.
const OLLAMA = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 180_000);

export const FALLBACK_OBSERVE_PROMPT = "Describe this image.";

export const SUMMARY_SYSTEM =
  "You keep a running account of what a single fixed camera has been showing. " +
  "You are given the account you wrote last, plus the observations recorded since. " +
  "Rewrite the account so it reflects the whole session up to now.\n\n" +
  "Reply in exactly this shape:\n" +
  "NOW: one or two sentences on the current state of the scene.\n" +
  "SINCE: three to six bullets, each starting with a HH:MM:SS timestamp, covering " +
  "only things that changed - someone arriving or leaving, an activity starting or " +
  "stopping, an object appearing. Merge repeats: a person sitting still for ten " +
  "minutes is one bullet, not forty.\n\n" +
  "Be factual and terse. Never invent detail the observations do not contain.";

export function withTimeout(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export async function call(pathname, payload, signal) {
  const res = await fetch(`${OLLAMA}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Ollama ${pathname} returned ${res.status}: ${detail}`);
  }
  return res;
}

export async function tags() {
  const { signal, done } = withTimeout(5000);
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return (await res.json()).models ?? [];
  } finally {
    done();
  }
}

async function askOnce(model, prompt, image, signal) {
  const res = await call("/api/generate", {
    model,
    prompt,
    images: [image],
    stream: false,
    keep_alive: "15m",
    options: { temperature: 0.1, num_predict: 150 },
  }, signal);
  return ((await res.json()).response ?? "").trim();
}

// A blank answer is the signature failure of a small vision model given too
// long a prompt, so retry once with the shortest possible question before
// blaming anything else.
export async function describe(model, prompt, image) {
  const { signal, done } = withTimeout();
  try {
    let text = await askOnce(model, prompt, image, signal);
    let retried = false;
    if (!text) {
      retried = true;
      text = await askOnce(model, FALLBACK_OBSERVE_PROMPT, image, signal);
    }
    return { text, retried };
  } finally {
    done();
  }
}

export async function warmUp(model) {
  const { signal, done } = withTimeout();
  try {
    await call("/api/generate", { model, prompt: "", keep_alive: "15m" }, signal);
  } finally {
    done();
  }
}

// The vision model describes; a small text model turns that description into
// something a rule can act on. Two cheap specialists beat one model doing both
// jobs badly.
export async function classify(model, description) {
  const { signal, done } = withTimeout(60_000);
  try {
    const res = await call("/api/generate", {
      model,
      format: "json",
      stream: false,
      keep_alive: "15m",
      options: { temperature: 0 },
      prompt:
        `A camera watching a room produced this description:\n\n"${description}"\n\n` +
        `Answer only with JSON in this exact shape:\n` +
        `{"personVisible": true or false, "childVisible": true or false, "activity": "three or four words"}\n` +
        `Base it only on the description. If the description does not mention a person, personVisible is false.`,
    }, signal);
    const parsed = JSON.parse((await res.json()).response ?? "{}");
    return {
      personVisible: parsed.personVisible === true,
      childVisible: parsed.childVisible === true,
      activity: typeof parsed.activity === "string" ? parsed.activity.slice(0, 60) : "",
    };
  } catch {
    // Classification is a convenience, never a gate. A description that could
    // not be classified is still a diary entry.
    return null;
  } finally {
    done();
  }
}
