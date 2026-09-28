import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { ComfyClient } from "./comfy";
import { discoverComfyRoot } from "./media";
import { startComfy, stopComfy } from "./comfyctl";
import { runProbe, resolveEngineModels } from "./engine";
import { imagesDir, newBoardId, renderImage, resolveQwenModels } from "./qwen";
import { Director } from "./queue";
import { directShots, draftsToShots, isStructuredPrompt, structurePrompt } from "./director";
import { resolveAi, listProviderModels, listOllamaModels, keyConfigured, ollamaUp, effectiveKey, type ResolvedAi } from "./ai";
import { providerDef } from "./providers";
import {
  APP_ROOT,
  DATA_DIR,
  EXPORTS_DIR,
  IMAGES_DIR,
  LIBRARY_DIR,
  OUTPUTS_DIR,
  CACHE_DIR,
  loadSettings,
  saveSettings,
  publicSettings,
  providerMetaFor,
} from "./settings";
import {
  addAsset,
  cacheDir,
  deleteAsset,
  deleteProject,
  exportsDir,
  getAsset,
  getProject,
  kindForFile,
  listAssets,
  listProjects,
  newShotId,
  purgeProjectMedia,
  purgeShotMedia,
  readJobLog,
  saveProject,
  updateAsset,
} from "./store";
import type { AppSettings, EngineProbe, ImageBoard, Project, Shot, ShotStill, StillMode } from "./types";
import { newStill, normalizeStill } from "./types";

function asyncWrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: express.NextFunction) => {
    fn(req, res).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.status(500).json({ error: msg });
      else next(e);
    });
  };
}

