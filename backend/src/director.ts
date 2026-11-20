// AI co-director: talks to any OpenAI-compatible local endpoint (LM Studio / Ollama)
// and returns a structured shot list that drops straight into the timeline.

import type { LibraryAsset, Shot, Project } from "./types";

export interface AiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface DraftShot {
  name: string;
  kind: "t2v" | "i2v" | "fl2v" | "r2v";
  prompt: string;
  seconds: number;
  usesAssets: string[]; // names (case-insensitive) of library assets to attach
  note?: string;
}

export interface DirectResult {
  shots: DraftShot[];
  raw: string;
  warnings: string[];
}

const SYSTEM = `You are the AI co-director of a MiniMax H3 video project. H3 is an omni-modal model: it generates video AND synchronized audio (dialogue, SFX, music) in one pass from a single structured text prompt plus optional reference media.

Your job: turn the user's brief into a concrete shot list. Reply with a single JSON object of the form {"shots": [ ... ]} (one element per shot). No prose, no markdown fences, no trailing commas. Each element:

{
  "name": "Short title for the shot",
  "kind": "t2v | i2v | fl2v | r2v",
  "prompt": "One dense paragraph (English) describing exactly what happens in THIS shot, with camera and audio",
  "seconds": 4..12,
  "usesAssets": ["exact asset names from the roster you want attached"],
  "note": "optional directing note shown in the app"
}

Rules:
- t2v = pure text. i2v = start from a still image (first frame). fl2v = first AND last frame pinned. r2v = character/location/voice references.
- An r2v shot needs at least one image (or video) asset; a voice/audio asset can ONLY be used on an r2v shot and requires a face/reference image too. Choose kinds accordingly.
- Prompt writing for H3:
  * Always state the subject, the action, and the environment. Do NOT describe a reference image's details as if generating them - if an asset is attached, say "the person/place from the reference" and only add NEW detail.
  * Camera language: shot size (wide/medium/close-up/extreme close-up), lens feel, and movement (static, handheld, dolly in/out, pan, tilt, crane, tracking) with a feel word (slow push-in, fast whip pan...).
  * When a character asset is attached and speaks, write the line in quotation marks with the speaker:  Maria says: "..." with emotion markers. Keep dialogue short and natural.
  * Mention lighting, palette and time of day only when it changes the meaning.
  * Describe sound design words when relevant (footsteps echo, crowd murmur) - H3 generates the soundtrack.
- Keep each shot visually coherent and write for continuity when asked: describe what carries over between shots (pose, framing, location, character position).
- seconds: 5 is a good default; use up to 8-10 for slow scenes, 4 for quick inserts.
- Do not invent asset names - only reference names present in the roster below (match by the part before the extension too).`;

function buildUserMsg(brief: string, extra: string, roster: string): string {
  let out = `Available assets (name — role):\n${roster}\n\nDirector brief:\n${brief}`;
  if (extra.trim()) out += `\n\nAdditional context:\n${extra}`;
  out +=
    "\n\nReturn only the JSON object \"{\"shots\": [...]}\". Use exactly the asset names from the roster when you need media.";
  return out;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("The model response did not contain a JSON shot list.");
}

