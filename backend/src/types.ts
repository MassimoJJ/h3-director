// Shared data model for H3 Director Studio

export type MediaKind = "image" | "audio" | "video";
export type ShotKind = "t2v" | "i2v" | "fl2v" | "r2v";

/**
 * H3's single-generation ceiling, in seconds. H3 cannot produce a longer clip
 * in one pass, so a long film is several shots.
 *
 * This lives in the shared data model because three places independently
 * enforced a duration limit and had drifted apart: the engine clamped to 15, the
 * timeline's drag handle clamped to 12 (making 12-15s unreachable by dragging,
 * while its own tooltip claimed a limit the engine did not have), and the split
 * route hardcoded 12 again. One constant, imported everywhere.
 */
export const MAX_SHOT_SECONDS = 15;

/** Shortest shot the app will store. Below ~0.5s there is nothing to animate. */
export const MIN_SHOT_SECONDS = 0.5;

/** Clamp any duration into the range H3 can actually render. */
export function clampShotSeconds(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_SHOT_SECONDS;
  return Math.min(MAX_SHOT_SECONDS, Math.max(MIN_SHOT_SECONDS, sec));
}

/**
 * Identity conditioning is a shared concern of both model stages. Keeping the
 * wording here means the still stage and the video stage cannot drift apart.
 */
export function identityRuleForH3(picture: number, name: string): string {
  return `<Picture ${picture}> is ${name}. This is the same person in every shot: preserve their face, hair, age, skin tone and build exactly. Do not change their identity.`;
}

export function identityRuleForQwen(reference: number, name: string): string {
  return `Reference image ${reference} shows ${name}. Keep the same face, hair, age, skin tone and build in every generated still; do not change the person's identity.`;
}

/**
 * Prepending character/continuity images shifts H3's canonical <Picture N>
 * indices. Existing prompt tags are rewritten instead of silently pointing at
 * the wrong attachment.
 */
export function shiftPictureTags(text: string, offset: number): string {
  if (!offset) return text;
  return text.replace(/<Picture\s+(\d+)\s*>/gi, (_all, n: string) => `<Picture ${Number(n) + offset}>`);
}

/**
 * Make one take of a shot the accepted one, clearing the flag on the rest.
 *
 * Kept beside the clamp helpers because it is pure data logic that both the API
 * and the store need, and because "exactly one accepted take" is an invariant
 * worth stating in one place. Refuses to accept a failed take — it has no file
 * to play or export, so accepting it would only break playback later.
 */
export function setAcceptedTakes(takes: Take[], takeId: string, accepted: boolean): Take[] | undefined {
  const target = takes.find((t) => t.id === takeId);
  if (!target) return undefined;
  if (accepted && target.status !== "ok") return undefined;
  return takes.map((t) => ({ ...t, accepted: accepted && t.id === takeId }));
}

/** Qwen Image 2.1 still-image stage: text-to-image or image-edit ("i2i"). */
export type ImageMode = "t2i" | "edit";

/** How a shot's first frame is produced before it is animated. "none" = no still stage. */
export type StillMode = "none" | "t2i" | "i2i";

/** A fresh still stage attached to a shot. `mode: "none"` means stage 1 is skipped. */
export function newStill(mode: StillMode = "none"): ShotStill {
  return {
    mode,
    prompt: "",
    negativePrompt: "",
    imageIds: [],
    width: 1328,
    height: 1328,
    steps: 25,
    cfg: 4,
    sampler: "euler",
    scheduler: "simple",
    seedMode: "random",
    seed: Math.floor(Math.random() * 2 ** 32),
    enhancePrompt: false,
    cacheDevice: "auto",
    cacheDtype: "default",
    variants: 1,
    selectedTakeId: null,
    takes: [],
  };
}

/** Coerce a persisted (possibly hand-edited / older) still block into a valid one. */
export function normalizeStill(raw: unknown): ShotStill {
  const s = (raw ?? {}) as Partial<ShotStill>;
  const base = newStill(s.mode === "i2i" ? "i2i" : s.mode === "t2i" ? "t2i" : "none");
  return {
    ...base,
    ...s,
    mode: base.mode,
    imageIds: Array.isArray(s.imageIds) ? s.imageIds : [],
    takes: Array.isArray(s.takes) ? s.takes : [],
    variants: Math.max(1, Math.min(4, Math.round(Number(s.variants) || 1))),
    selectedTakeId: typeof s.selectedTakeId === "string" ? s.selectedTakeId : null,
  };
}

export interface ImageTake {
  id: string;
  seed: number;
  createdAt: number;
  status: "ok" | "error";
  imageFile?: string; // path relative to data/ root, e.g. "images/<projectId>/<boardId>/<name>.png"
  error?: string;
  promptId?: string;
  width?: number;
  height?: number;
  compiledPrompt?: string;
  warnings?: string[];
  accepted: boolean;
}

export interface ImageBoard {
  id: string;
  name: string;
  mode: ImageMode;
  prompt: string;
  negativePrompt: string;
  /** Library asset ids used as reference images (edit mode). */
  imageIds: string[];
  /** Library image asset whose identity is locked across every still from this board. */
  characterId?: string | null;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seedMode: "random" | "fixed";
  seed: number;
  /** Run the prompt through the model's own prompt enhancer before encoding. */
  enhancePrompt: boolean;
  /** QwenImage21Cache: where the KV cache lives and how it is quantised. */
  cacheDevice: "auto" | "gpu" | "cpu" | "off";
  cacheDtype: "default" | "int8" | "int4";
  notes?: string;
  takes: ImageTake[];
}

export interface LibraryAsset {
  id: string;
  kind: MediaKind;
  name: string; // original file name
  file: string; // path relative to data/ root, e.g. "library/<id>.png"
  size: number;
  createdAt: number;
  role?: string; // character | voice | location | motion | style | prop | other
  tags?: string[];
}

