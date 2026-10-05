import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "./types";
import { MAX_SHOT_SECONDS, MIN_SHOT_SECONDS } from "./types";
import { PROVIDERS, providerDef } from "./providers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, "..", "..");
/**
 * Runtime state lives in `data/` beside the app. H3_DATA_DIR overrides it so the
 * store regression check can exercise the real save/read code against a temp
 * directory instead of the director's live projects.
 */
export const DATA_DIR = process.env.H3_DATA_DIR
  ? path.resolve(process.env.H3_DATA_DIR)
  : path.join(APP_ROOT, "data");
export const LIBRARY_DIR = path.join(DATA_DIR, "library");
export const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
export const EXPORTS_DIR = path.join(DATA_DIR, "exports");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const IMAGES_DIR = path.join(DATA_DIR, "images");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export const DEFAULT_SETTINGS: AppSettings = {
  comfyUrl: "http://127.0.0.1:8188",
  comfyRoot: "",
  purgeBetweenShots: false,
  port: 8788,
  // Generous but finite: a hung ComfyUI must not hold the queue forever. Raise these in
  // Settings for slow 2K / long shots instead of losing the render to a fixed timeout.
  renderTimeoutMin: 25,
  imageTimeoutMin: 20,
  ollamaUrl: "http://localhost:11434",
  director: { provider: "ollama", model: "qwen3:8b" },
  keys: {},
};

export function ensureDirs() {
  for (const d of [DATA_DIR, LIBRARY_DIR, OUTPUTS_DIR, EXPORTS_DIR, CACHE_DIR, IMAGES_DIR, LOGS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export const LOGS_DIR = path.join(DATA_DIR, "logs");

/**
 * Append one line to a job's log file.
 *
 * Everything the pipeline reported about a render used to exist only as
 * WebSocket messages to whichever browser happened to be open, so a failure was
 * undiagnosable once the tab closed or the process restarted. This is the
 * durable record: one JSONL line per event, per job, timestamped.
 */
export function appendJobLog(jobId: string, level: string, message: string, extra?: Record<string, unknown>) {
  try {
    const safe = String(jobId).replace(/[^a-zA-Z0-9_-]/g, "") || "job";
    fs.appendFileSync(
      path.join(LOGS_DIR, `${safe}.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), level, message, ...(extra ?? {}) }) + "\n",
      "utf8",
    );
  } catch (e) {
    // Logging must never be able to fail a render.
    console.error(`[logs] could not write the job log: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Seed default base URLs for catalog providers and migrate the old single-LLM format. */
function normalize(s: Partial<AppSettings>): AppSettings {
  const out: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...s,
    director: { ...DEFAULT_SETTINGS.director, ...(s.director ?? {}) },
    keys: {},
  };
  const legacyLlm = (s as unknown as { llm?: { baseUrl?: string; model?: string; apiKey?: string } }).llm;
  // per-provider stored entries
  const rawKeys = (s.keys ?? {}) as Record<string, { baseUrl?: string; key?: string; model?: string }>;
  for (const def of PROVIDERS) {
    if (def.id === "ollama") continue;
    const existing = rawKeys[def.id];
    out.keys[def.id] = {
      baseUrl: existing?.baseUrl || def.baseUrl,
      key: existing?.key ?? "",
      model: existing?.model ?? "",
    };
  }
  // One-shot migration of the legacy single-LLM block (pre-multi-provider app
  // versions) into the custom provider. Only when the user has not already
  // picked a provider, so it can never override a later choice on reload.
  if (!s.director?.provider && legacyLlm && legacyLlm.baseUrl) {
    out.keys.custom = {
      baseUrl: legacyLlm.baseUrl,
      key: legacyLlm.apiKey ?? "",
      model: legacyLlm.model ?? "",
    };
    out.director = { provider: "custom", model: legacyLlm.model || "" };
  }
  if (!out.director.provider) out.director.provider = "ollama";
  return out;
}

export function loadSettings(): AppSettings {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) return normalize({});
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return normalize(raw);
  } catch {
    return normalize({});
  }
}

export function saveSettings(s: AppSettings) {
  ensureDirs();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
}

export interface PublicKeyMeta {
  id: string;
  label: string;
  baseUrl: string;
  configured: boolean;
  envVar: string;
  last4: string;
  model: string;
}

/** Settings without any API key material (safe for the browser). */
export function publicSettings(s: AppSettings) {
  const keys: Record<string, PublicKeyMeta> = {};
  for (const def of PROVIDERS) {
    if (def.id === "ollama") continue;
    const entry = s.keys[def.id];
    const key = entry?.key ?? "";
    keys[def.id] = {
      id: def.id,
      label: def.label,
      baseUrl: entry?.baseUrl || def.baseUrl,
      configured: !!key || (!!def.envVar && !!process.env[def.envVar]),
      envVar: def.envVar,
      last4: key ? key.slice(-4) : "",
      model: entry?.model ?? "",
    };
  }
  return {
    comfyUrl: s.comfyUrl,
    comfyRoot: s.comfyRoot,
    purgeBetweenShots: s.purgeBetweenShots,
    port: s.port,
    ollamaUrl: s.ollamaUrl,
    renderTimeoutMin: s.renderTimeoutMin,
    imageTimeoutMin: s.imageTimeoutMin,
    director: s.director,
    // The engine's real limits, sent to the UI so the timeline's drag handle and
    // tooltips can never disagree with what the renderer will actually accept.
    limits: { maxShotSeconds: MAX_SHOT_SECONDS, minShotSeconds: MIN_SHOT_SECONDS },
    keys,
  };
}

export function providerMetaFor(id: string, s: AppSettings) {
  const def = providerDef(id);
  const entry = s.keys[id];
  const key = entry?.key ?? "";
  return {
    id,
    label: def?.label ?? id,
    baseUrl: entry?.baseUrl || def?.baseUrl || "",
    configured: !!key || (!!def?.envVar && !!process.env[def.envVar]),
    envVar: def?.envVar ?? "",
    last4: key ? key.slice(-4) : "",
    model: entry?.model ?? "",
  };
}