export async function listModels(cfg: AiConfig): Promise<string[]> {
  const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`LLM endpoint /models returned ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ id?: string }> };
  return (j.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** Ask the co-director to turn a brief into a shot list. */
export async function directShots(
  cfg: AiConfig,
  brief: string,
  extra: string,
  assets: LibraryAsset[],
): Promise<DirectResult> {
  const roster = assets
    .map((a) => `${a.name} — ${a.role || a.kind}`)
    .join("\n");
  const messages = [
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content: buildUserMsg(brief, extra, roster) },
  ];
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0.7,
    max_tokens: 4000,
    stream: false,
  };
  try {
    body.response_format = { type: "json_object" };
  } catch {
    /* older servers reject this key - omit below if 400 */
  }
  let raw: string;
  try {
    let res = await postChat(cfg, body);
    if (res.status === 400 && body.response_format) {
      // older servers reject response_format - retry without it
      delete body.response_format;
      res = await postChat(cfg, body);
    }
    if (res.status !== 200) throw chatError(res.status, res.text);
    raw = extractChatContent(res.text);
  } catch (e) {
    throw new Error(`AI co-director request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText) as unknown;
  // Accept three shapes: a plain array, an object wrapping a shots array
  // (e.g. {"shots": [...]}), or a lone shot object (some models collapse a
  // one-element list into a single object under forced-json modes).
  let arr: unknown[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr && parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    arr = Array.isArray(obj.shots) ? (obj.shots as unknown[]) : null;
    if (!arr) {
      const nested = Object.values(obj).find((v) => Array.isArray(v));
      arr = (nested as unknown[] | undefined) ?? null;
    }
    if (!arr && looksLikeShot(obj)) arr = [obj];
  }
  if (!arr) {
    throw new Error(`LLM response was valid JSON but not a shot list. Response started with: ${jsonText.slice(0, 160)}`);
  }

  const warnings: string[] = [];
  const shots: DraftShot[] = arr.map((el) => normalizeDraft(el as Record<string, unknown>, assets, warnings));
  return { shots, raw, warnings };
}

// ---------------------------------------------------------------------------
// Prompt structuring: reorganize a raw prompt into the four fixed H3 sections
// ---------------------------------------------------------------------------

export interface StructureResult {
  structured: string;
  raw: string;
  unchanged: boolean;
}

const STRUCTURE_SYSTEM = `You are a co-director for MiniMax H3, a video model that generates video AND synchronized audio in one pass. Transform the given idea into a shoot-ready, four-section H3 prompt that is RICH, CONCRETE and CINEMATIC. The input may be as short as one sentence — you are expected to EXPAND it into full production detail, the way a director's shot brief reads.

Required output, in this order, nothing before or after:

[Subject + Action]
80-160 words. Describe the shot chronologically ("The video begins with… As… Then… Finally…"). Name every character with a concrete visual descriptor (build, wardrobe, distinguishing features) and describe their exact actions, body language and facial expressions beat by beat — including what the background keeps doing while the foreground acts. Keep every spoken line verbatim in quotation marks.

[Camera Movement]
50-120 words. Shot size plus one or more NAMED camera techniques (rack focus, dolly track, lateral truck, slow push-in, handheld drift, crane rise, whip pan…). Describe the movement arc from first frame to last — where the frame starts, how it travels, where it ends, what moves in or out of focus — and one clause on what the movement communicates (power, intimacy, chaos…).

[Environment & FX]
60-140 words. The location in sensory detail: light sources and their exact colors, shadow behavior, time of day, atmosphere (volumetric haze, dust, sparks, rain), reflections and materials, and the implied sound design behind the action (a low rhythmic thrum pulsing in sync with sparks, footsteps on tile, a door sealing shut). Call out visual/energy contrasts in the frame (still foreground vs frantic background, dark room vs shattered glowing screen). Sound words here describe ambience and effects only — never dialogue.

[Style & Technical]
50-110 words. The render style by name (photorealistic, high-end 3D caricature, claymation, anime cel-shading…), capture spec (24fps cinematic capture, HDR, shallow depth of field), where extreme detail matters (wood grain, fabric weave, skin pores, gilded reflections), and any precision requirements (animation-style contrast between elements, physics behavior, palette control).

Rules:
- Every fact, action, character, spoken line and sound cue in the input MUST survive, and nothing may contradict the input.
- Expand freely with coherent supporting detail (gestures, lighting, texture, camera craft), but never add new plot beats, new characters, or new lines of dialogue.
- Ban vague filler ("beautiful", "stunning", "cinematic quality" with no substance). Every sentence must add a concrete visual or audio fact a set builder could act on.
- Keep reference tags like <Picture 1> / <Video 1> / <Audio 1> exactly where they are used.
- Preserve "all speech is in the voice of ..." style instructions inside [Subject + Action].
- Output only the four labelled sections as plain text. No markdown fences, no intro sentence, no closing note.`;