export interface Take {
  id: string;
  seed: number;
  createdAt: number;
  status: "ok" | "error";
  videoFile?: string; // path relative to data/ root, e.g. "outputs/<projectId>/<shotId>/<takeId>.mp4"
  thumbFile?: string;
  error?: string;
  promptId?: string;
  meta?: {
    durationS?: number;
    fps?: number;
    width?: number;
    height?: number;
    compiledPrompt?: string;
    warnings?: string[];
  };
  accepted: boolean;
}

/** The Qwen still stage that runs BEFORE a shot is animated. Owns its own takes; the
 *  take the shot actually animates is picked by the user (or the newest one). */
export interface ShotStill {
  mode: StillMode;
  /** Falls back to the shot's own prompt when empty. */
  prompt: string;
  negativePrompt: string;
  /** Library assets used as references (i2i only). */
  imageIds: string[];
  /** Identity lock inherited from the shot when this stage renders. */
  characterId?: string | null;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seedMode: "random" | "fixed";
  seed: number;
  enhancePrompt: boolean;
  cacheDevice: "auto" | "gpu" | "cpu" | "off";
  cacheDtype: "default" | "int8" | "int4";
  /** How many stills to try per run (1-4). */
  variants: number;
  /** The take id used as the shot's first frame; null = not chosen yet. */
  selectedTakeId: string | null;
  takes: ImageTake[];
}

export interface Shot {
  id: string;
  name: string;
  kind: ShotKind;
  prompt: string;
  /** Stage 1 of the pipeline. Optional so pre-existing project files load unchanged. */
  still?: ShotStill;
  // reference-mode media (r2v). Engine order: images first, then videos, then audio -> canonical <Picture N>/<Video N>/<Audio N>
  imageIds: string[]; // asset ids
  videoIds: string[];
  audioIds: string[];
  /** Library image asset whose identity must survive every still and every video in this shot. */
  characterId?: string | null;
  // image-mode keyframes (i2v / fl2v / t2v)
  firstFrameId: string | null; // library asset id, or null when chained from previous shot
  lastFrameId: string | null;
  continueFromPrev: boolean; // when true and a previous take exists, its last frame becomes firstFrameId
  seconds: number;
  fps: number;
  resolution: string; // Easy resolution preset incl. "custom"
  aspect: string;
  width: number; // used when resolution == "custom"
  height: number;
  steps: number;
  sampler: string;
  scheduler: string;
  seedMode: "random" | "fixed";
  seed: number;
  refImageSize: string; // match | 1k | 1.5k | 2k | original
  loraStrength: number; // 0 = realism LoRA off
  sigmaShiftVideo: number | null; // null = off
  sigmaShiftAudio: number | null;
  spectrum: boolean; // spectral sampling accelerator
  notes?: string;
  takes: Take[];
}

export interface ProjectDefaults {
  resolution: string;
  aspect: string;
  seconds: number;
  fps: number;
  steps: number;
  sampler: string;
  scheduler: string;
  loraStrength: number;
  refImageSize: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  modelFl2va: string | null; // resolved file names (null => probe default)
  modelRef2va: string | null;
  modelTextEncoder: string | null;
  defaults: ProjectDefaults;
  shots: Shot[];
  /** Character inherited by new shots and still boards; the cast of the film. */
  defaultCharacterId?: string | null;
  /** Qwen Image 2.1 stills (t2i / edit). Optional so pre-existing project files load. */
  boards?: ImageBoard[];
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "ok";

export interface ShotJobState {
  shotId: string;
  status: JobStatus;
  takeId?: string;
  error?: string;
  progress?: { pct: number; label: string };
}

export interface RenderJob {
  id: string;
  projectId: string;
  mode: "selected" | "all" | "chainAll";
  shotIds: string[];
  status: JobStatus;
  perShot: Record<string, ShotJobState>;
  createdAt: number;
  updatedAt: number;
  error?: string;
  takeCount: number;
}

export interface ExportJob {
  id: string;
  projectId: string;
  shotIds: string[]; // accepted take per shot, in this order
  status: JobStatus;
  file?: string; // data/exports/<id>.mp4
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageJob {
  id: string;
  projectId: string;
  boardId: string;
  boardName: string;
  status: JobStatus;
  progress: { pct: number; label: string };
  createdAt: number;
  updatedAt: number;
  error?: string;
  takeId?: string;
}

export interface AppSettings {
  comfyUrl: string;
  comfyRoot: string; // absolute path to the portable ComfyUI dir (may be auto-discovered)
  purgeBetweenShots: boolean;
  port: number;
  ollamaUrl: string;
  /** How long one video render may run in ComfyUI before it is abandoned (minutes). */
  renderTimeoutMin: number;
  /** How long one still/board image render may run before it is abandoned (minutes). */
  imageTimeoutMin: number;
  // Which provider powers the AI co-director: "ollama" or a key id from the catalog.
  director: { provider: string; model: string };
  // Provider id -> stored credentials (full keys live ONLY here, never sent to the UI).
  keys: Record<string, { baseUrl: string; key: string; model: string }>;
}

export interface EngineProbe {
  comfyUp: boolean;
  comfyVersion?: string;
  gpuName?: string;
  comfyRoot?: string;
  comfyRootAuto?: boolean;
  models: { fl2va: string[]; ref2va: string[]; textEncoder: string[]; loras: string[] };
  nodes: Record<string, boolean>;
  llmUp: boolean; // effective AI co-director provider reachable
  llmModel?: string;
  llmModels?: string[];
  llmProvider?: string;
  ollamaUp: boolean;
  error?: string;
}
