// Working out which models to actually use.
//
// config.json may name no model at all (the common case — nothing has been
// chosen yet) or name one that has since been removed. Resolving that has to
// happen in ONE place: the page and the background watcher both need the same
// answer, and when they disagree you get a watcher asking Ollama for a model
// called "".
import * as ollama from "./ollama.js";
import * as config from "./config.js";

const VISION_FAMILIES = ["clip", "mllama", "qwen2vl", "qwen25vl", "gemma3", "siglip"];
const VISION_NAMES = /vl|vision|llava|moondream|bakllava|minicpm-v|gemma3/i;

export const looksLikeVision = (model) =>
  (model.details?.families ?? []).some((f) => VISION_FAMILIES.includes(String(f).toLowerCase())) ||
  VISION_NAMES.test(model.name ?? "");

export async function listModels() {
  return (await ollama.tags())
    .map((m) => ({ name: m.name, size: m.size ?? 0, vision: looksLikeVision(m) }))
    .sort((a, b) => a.size - b.size);
}

// Default to the SMALLEST capable model installed, never the best one. A big
// model on a small machine does not run slowly — it exhausts memory and takes
// the whole machine down with it.
export function chooseModels(models, saved) {
  const vision = models.filter((m) => m.vision).sort((a, b) => a.size - b.size);
  const text = models.filter((m) => !m.vision).sort((a, b) => a.size - b.size);
  const installed = (name) => Boolean(name) && models.some((m) => m.name === name);
  return {
    visionModel: installed(saved.visionModel) ? saved.visionModel : vision[0]?.name ?? "",
    // The summariser never sees an image, so a small text model beats a big
    // vision one at it. Fall back to the vision model if that is all there is.
    summaryModel: installed(saved.summaryModel) ? saved.summaryModel : text[0]?.name ?? vision[0]?.name ?? "",
  };
}

// Ollama is on localhost and this is called often, so a short cache keeps the
// watcher from re-listing models every single look.
let cache = { at: 0, models: [] };
const CACHE_MS = 30_000;

export async function resolveSettings({ fresh = false } = {}) {
  const saved = config.load();
  try {
    if (fresh || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), models: await listModels() };
    }
    return { config: { ...saved, ...chooseModels(cache.models, saved) }, models: cache.models, ollamaUp: true };
  } catch {
    return { config: saved, models: [], ollamaUp: false };
  }
}