/** True when the prompt already starts with the four-section header — such prompts are
 *  skipped (restructuring them would cost an LLM call for nothing). */
export function isStructuredPrompt(prompt: string): boolean {
  return /^\[\s*Subject \+ Action\s*\]/i.test(prompt.trim());
}

export interface StructureOptions {
  /** Sampling temperature; defaults to 0.6 (creative expansion). A second draft can use a hotter value. */
  temperature?: number;
  /** Extra instruction appended after the prompt (e.g. "write an alternative draft…"). */
  extraInstruction?: string;
}

/** Ask the co-director to restructure a raw prompt into the four H3 sections. */
export async function structurePrompt(cfg: AiConfig, prompt: string, opts: StructureOptions = {}): Promise<StructureResult> {
  const trimmed = prompt.trim();
  if (isStructuredPrompt(trimmed)) {
    return { structured: trimmed, raw: trimmed, unchanged: true };
  }
  const messages = [
    { role: "system" as const, content: STRUCTURE_SYSTEM },
    { role: "user" as const, content: `Restructure this prompt exactly as instructed:\n\n${trimmed}${opts.extraInstruction ? `\n\n${opts.extraInstruction}` : ""}` },
  ];
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: 3000,
    stream: false,
  };
let raw: string;
  try {
    const res = await postChat(cfg, body);
    if (res.status !== 200) throw chatError(res.status, res.text);
    raw = extractChatContent(res.text);
  } catch (e) {
    throw new Error(`Structure request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const structured = raw.trim().replace(/^```(?:text)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!structured) throw new Error("The model returned an empty response.");
  return { structured, raw, unchanged: false };
}

/** POST a chat completion, retrying transient failures: connection resets (Ollama
 *  loads a cold model and resets the socket), HTTP 429 (upstream providers
 *  rate-limit aggressively — especially the `:free` tier) and 5xx. Timeouts are
 *  NOT retried. */