function body<T>(req: Request): T {
  return (req.body ?? {}) as T;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => {
      const d = path.join(DATA_DIR, "tmp");
      fs.mkdirSync(d, { recursive: true });
      cb(null, d);
    },
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}_${file.originalname.replace(/[^\w.-]+/g, "_")}`),
  }),
  limits: { fileSize: 1_000_000_000 },
});

const VALID_SETTINGS_FIELDS = ["comfyUrl", "comfyRoot", "purgeBetweenShots", "port", "ollamaUrl", "director", "renderTimeoutMin", "imageTimeoutMin"] as const;

/** Resolve the AI provider for an LLM job, applying Ollama model fallback. Returns an error string when not usable. */
async function tryResolveAi(settings: AppSettings): Promise<{ resolved?: ResolvedAi; error?: string }> {
  let resolved = resolveAi(settings);
  if (!resolved.model || !resolved.baseUrl) {
    return { error: `AI provider "${resolved.providerId}" is not configured. Open Settings → Provider routing and pick a model.` };
  }
  if (resolved.isOllama) {
    try {
      const list = await listOllamaModels(settings.ollamaUrl);
      if (!list.some((m) => m.name === resolved.model)) {
        if (list.length) {
          settings.director.model = list[0].name;
          settings.director.provider = "ollama";
          saveSettings(settings);
          resolved = resolveAi(settings);
        } else {
          return { error: "Ollama is running but has no models pulled. Run e.g. `ollama pull qwen3:8b`." };
        }
      }
    } catch {
      return { error: "Ollama is not reachable. Start it with `ollama serve` (see Settings → Providers)." };
    }
  } else if (!resolved.apiKey && !["lmstudio", "custom"].includes(resolved.providerId)) {
    return { error: `No API key for ${resolved.providerLabel}. Add it in Settings → Providers (or set ${providerDef(resolved.providerId)?.envVar}).` };
  }
  return { resolved };
}

export function buildApp(deps: { director: Director; getComfy: () => ComfyClient }) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  let probeCache: { at: number; value: EngineProbe } | null = null;
  // Bookkeeping for in-flight /prompt/structure-all runs. structureActive tracks
  // live runIds (added when a run starts); structureCancelled is filled by the
  // cancel endpoint and makes the run stop issuing further LLM calls once the
  // current one returns. The two sets are separate so a run never "cancels" itself.
  const structureActive = new Set<string>();
  const structureCancelled = new Set<string>();

  async function probe(force = false): Promise<EngineProbe> {
    if (!force && probeCache && Date.now() - probeCache.at < 10_000) return probeCache.value;
    const settings = loadSettings();
    let root = settings.comfyRoot;
    if (!root) {
      const auto = await discoverComfyRoot();
      if (auto) {
        settings.comfyRoot = auto;
        saveSettings(settings);
      }
    }
    const p = await runProbe(deps.getComfy(), root, loadSettings());
    probeCache = { at: Date.now(), value: p };
    return p;
  }

  // ---------- status ----------
  app.get(
    "/api/status",
    asyncWrap(async (_req, res) => {
      res.json({ ...(await probe()), settings: publicSettings(loadSettings()) });
    }),
  );
  app.post(
    "/api/status/refresh",
    asyncWrap(async (_req, res) => {
      res.json(await probe(true));
    }),
  );

  // ---------- settings (non-secret fields) ----------
  app.get("/api/settings", (_req, res) => res.json(publicSettings(loadSettings())));
  app.put(
    "/api/settings",
    asyncWrap(async (req, res) => {
      const patch = body<Partial<AppSettings>>(req);
      const cur = loadSettings();
      for (const f of VALID_SETTINGS_FIELDS) {
        if (f === "director") {
          cur.director = { ...cur.director, ...((patch.director as AppSettings["director"]) ?? {}) };
        } else if (f === "renderTimeoutMin" || f === "imageTimeoutMin") {
          // Numbers from a form field can arrive as strings; clamp to 1-600 minutes.
          const n = Number(patch[f as keyof AppSettings]);
          if (Number.isFinite(n)) (cur[f] as unknown) = Math.min(600, Math.max(1, Math.round(n)));
        } else if (patch[f as keyof AppSettings] !== undefined) {
          (cur[f] as unknown) = patch[f as keyof AppSettings];
        }
      }
      saveSettings(cur);
      probeCache = null;
      res.json(publicSettings(cur));
    }),
  );

  // ---------- provider API keys ----------
  app.get("/api/keys", (_req, res) => {
    const s = loadSettings();
    res.json({ keys: publicSettings(s).keys });
  });

  app.put(
    "/api/keys/:id",
    asyncWrap(async (req, res) => {
      const id = req.params.id;
      const def = providerDef(id);
      if (!def || id === "ollama") {
        res.status(400).json({ error: "Unknown provider." });
        return;
      }
      const s = loadSettings();
      const entry = s.keys[id] ?? { baseUrl: def.baseUrl, key: "", model: "" };
      const patch = body<{ baseUrl?: string; key?: string; model?: string }>(req);
      if (typeof patch.baseUrl === "string") entry.baseUrl = patch.baseUrl;
      if (typeof patch.key === "string") entry.key = patch.key; // full replace; "" clears
      if (typeof patch.model === "string") entry.model = patch.model;
      s.keys[id] = entry;
      saveSettings(s);
      res.json(providerMetaFor(id, s));
    }),
  );
  app.delete(
    "/api/keys/:id",
    asyncWrap(async (req, res) => {
      const s = loadSettings();
      const id = req.params.id;
      if (s.keys[id]) s.keys[id].key = "";
      saveSettings(s);
      res.json(providerMetaFor(id, s));
    }),
  );
  app.post(
    "/api/keys/:id/test",
    asyncWrap(async (req, res) => {
      const id = req.params.id;
      const def = providerDef(id);
      if (!def || id === "ollama") {
        res.status(400).json({ error: "Unknown provider." });
        return;
      }
      // Save first (same behaviour as the reference app: Test saves before testing).
      const s = loadSettings();
      const entry = s.keys[id] ?? { baseUrl: def.baseUrl, key: "", model: "" };
      const patch = body<{ baseUrl?: string; key?: string }>(req);
      if (typeof patch.baseUrl === "string") entry.baseUrl = patch.baseUrl;
      if (typeof patch.key === "string") entry.key = patch.key;
      s.keys[id] = entry;
      saveSettings(s);
      if (!entry.baseUrl) {
        res.json({ ok: false, error: "Provider has no base URL." });
        return;
      }
      try {
        const key = effectiveKey(def, entry.key);
        const models = await listProviderModels(entry.baseUrl, key);
        res.json({ ok: true, models, baseUrl: entry.baseUrl, usedEnvKey: !entry.key && !!def.envVar });
      } catch (e) {
        res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  // ---------- LLM model browsing ----------
  app.get(
    "/api/llm/ollama/models",
    asyncWrap(async (_req, res) => {
      const s = loadSettings();
      try {
        res.json({ ok: true, models: await listOllamaModels(s.ollamaUrl) });
      } catch (e) {
        res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  app.post(
    "/api/llm/ollama/test",
    asyncWrap(async (req, res) => {
      const s = loadSettings();
      const { url } = body<{ url?: string }>(req);
      const target = url || s.ollamaUrl;
      try {
        const models = await listOllamaModels(target);
        if (url) {
          s.ollamaUrl = url;
          saveSettings(s);
          probeCache = null;
        }
        res.json({ ok: true, models });
      } catch (e) {
        res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  app.get(
    "/api/llm/models/:provider",
    asyncWrap(async (req, res) => {
      const id = req.params.provider;
      const s = loadSettings();
      const resolved = resolveAi(s);
      if (resolved.providerId !== id) {
        // Test against the requested provider's own stored credentials.
        const def = providerDef(id);
        const entry = s.keys[id];
        if (!def || !entry) {
          res.status(400).json({ error: "Unknown provider." });
          return;
        }
        try {
          const models = await listProviderModels(entry.baseUrl || def.baseUrl, effectiveKey(def, entry.key));
          res.json({ models });
        } catch (e) {
          res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (resolved.isOllama) {
        const list = await listOllamaModels(s.ollamaUrl);
        res.json({ models: list.map((m) => m.name) });
        return;
      }
      if (!resolved.baseUrl) {
        res.status(400).json({ error: "Provider has no base URL." });
        return;
      }
      try {
        const models = await listProviderModels(resolved.baseUrl, resolved.apiKey);
        res.json({ models });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  // ---------- comfy actions ----------
  app.post("/api/comfy/free", asyncWrap(async (_req, res) => { await deps.getComfy().freeMemory(); res.json({ ok: true }); }));
  app.post("/api/comfy/interrupt", asyncWrap(async (_req, res) => { await deps.getComfy().interrupt(); res.json({ ok: true }); }));

  // ---------- ComfyUI engine control (start / stop the local server) ----------
  app.post(
    "/api/comfy/start",
    asyncWrap(async (_req, res) => {
      const s = loadSettings();
      let root = s.comfyRoot;
      if (!root) {
        const auto = await discoverComfyRoot();
        if (auto) {
          root = auto;
          s.comfyRoot = auto;
          saveSettings(s);
        }
      }
      const isUp = async () => {
        try {
          await deps.getComfy().systemStats();
          return true;
        } catch {
          return false;
        }
      };
      const r = await startComfy(root, s.comfyUrl, isUp);
      res.json(r);
    }),
  );
  app.post("/api/comfy/stop", asyncWrap(async (_req, res) => { res.json(await stopComfy(loadSettings().comfyUrl)); }));

  // ---------- projects ----------
  app.get("/api/projects", (_req, res) => res.json(listProjects()));
  app.post(
    "/api/projects",
    asyncWrap(async (req, res) => {
      const { name } = body<{ name?: string }>(req);
      const p = await probe();
      const now = Date.now();
      const project: Project = {
        id: crypto.randomUUID().slice(0, 8),
        name: (name || "Untitled project").slice(0, 120),
        createdAt: now,
        updatedAt: now,
        modelFl2va: p.models.fl2va[0] ?? null,
        modelRef2va: p.models.ref2va[0] ?? null,
        modelTextEncoder: p.models.textEncoder[0] ?? null,
        defaults: {
          resolution: "480P", aspect: "16:9", seconds: 5, fps: 24, steps: 20,
          sampler: "euler", scheduler: "simple", loraStrength: 0, refImageSize: "match",
        },
        shots: [],
        boards: [],
      };
      saveProject(project);
      res.json(project);
    }),
  );
  app.get("/api/projects/:id", (req, res) => {
    const p = getProject(req.params.id);
    if (!p) { res.status(404).json({ error: "Project not found" }); return; }
    res.json(p);
  });
  app.put(
    "/api/projects/:id",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const patch = body<Project>(req);
      // The UI PUTs the whole project on every edit, so a browser tab that was open
      // during a render would wipe the takes the queue just appended. Re-attach any
      // server-side take the payload is missing instead of dropping it on the floor.
      const incoming = sanitizeShots(patch.shots ?? p.shots);
      const incomingIds = new Set(incoming.map((s) => s.id));
      const shots = incoming.map((s) => {
        const server = p.shots.find((x) => x.id === s.id);
        if (!server) return s;
        const have = new Set(s.takes.map((t) => t.id));
        const missing = server.takes.filter((t) => !have.has(t.id));
        return missing.length ? { ...s, takes: [...s.takes, ...missing] } : s;
      });
      // Takes of shots the payload dropped entirely (deleted in the UI) are intentionally
      // not resurrected, but their files stay on disk; log it so it is never a mystery.
      for (const gone of p.shots.filter((x) => !incomingIds.has(x.id) && x.takes.length)) {
        console.warn(`[api] shot ${gone.id} was removed from project ${p.id}; ${gone.takes.length} take(s) dropped from the index`);
      }
      const merged: Project = {
        ...p, ...patch, id: p.id, createdAt: p.createdAt,
        defaults: { ...p.defaults, ...(patch.defaults ?? {}) },
        shots,
        // Never let a payload without boards wipe the still-image boards.
        boards: Array.isArray(patch.boards) ? patch.boards : (p.boards ?? []),
      };
      saveProject(merged);
      res.json(merged);
    }),
  );
  app.delete("/api/projects/:id", (req, res) => {
    const p = getProject(req.params.id);
    // Purge the media too: deleting only the JSON left every take, still and cached
    // frame of the project on disk forever.
    const removed = p ? purgeProjectMedia(p) : [];
    deleteProject(req.params.id);
    res.json({ ok: true, removed });
  });

  // ---------- shots ----------
  app.post(
    "/api/projects/:id/shots",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const { kind, name } = body<{ kind?: Shot["kind"]; name?: string }>(req);
      const d = p.defaults;
      const shot: Shot = {
        id: newShotId(), name: name ?? `Shot ${p.shots.length + 1}`, kind: kind ?? "t2v", prompt: "",
        imageIds: [], videoIds: [], audioIds: [], firstFrameId: null, lastFrameId: null,
        continueFromPrev: false, seconds: d.seconds, fps: d.fps, resolution: d.resolution,
        aspect: d.aspect, width: 1344, height: 768, steps: d.steps, sampler: d.sampler,
        scheduler: d.scheduler, seedMode: "random", seed: Math.floor(Math.random() * 2 ** 32),
        refImageSize: d.refImageSize, loraStrength: d.loraStrength,
        sigmaShiftVideo: null, sigmaShiftAudio: null, spectrum: false, takes: [],
      };
      p.shots.push(shot);
      saveProject(p);
      res.json({ shot, project: p });
    }),
  );
  app.post(
    "/api/projects/:id/shots/:shotId/duplicate",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      const idx = p?.shots.findIndex((s) => s.id === req.params.shotId);
      if (!p || idx == null || idx < 0) { res.status(404).json({ error: "Shot not found" }); return; }
      const copy: Shot = { ...structuredClone(p.shots[idx]), id: newShotId(), takes: [] };
      p.shots.splice(idx + 1, 0, copy);
      saveProject(p);
      res.json({ shot: copy, project: p });
    }),
  );
  app.post(
    "/api/projects/:id/shots/:shotId/split",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      const idx = p?.shots.findIndex((s) => s.id === req.params.shotId);
      if (!p || idx == null || idx < 0) { res.status(404).json({ error: "Shot not found" }); return; }
      const s = p.shots[idx];
      const [pa, pb] = splitPromptText(s.prompt);
      const total = Math.max(1, s.seconds);
      const ratio = pa.length + pb.length > 0 ? pa.length / (pa.length + pb.length) : 0.5;
      const aDur = Math.min(12, Math.max(1, Math.round(total * ratio * 2) / 2));
      const bDur = Math.max(1, total - aDur);
      const base = { ...s }; // keep kind, media refs, settings, seed of the original
      const mk = (patch: Partial<Shot>): Shot => ({
        ...structuredClone(base),
        id: newShotId(),
        prompt: "",
        takes: [],
        ...patch,
      });
      // Part A keeps the original start (chained to the previous shot if it was); part B
      // continues from part A's final frame so the two halves cut seamlessly together.
      const a = mk({ prompt: pa, seconds: aDur, name: `${s.name} — 1/2`, continueFromPrev: s.continueFromPrev, firstFrameId: s.firstFrameId, lastFrameId: null });
      const b = mk({ prompt: pb, seconds: bDur, name: `${s.name} — 2/2`, continueFromPrev: true, firstFrameId: null, lastFrameId: s.lastFrameId });
      p.shots.splice(idx, 1, a, b);
      saveProject(p);
      res.json({ project: p, split: { aId: a.id, bId: b.id } });
    }),
  );
  app.delete("/api/projects/:id/shots/:shotId", (req, res) => {
    const p = getProject(req.params.id);
    if (!p) { res.status(404).json({ error: "Project not found" }); return; }
    p.shots = p.shots.filter((s) => s.id !== req.params.shotId);
    saveProject(p);
    // Drop the shot's own media too, otherwise every deleted shot leaks its takes.
    const removed = purgeShotMedia(req.params.id, req.params.shotId);
    res.json({ project: p, removed });
  });
  app.post(
    "/api/projects/:id/reorder",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const { shotIds } = body<{ shotIds: string[] }>(req);
      const byId = new Map(p.shots.map((s) => [s.id, s]));
      p.shots = shotIds.map((id) => byId.get(id)).filter((s): s is Shot => !!s);
      saveProject(p);
      res.json({ project: p });
    }),
  );

  // ---------- assets (library) ----------
  app.get("/api/assets", (_req, res) => res.json(listAssets()));
  app.post("/api/assets", upload.single("file"), (req, res) => {
    try {
      if (!req.file) { res.status(400).json({ error: "No file provided (field name: file)" }); return; }
      const role = typeof req.body.role === "string" ? req.body.role : "";
      const tagsRaw: string = typeof req.body.tags === "string" ? req.body.tags : "";
      const tags = tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean);
      const asset = addAsset({ name: req.file.originalname, absSrc: req.file.path, role, tags });
      fs.rmSync(req.file.path, { force: true });
      res.json(asset);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  app.post(
    "/api/assets/import",
    asyncWrap(async (req, res) => {
      const { path: src } = body<{ path: string }>(req);
      if (!src || !fs.existsSync(src)) { res.status(404).json({ error: `File not found on server: ${src}` }); return; }
      const kind = kindForFile(src);
      if (!kind) { res.status(400).json({ error: "Unsupported file type." }); return; }
      res.json(addAsset({ name: path.basename(src), absSrc: src }));
    }),
  );
  app.patch("/api/assets/:id", (req, res) => {
    const a = updateAsset(req.params.id, body(req));
    if (!a) { res.status(404).json({ error: "Asset not found" }); return; }
    res.json(a);
  });
  app.delete("/api/assets/:id", (req, res) => res.json({ ok: deleteAsset(req.params.id) }));
  app.get("/api/assets/:id/file", (req, res) => {
    const a = getAsset(req.params.id);
    if (!a) { res.status(404).json({ error: "Asset not found" }); return; }
    res.sendFile(path.join(DATA_DIR, a.file));
  });

  // ---------- Qwen Image 2.1 boards (stills) ----------

  const boardsOf = (p: Project): ImageBoard[] => (p.boards ??= []);

  app.get("/api/qwen/status", asyncWrap(async (_req, res) => {
    res.json(await resolveQwenModels(deps.getComfy()));
  }));

  app.get("/api/image-jobs", (req, res) => {
    res.json(deps.director.listImageJobs(req.query.projectId as string | undefined));
  });

  app.post("/api/image-jobs/:id/cancel", asyncWrap(async (req, res) => {
    res.json({ ok: await deps.director.cancelImageJob(req.params.id) });
  }));

  app.post(
    "/api/projects/:id/boards",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const { mode, name, prompt, width, height, steps, cfg, imageIds } = body<Partial<ImageBoard>>(req);
      // Canvas/sampling are honoured from the request so a board created with a chosen
      // aspect comes back at that size instead of silently defaulting to square.
      const num = (v: unknown, fallback: number, lo: number, hi: number) => {
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n / 16) * 16)) : fallback;
      };
      // Reference images may be attached up front; drop any id that no longer resolves so
      // an edit board can never be created pointing at a deleted asset.
      const refs = Array.isArray(imageIds)
        ? imageIds.filter((id): id is string => typeof id === "string" && !!getAsset(id))
        : [];
      const board: ImageBoard = {
        id: newBoardId(),
        name: (name ?? `Board ${boardsOf(p).length + 1}`).slice(0, 80),
        mode: mode === "edit" ? "edit" : "t2i",
        prompt: prompt ?? "",
        negativePrompt: "",
        imageIds: refs,
        width: num(width, 1328, 256, 4096),
        height: num(height, 1328, 256, 4096),
        steps: typeof steps === "number" && Number.isFinite(steps)
          ? Math.min(100, Math.max(1, Math.round(steps)))
          : 25,
        cfg: typeof cfg === "number" && Number.isFinite(cfg) ? cfg : 4,
        sampler: "euler",
        scheduler: "simple",
        seedMode: "random",
        seed: Math.floor(Math.random() * 2 ** 32),
        enhancePrompt: false,
        cacheDevice: "auto",
        cacheDtype: "default",
        takes: [],
      };
      boardsOf(p).push(board);
      saveProject(p);
      res.json(board);
    }),
  );

  app.patch(
    "/api/projects/:id/boards/:boardId",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const board = boardsOf(p).find((b) => b.id === req.params.boardId);
      if (!board) { res.status(404).json({ error: "Board not found" }); return; }
      const patch = body<Partial<ImageBoard>>(req);
      Object.assign(board, patch, { id: board.id, takes: board.takes });
      saveProject(p);
      res.json(board);
    }),
  );

  app.delete(
    "/api/projects/:id/boards/:boardId",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const list = boardsOf(p);
      const idx = list.findIndex((b) => b.id === req.params.boardId);
      if (idx < 0) { res.status(404).json({ error: "Board not found" }); return; }
      const [removed] = list.splice(idx, 1);
      saveProject(p);
      try { fs.rmSync(imagesDir(p.id, removed.id), { recursive: true, force: true }); } catch { /* ignore */ }
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/projects/:id/boards/:boardId/render",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const board = boardsOf(p).find((b) => b.id === req.params.boardId);
      if (!board) { res.status(404).json({ error: "Board not found" }); return; }
      const down = await engineOffline();
      if (down) { res.status(409).json({ error: down }); return; }
      const { count } = body<{ count?: number }>(req);
      const n = Math.max(1, Math.min(4, Math.round(count ?? 1)));
      res.json(deps.director.enqueueImageRender(p.id, board.id, n));
    }),
  );

  app.post(
    "/api/projects/:id/boards/:boardId/takes/:takeId/accept",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const board = boardsOf(p).find((b) => b.id === req.params.boardId);
      const take = board?.takes.find((t) => t.id === req.params.takeId);
      if (!board || !take) { res.status(404).json({ error: "Take not found" }); return; }
      const { accepted } = body<{ accepted?: boolean }>(req);
      const on = accepted === undefined ? true : !!accepted;
      for (const t of board.takes) t.accepted = on ? t.id === take.id : t.accepted;
      saveProject(p);
      res.json(board);
    }),
  );

  /** Promote a generated still into the Library so it can be used as a shot's first frame. */
  app.post(
    "/api/projects/:id/boards/:boardId/takes/:takeId/to-asset",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const board = boardsOf(p).find((b) => b.id === req.params.boardId);
      const take = board?.takes.find((t) => t.id === req.params.takeId);
      if (!board || !take?.imageFile) { res.status(404).json({ error: "Take not found" }); return; }
      const abs = path.join(DATA_DIR, take.imageFile);
      if (!fs.existsSync(abs)) { res.status(404).json({ error: "Image file is missing on disk" }); return; }
      res.json(addAsset({ name: `${board.name} ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`, absSrc: abs, role: "" }));
    }),
  );

  // ---------- the still stage: pipeline stage 1 of a shot ----------

  /** Turn a shot's still stage on/off, or switch it between t2i and i2i. */
  app.post(
    "/api/projects/:id/shots/:shotId/still",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const shot = p.shots.find((s) => s.id === req.params.shotId);
      if (!shot) { res.status(404).json({ error: "Shot not found" }); return; }
      const patch = body<Partial<ShotStill>>(req);
      // A missing `mode` means "don't change the mode" — the editor sends plain
      // field patches, and defaulting those to "none" would silently delete the stage.
      const hasMode = patch.mode === "t2i" || patch.mode === "i2i" || patch.mode === "none";
      const next: StillMode = hasMode ? (patch.mode as StillMode) : (shot.still?.mode ?? "none");
      const { mode: _ignored, ...fields } = patch;
      const base = shot.still ? normalizeStill(shot.still) : newStill(next);
      shot.still = { ...base, ...fields, mode: next } as typeof base;
      // Starting a still stage on a text-to-video shot means the video will be
      // driven by an image, so reflect that immediately instead of at render time.
      if (next !== "none" && shot.kind === "t2v") shot.kind = "i2v";
      saveProject(p);
      res.json(shot);
    }),
  );

  /** Render the still on its own (stage 1 only) so the user can iterate on the picture. */
  app.post(
    "/api/projects/:id/shots/:shotId/still/render",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const shot = p.shots.find((s) => s.id === req.params.shotId);
      if (!shot) { res.status(404).json({ error: "Shot not found" }); return; }
      const down = await engineOffline();
      if (down) { res.status(409).json({ error: down }); return; }
      if (!shot.still || shot.still.mode === "none") {
        res.status(400).json({ error: "This shot has no still stage — pick text-to-image or image-to-image first." });
        return;
      }
      await deps.director.renderShotStill(p, shot);
      res.json(shot);
    }),
  );

  /** Promote one of the shot's still takes to be the frame the shot animates. */
  app.post(
    "/api/projects/:id/shots/:shotId/still/takes/:takeId/use",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const shot = p.shots.find((s) => s.id === req.params.shotId);
      const take = shot?.still?.takes.find((t) => t.id === req.params.takeId);
      if (!shot?.still || !take) { res.status(404).json({ error: "Still not found" }); return; }
      if (take.status !== "ok" || !take.imageFile) { res.status(400).json({ error: "That still failed to render." }); return; }
      await deps.director.useStillAsFirstFrame(p, shot, take);
      res.json(shot);
    }),
  );

  // ---------- rendering / export ----------

  /**
   * Refuse render work while the engine is down.
   *
   * Without this the first ComfyUI call fails deep inside the queue and the user only
   * finds out through `Render timed out after 25 minutes` (or a bare "fetch failed")
   * long after clicking. A pre-flight turns it into an immediate, explanatory refusal.
   */
  async function engineOffline(): Promise<string | null> {
    try {
      await deps.getComfy().systemStats();
      return null;
    } catch {
      return "ComfyUI is offline. Start the engine first (the Start button in the top bar, or run_nvidia_gpu.bat in the portable folder), then render.";
    }
  }

  app.post("/api/projects/:id/render", asyncWrap(async (req, res) => {
    const down = await engineOffline();
    if (down) { res.status(409).json({ error: down }); return; }
    const { shotIds, forceChain } = body<{ shotIds?: string[]; forceChain?: boolean }>(req);
    res.json(deps.director.enqueueRender(req.params.id, shotIds ?? [], !!forceChain));
  }));
  app.post("/api/projects/:id/export", asyncWrap(async (req, res) => {
    const { shotIds } = body<{ shotIds?: string[] }>(req);
    res.json(deps.director.enqueueExport(req.params.id, shotIds));
  }));
  app.get("/api/jobs", (_req, res) => {
    const log = readJobLog();
    res.json({ render: [...log.render].reverse(), export: [...log.export].reverse() });
  });
  app.post("/api/jobs/render/:id/cancel", asyncWrap(async (req, res) => {
    res.json({ ok: await deps.director.cancelRender(req.params.id) });
  }));
  app.get("/api/exports", (_req, res) => {
    const log = readJobLog();
    res.json([...log.export].reverse());
  });

  // ---------- AI co-director ----------
  app.post(
    "/api/projects/:id/ai/direct",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const settings = loadSettings();
      const { brief, extra } = body<{ brief?: string; extra?: string }>(req);
      if (!brief?.trim()) {
        res.status(400).json({ error: "Write a brief first (what should the video show?)." });
        return;
      }
      const r0 = await tryResolveAi(settings);
      if (r0.error) { res.status(400).json({ error: r0.error }); return; }
      const resolved = r0.resolved!;

      const result = await directShots(
        { baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey },
        brief,
        extra ?? "",
        listAssets(),
      );
      const assetById = new Map(listAssets().map((a) => [a.name.toLowerCase().replace(/\.[a-z0-9]+$/, ""), a]));
      const shots = draftsToShots(p, result.shots, assetById);
      res.json({ ...result, shots, warnings: result.warnings, provider: resolved.providerId, model: resolved.model });
    }),
  );

  // Structure a raw prompt into the four H3 sections via the co-director LLM.
  app.post(
    "/api/projects/:id/prompt/structure",
    asyncWrap(async (req, res) => {
      const { prompt } = body<{ prompt?: string }>(req);
      if (!prompt?.trim()) {
        res.status(400).json({ error: "Nothing to structure — write a prompt first." });
        return;
      }
      const settings = loadSettings();
      const r0 = await tryResolveAi(settings);
      if (r0.error) { res.status(400).json({ error: r0.error }); return; }
      const resolved = r0.resolved!;
      try {
        const r = await structurePrompt(
          { baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey },
          prompt,
        );
        res.json({ ...r, provider: resolved.providerId, model: resolved.model });
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );

  // Cancel an in-flight structure-all run (by runId). Marks the run so the server
  // stops issuing NEW LLM calls — the call already running is allowed to finish,
  // then the stream ends with a { cancelled: true } done line.
  app.post(
    "/api/projects/:id/prompt/structure-all/cancel",
    asyncWrap(async (req, res) => {
      const { runId } = body<{ runId?: string }>(req);
      if (!runId || !structureActive.has(runId)) {
        res.json({ ok: true, stopping: false }); // nothing running with this id (already finished)
        return;
      }
      structureCancelled.add(runId);
      res.json({ ok: true, stopping: true });
    }),
  );

  // Structure EVERY shot that has a prompt, in timeline order, sequentially.
  // Streams NDJSON: one { type:"shot", ... } line per draft (round 0 and, when
  // rounds=2, a second more-creative draft as round 1), then a final
  // { type:"done", ... } line. Shots already in the four-section format are
  // reported as unchanged (skipped server-side, no LLM call). The changed /
  // skipped / failed counters are per-shot (a shot counts as changed once any
  // of its drafts succeeds).
  //
  // Cancellation: the client passes a runId. POSTing to /prompt/structure-all/cancel
  // with that runId flips a flag; between shots and between drafts of the same shot  //  the loop checks the flag and stops issuing further LLM calls, ending the stream
  //
  // Scoping: passing shotIds limits the pass to that window of the timeline; passing
  // nothing (or an empty list) structures every prompt-bearing shot as before.

  // with a done line carrying cancelled: true.
  app.post(
    "/api/projects/:id/prompt/structure-all",
    asyncWrap(async (req, res) => {
      const p = getProject(req.params.id);
      if (!p) { res.status(404).json({ error: "Project not found" }); return; }
      const settings = loadSettings();
      const r0 = await tryResolveAi(settings);
      if (r0.error) { res.status(400).json({ error: r0.error }); return; }
      const resolved = r0.resolved!;
      const { rounds, runId, shotIds } = body<{ rounds?: number; runId?: string; shotIds?: string[] }>(req);
      const nRounds = rounds === 2 ? 2 : 1; // 1 = current behaviour, 2 = A/B drafts
      const cancelToken = typeof runId === "string" && runId.trim() ? runId.trim() : crypto.randomUUID();
      // shotIds optionally scopes the pass to a window of the timeline (e.g. "from this
      // shot through the next N") — global indices are kept so numbering stays intact.
      const inScope =
        Array.isArray(shotIds) && shotIds.length > 0 ? new Set(shotIds.map((id) => String(id))) : null;
      const candidates = p.shots
        .map((s, idx) => ({ s, idx }))
        .filter(({ s }) => s.prompt.trim().length > 0)
        .filter(({ s }) => !inScope || inScope.has(s.id));
      res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.flushHeaders();
      const line = (o: Record<string, unknown>) => res.write(JSON.stringify(o) + "\n");
      structureActive.add(cancelToken);
      let changed = 0;
      let skipped = 0;
      let failed = 0;
      try {
        for (const { s, idx } of candidates) {
          if (structureCancelled.has(cancelToken)) break;
          if (isStructuredPrompt(s.prompt)) {
            skipped++;
            line({
              type: "shot", shotId: s.id, name: s.name, index: idx, total: candidates.length,
              round: 0, rounds: nRounds, unchanged: true,
            });
            continue;
          }
          let anyOk = false;
          for (let r = 0; r < nRounds; r++) {
            if (structureCancelled.has(cancelToken)) break;
            try {
              const res = await structurePrompt(
                { baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey },
                s.prompt,
                // Draft 2: hotter temperature + explicit "write it differently" instruction
                // so the two drafts are genuinely alternative takes, not near-copies.
                r === 0
                  ? {}
                  : {
                      temperature: 0.95,
                      extraInstruction:
                        "Now write this as an ALTERNATIVE draft: keep every fact, action, line of dialogue and sound detail, but use noticeably different wording, sentence structure and emphasis. Do not drop or invent content.",
                    },
              );
              anyOk = true;
              line({
                type: "shot", shotId: s.id, name: s.name, index: idx, total: candidates.length,
                round: r, rounds: nRounds, unchanged: false, structured: res.structured,
              });
            } catch (e) {
              line({
                type: "shot", shotId: s.id, name: s.name, index: idx, total: candidates.length,
                round: r, rounds: nRounds, unchanged: false,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          if (anyOk) changed++;
          else failed++;
        }
      } finally {
        const cancelled = structureCancelled.has(cancelToken);
        structureActive.delete(cancelToken);
        structureCancelled.delete(cancelToken);
        line({ type: "done", provider: resolved.providerId, model: resolved.model, rounds: nRounds, changed, skipped, failed, cancelled });
        res.end();
      }
    }),
  );

  // ---------- static media ----------
  app.use("/files/library", express.static(LIBRARY_DIR, { maxAge: "1h", fallthrough: true }));
  app.use("/files/outputs", express.static(OUTPUTS_DIR, { maxAge: "1h", fallthrough: true }));
  app.use("/files/exports", express.static(EXPORTS_DIR, { maxAge: "1h", fallthrough: true }));
  app.use("/files/cache", express.static(CACHE_DIR, { maxAge: "1h", fallthrough: true }));
  app.use("/files/images", express.static(IMAGES_DIR, { maxAge: "1h", fallthrough: true }));

  const webDist = path.join(APP_ROOT, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/|files\/|ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("text").send("H3 Director backend is running. Build the web UI with `npm run build` (or run `npm run dev:web`)."),
    );
  }
  return app;
}

/** Split a prompt into two roughly balanced halves, preferring a section-header
 *  boundary (keeps both halves of a structured prompt valid), then a sentence
 *  boundary, then a word boundary near the middle. Returns two trimmed parts. */
function splitPromptText(prompt: string): [string, string] {
  const t = prompt.trim();
  if (!t) return ["", ""];
  const mid = t.length / 2;
  const floor = Math.floor(t.length * 0.3);
  const candidates: number[] = [];
  // Prefer splitting at the start of a later section header so structured prompts
  // split into two still-structured halves (e.g. [Subject + Action] | [Camera …]).
  const headerRe = /\n\[\s*[\w &]+\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(t))) candidates.push(m.index + 1);
  // Then sentence ends (period / ! / ? followed by space).
  const sentRe = /[.!?]["')\]”’]*\s+/g;
  while ((m = sentRe.exec(t))) candidates.push(m.index + m[0].length);
  // Then newlines.
  const nlRe = /\n/g;
  while ((m = nlRe.exec(t))) candidates.push(m.index + 1);
  // Also the last word boundary before the middle as a fallback anchor.
  const wsRe = /\s/g;
  let last = -1;
  while ((m = wsRe.exec(t))) {
    if (m.index < mid) last = m.index + 1;
    else break;
  }
  const usable = candidates.filter((i) => i >= floor && i < t.length);
  let idx = -1;
  if (usable.length) {
    idx = usable.reduce((best, i) => (Math.abs(i - mid) < Math.abs(best - mid) ? i : best), usable[0]);
  } else if (last >= 0) {
    idx = last;
  } else {
    idx = Math.floor(mid);
  }
  const pa = t.slice(0, idx).trim();
  const pb = t.slice(idx).trim();
  return [pa || t, pb || t]; // never return an empty half unless the prompt itself was empty
}

function sanitizeShots(shots: Shot[]): Shot[] {
  if (!Array.isArray(shots)) return [];
  return shots
    .filter((s) => s && typeof s.id === "string")
    .map((s) => ({
      ...s,
      imageIds: Array.isArray(s.imageIds) ? s.imageIds : [],
      videoIds: Array.isArray(s.videoIds) ? s.videoIds : [],
      audioIds: Array.isArray(s.audioIds) ? s.audioIds : [],
      takes: Array.isArray(s.takes) ? s.takes : [],
      prompt: typeof s.prompt === "string" ? s.prompt : "",
      // Keep server-side still takes even if the client payload omits them.
      still: s.still
        ? { ...normalizeStill(s.still), takes: s.still.takes ?? [] }
        : s.still,
    }));
}
