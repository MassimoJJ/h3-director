export interface Take {
  id: string;
  seed: number;
  createdAt: number;
  status: "ok" | "error";
  videoFile?: string;
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

export type ShotKind = "t2v" | "i2v" | "fl2v" | "r2v";

/** Qwen Image 2.1 still-image stage: text-to-image or image-edit ("i2i"). */
export type ImageMode = "t2i" | "edit";

/** Pipeline stage 1: how this shot's picture is made before it is animated. */
export type StillMode = "none" | "t2i" | "i2i";

export interface ImageTake {
  id: string;
  seed: number;
  createdAt: number;
  status: "ok" | "error";
  imageFile?: string;
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
  imageIds: string[];
  /** Library image whose identity is attached to every still rendered with this setup. */
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
  notes?: string;
  takes: ImageTake[];
}

/** Stage 1 of the shot pipeline: the still that gets animated. */
export interface ShotStill {
  mode: StillMode;
  prompt: string;
  negativePrompt: string;
  imageIds: string[];
  /** Library image whose identity is attached to every still rendered with this setup. */
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
  variants: number;
  selectedTakeId: string | null;
  takes: ImageTake[];
}

export interface Shot {
  id: string;
  name: string;
  kind: ShotKind;
  prompt: string;
  still?: ShotStill;
  imageIds: string[];
  videoIds: string[];
  audioIds: string[];
  /** Library image whose identity is bound to every still and video in this shot. */
  characterId?: string | null;
  firstFrameId: string | null;
  lastFrameId: string | null;
  continueFromPrev: boolean;
  seconds: number;
  fps: number;
  resolution: string;
  aspect: string;
  width: number;
  height: number;
  steps: number;
  sampler: string;
  scheduler: string;
  seedMode: "random" | "fixed";
  seed: number;
  refImageSize: string;
  loraStrength: number;
  sigmaShiftVideo: number | null;
  sigmaShiftAudio: number | null;
  spectrum: boolean;
  notes?: string;
  takes: Take[];
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  modelFl2va: string | null;
  modelRef2va: string | null;
  modelTextEncoder: string | null;
  defaults: {
    resolution: string;
    aspect: string;
    seconds: number;
    fps: number;
    steps: number;
    sampler: string;
    scheduler: string;
    loraStrength: number;
    refImageSize: string;
  };
  shots: Shot[];
  /** Character inherited by newly created shots and still boards. */
  defaultCharacterId?: string | null;
  boards?: ImageBoard[];
}

export type MediaKind = "image" | "audio" | "video";

export interface LibraryAsset {
  id: string;
  kind: MediaKind;
  name: string;
  file: string;
  size: number;
  createdAt: number;
  role?: string;
  tags?: string[];
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "ok";

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

export interface RenderJob {
  id: string;
  projectId: string;
  mode: string;
  shotIds: string[];
  status: JobStatus;
  perShot: Record<string, { shotId: string; status: JobStatus; takeId?: string; error?: string }>;
  createdAt: number;
  updatedAt: number;
  error?: string;
  takeCount: number;
}

export interface ExportJob {
  id: string;
  projectId: string;
  shotIds: string[];
  status: JobStatus;
  file?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineProbe {
  comfyUp: boolean;
  comfyVersion?: string;
  gpuName?: string;
  comfyRoot?: string;
  models: { fl2va: string[]; ref2va: string[]; textEncoder: string[]; loras: string[] };
  nodes: Record<string, boolean>;
  llmUp: boolean;
  llmModel?: string;
  llmModels?: string[];
  llmProvider?: string;
  ollamaUp: boolean;
  error?: string;
}

export interface ProviderKeyMeta {
  id: string;
  label: string;
  baseUrl: string;
  configured: boolean;
  envVar: string;
  last4: string;
  model: string;
}

export interface OllamaModelInfo {
  name: string;
  sizeGB?: string;
  details?: string;
}

export interface AppSettings {
  comfyUrl: string;
  comfyRoot: string;
  purgeBetweenShots: boolean;
  port: number;
  ollamaUrl: string;
  /** Minutes one video render may run before it is abandoned. */
  renderTimeoutMin: number;
  /** Minutes one still/board image render may run before it is abandoned. */
  imageTimeoutMin: number;
  director: { provider: string; model: string };
  /**
   * The engine's own limits, so the UI never asserts a duration the renderer
   * would refuse. Sourced from MAX_SHOT_SECONDS on the backend.
   */
  limits: { maxShotSeconds: number; minShotSeconds: number };
  keys: Record<string, ProviderKeyMeta>;
}

export interface DraftShot {
  name: string;
  kind: ShotKind;
  prompt: string;
  seconds: number;
  usesAssets: string[];
  note?: string;
}

async function http<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: opts?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    const msg = data && typeof data === "object" && "error" in (data as object) ? String((data as { error: string }).error) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  status: () => http<EngineProbe & { settings: AppSettings }>("/api/status"),
  refreshStatus: () => http<EngineProbe>("/api/status/refresh", { method: "POST" }),

  getSettings: () => http<AppSettings>("/api/settings"),
  putSettings: (s: Partial<AppSettings>) => http<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),

  listProjects: () => http<Array<Pick<Project, "id" | "name" | "createdAt" | "updatedAt">>>("/api/projects"),
  createProject: (name?: string) => http<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  getProject: (id: string) => http<Project>(`/api/projects/${id}`),
  putProject: (p: Project) => http<Project>(`/api/projects/${p.id}`, { method: "PUT", body: JSON.stringify(p) }),
  deleteProject: (id: string) => http<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  addShot: (id: string, patch?: Partial<Shot>) => http<{ shot: Shot; project: Project }>(`/api/projects/${id}/shots`, { method: "POST", body: JSON.stringify(patch ?? {}) }),
  duplicateShot: (id: string, shotId: string) => http<{ shot: Shot; project: Project }>(`/api/projects/${id}/shots/${shotId}/duplicate`, { method: "POST" }),
  splitShot: (id: string, shotId: string) =>
    http<{ project: Project; split: { aId: string; bId: string } }>(`/api/projects/${id}/shots/${shotId}/split`, { method: "POST" }),
  deleteShot: (id: string, shotId: string) => http<{ project: Project }>(`/api/projects/${id}/shots/${shotId}`, { method: "DELETE" }),
  reorder: (id: string, shotIds: string[]) => http<{ project: Project }>(`/api/projects/${id}/reorder`, { method: "POST", body: JSON.stringify({ shotIds }) }),

  // ---------- character consistency ----------
  setShotCharacter: (projectId: string, shotId: string, characterId: string | null) =>
    http<Shot>(`/api/projects/${projectId}/shots/${shotId}/character`, {
      method: "POST",
      body: JSON.stringify({ characterId }),
    }),
  setProjectCharacter: (projectId: string, characterId: string | null, applyToAll = false) =>
    http<{ project: Project; touched: string[] }>(`/api/projects/${projectId}/character`, {
      method: "POST",
      body: JSON.stringify({ characterId, applyToAll }),
    }),

  // ---------- the still stage (pipeline stage 1 of a shot) ----------
  /** mode is optional: omit it to patch fields without changing the stage type. */
  setShotStill: (projectId: string, shotId: string, mode: StillMode | null, patch?: Partial<ShotStill>) =>
    http<Shot>(`/api/projects/${projectId}/shots/${shotId}/still`, {
      method: "POST",
      body: JSON.stringify({ ...(patch ?? {}), ...(mode ? { mode } : {}) }),
    }),
  /**
   * Queue a still render. Returns the ImageJob immediately — the server no longer
   * blocks the request for the whole render, it serializes the work through the
   * same GPU pump as everything else and reports progress over the bus.
   */
  renderShotStill: (projectId: string, shotId: string, count = 1) =>
    http<ImageJob>(`/api/projects/${projectId}/shots/${shotId}/still/render`, {
      method: "POST",
      body: JSON.stringify({ count }),
    }),
  useShotStill: (projectId: string, shotId: string, takeId: string) =>
    http<Shot>(`/api/projects/${projectId}/shots/${shotId}/still/takes/${takeId}/use`, { method: "POST", body: "{}" }),

  /** Accept or un-accept one video take — decides what Play cut and Export use. */
  acceptShotTake: (projectId: string, shotId: string, takeId: string, accepted: boolean) =>
    http<{ project: Project; shot: Shot }>(
      `/api/projects/${projectId}/shots/${shotId}/takes/${takeId}/accept`,
      { method: "POST", body: JSON.stringify({ accepted }) },
    ),
  /** Delete one take and its media. */
  deleteShotTake: (projectId: string, shotId: string, takeId: string) =>
    http<{ project: Project; shot: Shot; removed: string[] }>(
      `/api/projects/${projectId}/shots/${shotId}/takes/${takeId}`,
      { method: "DELETE" },
    ),

  assets: () => http<LibraryAsset[]>("/api/assets"),
  uploadAsset: (file: File, role?: string) => {
    const fd = new FormData();
    fd.append("file", file);
    if (role) fd.append("role", role);
    return http<LibraryAsset>("/api/assets", { method: "POST", body: fd });
  },
  importAsset: (path: string) => http<LibraryAsset>("/api/assets/import", { method: "POST", body: JSON.stringify({ path }) }),
  patchAsset: (id: string, patch: Partial<LibraryAsset>) => http<LibraryAsset>(`/api/assets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteAsset: (id: string) => http<{ ok: boolean }>(`/api/assets/${id}`, { method: "DELETE" }),

  render: (projectId: string, shotIds: string[], forceChain = false) => http<RenderJob>(`/api/projects/${projectId}/render`, { method: "POST", body: JSON.stringify({ shotIds, forceChain }) }),
  cancelRender: (jobId: string) => http<{ ok: boolean }>(`/api/jobs/render/${jobId}/cancel`, { method: "POST" }),
  jobs: () => http<{ render: RenderJob[]; export: ExportJob[] }>("/api/jobs"),

  // ---------- Qwen Image 2.1 stills ----------
  qwenStatus: () =>
    http<{ ready: boolean; models: { unet: string; clip: string; vae: string } | null; nodes: Record<string, boolean>; error?: string }>(
      "/api/qwen/status",
    ),
  createBoard: (
    projectId: string,
    mode: ImageMode,
    init?: {
      name?: string;
      prompt?: string;
      width?: number;
      height?: number;
      steps?: number;
      cfg?: number;
      imageIds?: string[];
    },
  ) =>
    http<ImageBoard>(`/api/projects/${projectId}/boards`, {
      method: "POST",
      body: JSON.stringify({ mode, ...init }),
    }),
  updateBoard: (projectId: string, boardId: string, patch: Partial<ImageBoard>) =>
    http<ImageBoard>(`/api/projects/${projectId}/boards/${boardId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBoard: (projectId: string, boardId: string) =>
    http<{ ok: boolean }>(`/api/projects/${projectId}/boards/${boardId}`, { method: "DELETE" }),
  renderBoard: (projectId: string, boardId: string, count = 1) =>
    http<ImageJob>(`/api/projects/${projectId}/boards/${boardId}/render`, { method: "POST", body: JSON.stringify({ count }) }),
  acceptTake: (projectId: string, boardId: string, takeId: string) =>
    http<ImageBoard>(`/api/projects/${projectId}/boards/${boardId}/takes/${takeId}/accept`, { method: "POST", body: "{}" }),
  takeToAsset: (projectId: string, boardId: string, takeId: string) =>
    http<LibraryAsset>(`/api/projects/${projectId}/boards/${boardId}/takes/${takeId}/to-asset`, { method: "POST", body: "{}" }),
  imageJobs: (projectId?: string) =>
    http<ImageJob[]>(`/api/image-jobs${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  cancelImageJob: (jobId: string) => http<{ ok: boolean }>(`/api/image-jobs/${jobId}/cancel`, { method: "POST" }),
  export: (projectId: string, shotIds?: string[]) => http<ExportJob>(`/api/projects/${projectId}/export`, { method: "POST", body: JSON.stringify({ shotIds }) }),
  freeComfy: () => http<{ ok: boolean }>("/api/comfy/free", { method: "POST" }),
  interruptComfy: () => http<{ ok: boolean }>("/api/comfy/interrupt", { method: "POST" }),
  startComfy: () => http<{ started: boolean; alreadyRunning?: boolean; launcher?: string; pid?: number; error?: string }>("/api/comfy/start", { method: "POST" }),
  stopComfy: () => http<{ ok: boolean; error?: string }>("/api/comfy/stop", { method: "POST" }),

  direct: (projectId: string, brief: string, extra: string) =>
    http<{ shots: Shot[]; warnings: string[]; raw: string; provider?: string; model?: string }>(`/api/projects/${projectId}/ai/direct`, { method: "POST", body: JSON.stringify({ brief, extra }) }),

  structurePrompt: (projectId: string, prompt: string) =>
    http<{ structured: string; raw?: string; unchanged?: boolean; provider?: string; model?: string }>(`/api/projects/${projectId}/prompt/structure`, { method: "POST", body: JSON.stringify({ prompt }) }),

  streamStructureAll: (projectId: string, onShot: (s: StructureAllShot) => void, signal: AbortSignal | undefined, rounds: 1 | 2, runId: string, shotIds?: string[]) =>
    streamStructureAllRaw(projectId, onShot, signal, rounds, runId, shotIds),
  cancelStructureAll: (projectId: string, runId: string) =>
    http<{ ok: boolean; stopping: boolean }>(`/api/projects/${projectId}/prompt/structure-all/cancel`, { method: "POST", body: JSON.stringify({ runId }) }),

  getKeys: () => http<{ keys: Record<string, ProviderKeyMeta> }>("/api/keys"),
  putKey: (id: string, patch: { baseUrl?: string; key?: string; model?: string }) =>
    http<ProviderKeyMeta>(`/api/keys/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  clearKey: (id: string) => http<ProviderKeyMeta>(`/api/keys/${id}`, { method: "DELETE" }),
  testKey: (id: string, patch?: { baseUrl?: string; key?: string }) =>
    http<{ ok: boolean; models?: string[]; error?: string; usedEnvKey?: boolean }>(`/api/keys/${id}/test`, { method: "POST", body: JSON.stringify(patch ?? {}) }),
  ollamaModels: () => http<{ ok: boolean; models?: OllamaModelInfo[]; error?: string }>("/api/llm/ollama/models"),
  testOllama: (url?: string) => http<{ ok: boolean; models?: OllamaModelInfo[]; error?: string }>("/api/llm/ollama/test", { method: "POST", body: JSON.stringify({ url }) }),
  providerModels: (id: string) => http<{ models: string[] }>(`/api/llm/models/${id}`),
};

export interface StructureAllShot {
  shotId: string;
  name: string;
  index: number;
  total: number;
  /** Which draft this event carries: 0 = first, 1 = alternative (rounds=2 only). */
  round?: number;
  /** How many drafts the server was asked for (1 or 2). */
  rounds?: number;
  unchanged?: boolean;
  structured?: string;
  error?: string;
}

export interface StructureAllDone {
  provider?: string;
  model?: string;
  rounds?: number;
  changed: number;
  skipped: number;
  failed: number;
  /** True when the user cancelled: the run stopped after the current LLM call. */
  cancelled?: boolean;
}

/** POST /prompt/structure-all — the server streams one NDJSON line per draft (one
 *  per shot when rounds=1, two per shot when rounds=2), then a final
 *  { type: "done" } line. Invokes onShot as each line arrives. Passing a runId
 *  allows cancelling the run via api.cancelStructureAll (the server then stops
 *  issuing further LLM calls after the in-flight one and ends with cancelled:true).
 *  shotIds optionally scopes the pass to a window of the timeline. */
async function streamStructureAllRaw(
  projectId: string,
  onShot: (s: StructureAllShot) => void,
  signal: AbortSignal | undefined,
  rounds: 1 | 2,
  runId: string,
  shotIds?: string[],
): Promise<StructureAllDone> {
  const r = await fetch(`/api/projects/${projectId}/prompt/structure-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rounds, runId, shotIds }),
    signal,
  });
  if (!r.ok || !r.body) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j?.error) msg = String(j.error);
    } catch {
      /* keep the HTTP status message */
    }
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let doneEv: StructureAllDone | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (raw) {
          const ev = JSON.parse(raw) as { type: string } & (StructureAllShot | StructureAllDone);
          if (ev.type === "shot") onShot(ev as StructureAllShot);
          else if (ev.type === "done") doneEv = ev as StructureAllDone;
        }
        nl = buf.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!doneEv) throw new Error("The server closed the connection before finishing.");
  return doneEv;
}

export function assetUrl(a: LibraryAsset): string {
  return `/api/assets/${a.id}/file`;
}

export function outputUrl(rel: string): string {
  // rel like "outputs/<proj>/<shot>/file.mp4"
  return `/files/outputs/${rel.replace(/^outputs\//, "")}`;
}

export function exportUrl(rel: string): string {
  return `/files/exports/${rel.replace(/^exports\//, "")}`;
}

export function cacheUrl(rel: string): string {
  return `/files/cache/${rel.replace(/^cache\//, "")}`;
}

export function imageUrl(rel: string): string {
  // rel like "images/<projectId>/<boardId>/file.png"
  return `/files/images/${rel.replace(/^images\//, "")}`;
}

export function onBusEvent(cb: (ev: { type: string; projectId?: string; jobId?: string; data?: unknown }) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        cb(JSON.parse(String(e.data)));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(open, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}