async function postChat(cfg: AiConfig, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await r.text();
      const retryable = r.status === 429 || r.status >= 500;
      if (retryable && attempt < 2) {
        // 429 from Cline/OpenRouter is usually "retry shortly"; back off politely.
        const retryAfter = Number(r.headers.get("retry-after")) || 0;
        await new Promise((r2) => setTimeout(r2, Math.max(retryAfter * 1000, 2000 * (attempt + 1))));
        continue;
      }
      return { status: r.status, text };
    } catch (e) {
      lastErr = e;
      if ((e as Error).name === "AbortError") break;
      await new Promise((r2) => setTimeout(r2, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Pull the assistant message content out of a chat-completions response body.
 *  Handles BOTH shapes Cline's gateway returns: the OpenAI-flat
 *  `{"choices":[...]}` and its wrapped `{"data":{"choices":[...]}}` — reading only
 *  the flat shape made every Cline response look "empty". */
function extractChatContent(text: string): string {
  const j = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string } }>;
    data?: { choices?: Array<{ message?: { content?: string } }> };
  };
  const choices = j.choices ?? j.data?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

/** Turn a non-200 chat response into an actionable error message. */
function chatError(status: number, text: string): Error {
  if (status === 429 || /rate.?limit|code["\s:]*429/i.test(text)) {
    return new Error(
      `The model is rate-limited upstream (HTTP ${status}). Wait a moment and retry, or pick a non-\`:free\` model in Settings → Provider routing.`,
    );
  }
  if (/ENTITLEMENT_ERROR|not subscribed/i.test(text)) {
    return new Error(`Your plan doesn't include this model — pick a different one in Settings → Provider routing.`);
  }
  if (/model not found|model_not_found/i.test(text)) {
    return new Error(`This model id no longer exists upstream (${status}). Pick a current model from the dropdown.`);
  }
  return new Error(`LLM chat failed (${status}): ${text.slice(0, 300)}`);
}

function looksLikeShot(o: Record<string, unknown>): boolean {
  return (
    (typeof o.prompt === "string" || typeof o.name === "string") &&
    ("seconds" in o || "kind" in o || "prompt" in o)
  );
}

function normalizeDraft(el: Record<string, unknown>, assets: LibraryAsset[], warnings: string[]): DraftShot {
  const name = String(el.name ?? "Shot").slice(0, 80);
  let kind = String(el.kind ?? "t2v");
  if (!["t2v", "i2v", "fl2v", "r2v"].includes(kind)) kind = kind.includes("r2v") ? "r2v" : kind.includes("fl2") ? "fl2v" : "t2v";
  const seconds = Math.min(12, Math.max(4, Number(el.seconds) || 5));
  const prompt = String(el.prompt ?? "").trim();
  const uses = Array.isArray(el.usesAssets) ? (el.usesAssets as unknown[]).map(String) : [];
  const resolved: string[] = [];
  for (const nameToken of uses) {
    const match = findAsset(assets, nameToken);
    if (match) resolved.push(match.name);
    else warnings.push(`No library asset matched "${nameToken}"`);
  }
  const draft: DraftShot = { name, kind: kind as DraftShot["kind"], prompt, seconds, usesAssets: resolved, note: el.note ? String(el.note) : undefined };
  return draft;
}

function findAsset(assets: LibraryAsset[], token: string): LibraryAsset | undefined {
  const t = token.trim().toLowerCase().replace(/\.[a-z0-9]+$/, "");
  return assets.find((a) => a.name.toLowerCase().replace(/\.[a-z0-9]+$/, "") === t) ??
    assets.find((a) => a.name.toLowerCase().includes(t) || t.includes(a.name.toLowerCase().replace(/\.[a-z0-9]+$/, "")));
}

/** Convert AI drafts into real Shot objects appended to a project. */
export function draftsToShots(project: Project, drafts: DraftShot[], assetById: Map<string, LibraryAsset>): Shot[] {
  const d = project.defaults;
  return drafts.map((dr) => {
    const now = Date.now() + Math.random();
    // A character mentioned in the script wins over the project default, but
    // either one forces reference mode: identity cannot be conditioned in the
    // two-slot first/last-frame image mode.
    const cast = dr.usesAssets
      .map((n) => assetById.get(n.toLowerCase().replace(/\.[a-z0-9]+$/, "")))
      .find((a) => a?.kind === "image" && a.role === "character");
    const characterId = cast?.id ?? project.defaultCharacterId ?? null;
    const shot: Shot = {
      id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: dr.name,
      kind: characterId ? "r2v" : dr.kind,
      prompt: dr.prompt,
      imageIds: [],
      videoIds: [],
      audioIds: [],
      characterId,
      firstFrameId: null,
      lastFrameId: null,
      continueFromPrev: false,
      seconds: dr.seconds,
      fps: d.fps,
      resolution: d.resolution,
      aspect: d.aspect,
      width: 1344,
      height: 768,
      steps: d.steps,
      sampler: d.sampler,
      scheduler: d.scheduler,
      seedMode: "random",
      seed: Math.floor(Math.random() * 2 ** 32),
      refImageSize: d.refImageSize,
      loraStrength: d.loraStrength,
      sigmaShiftVideo: null,
      sigmaShiftAudio: null,
      spectrum: false,
      notes: dr.note,
      takes: [],
    };
    for (const name of dr.usesAssets) {
      const asset = assetById.get(name.toLowerCase().replace(/\.[a-z0-9]+$/, ""));
      if (!asset) continue;
      if (asset.kind === "audio") {
        if (shot.audioIds.includes(asset.id)) continue;
        shot.audioIds.push(asset.id);
        // voice reference forces reference mode (H3 encodes voice via ref2va)
        if (shot.kind === "t2v" || shot.kind === "i2v" || shot.kind === "fl2v") shot.kind = "r2v";
      } else if (asset.kind === "image") {
        if (!shot.imageIds.includes(asset.id)) shot.imageIds.push(asset.id);
      } else if (asset.kind === "video") {
        if (!shot.videoIds.includes(asset.id)) shot.videoIds.push(asset.id);
      }
    }
    return shot;
  });
}
