import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LIBRARY_DIR, OUTPUTS_DIR, EXPORTS_DIR, CACHE_DIR, DATA_DIR, IMAGES_DIR } from "./settings";
import { absData } from "./media";
import type { LibraryAsset, MediaKind, Project, RenderJob, ExportJob, Shot } from "./types";

// ---------- library index ----------

const LIBRARY_INDEX = path.join(DATA_DIR, "library.json");

function readLibrary(): LibraryAsset[] {
  if (!fs.existsSync(LIBRARY_INDEX)) return [];
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_INDEX, "utf8")).assets ?? [];
  } catch {
    return [];
  }
}

function writeLibrary(assets: LibraryAsset[]) {
  fs.writeFileSync(LIBRARY_INDEX, JSON.stringify({ assets }, null, 2), "utf8");
}

export function listAssets(): LibraryAsset[] {
  return readLibrary().sort((a, b) => b.createdAt - a.createdAt);
}

export function getAsset(id: string): LibraryAsset | undefined {
  return readLibrary().find((a) => a.id === id);
}

const EXT_BY_MIME: Record<string, MediaKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".bmp": "image", ".heic": "image",
  ".wav": "audio", ".mp3": "audio", ".flac": "audio", ".m4a": "audio", ".ogg": "audio", ".aac": "audio",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video", ".avi": "video", ".m4v": "video",
};

export function kindForFile(file: string): MediaKind | null {
  const ext = path.extname(file).toLowerCase();
  return EXT_BY_MIME[ext] ?? null;
}

export interface NewAssetInput {
  name: string;
  absSrc: string;
  kind?: MediaKind;
  role?: string;
  tags?: string[];
}

export function addAsset(input: NewAssetInput): LibraryAsset {
  const kind = input.kind ?? kindForFile(input.absSrc);
  if (!kind) throw new Error(`Unsupported file type: ${input.name}`);
  const id = crypto.randomUUID();
  const ext = path.extname(input.absSrc).toLowerCase() || ".bin";
  const file = `library/${id}${ext}`;
  const dest = absData(file);
  fs.copyFileSync(input.absSrc, dest);
  const asset: LibraryAsset = {
    id,
    kind,
    name: input.name,
    file,
    size: fs.statSync(dest).size,
    createdAt: Date.now(),
    role: input.role ?? "",
    tags: input.tags ?? [],
  };
  const assets = readLibrary();
  assets.push(asset);
  writeLibrary(assets);
  return asset;
}

export function updateAsset(id: string, patch: { name?: string; role?: string; tags?: string[] }): LibraryAsset | undefined {
  const assets = readLibrary();
  const idx = assets.findIndex((a) => a.id === id);
  if (idx < 0) return undefined;
  if (patch.name) assets[idx].name = patch.name;
  if (patch.role !== undefined) assets[idx].role = patch.role;
  if (patch.tags) assets[idx].tags = patch.tags;
  writeLibrary(assets);
  return assets[idx];
}

export function deleteAsset(id: string): boolean {
  const assets = readLibrary();
  const idx = assets.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  const [removed] = assets.splice(idx, 1);
  writeLibrary(assets);
  try {
    fs.rmSync(absData(removed.file), { force: true });
  } catch {
    /* ignore */
  }
  return true;
}

// ---------- projects ----------

function projectsDir() {
  const d = path.join(DATA_DIR, "projects");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function projectFile(id: string) {
  return path.join(projectsDir(), `${id}.json`);
}

export function listProjects(): Array<Pick<Project, "id" | "name" | "createdAt" | "updatedAt" | "shots">> {
  const dir = projectsDir();
  const out: Project[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      out.push(p);
    } catch {
      /* skip */
    }
  }
  return out
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, shots: p.shots }));
}

export function getProject(id: string): Project | undefined {
  const f = projectFile(id);
  if (!fs.existsSync(f)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
}

export function saveProject(p: Project) {
  p.updatedAt = Date.now();
  fs.writeFileSync(projectFile(p.id), JSON.stringify(p, null, 2), "utf8");
}

export function deleteProject(id: string) {
  fs.rmSync(projectFile(id), { force: true });
  fs.rmSync(path.join(OUTPUTS_DIR, id), { recursive: true, force: true });
}

// ---------- shot helpers ----------

export function newShotId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function acceptedTakeOf(shot: Shot) {
  return shot.takes.find((t) => t.status === "ok" && t.accepted) ?? shot.takes.find((t) => t.status === "ok");
}

export function lastSuccessfulTake(shot: Shot) {
  return [...shot.takes].reverse().find((t) => t.status === "ok");
}

// ---------- jobs ----------

export interface JobLog {
  render: RenderJob[];
  export: ExportJob[];
}

const JOB_FILE = path.join(DATA_DIR, "jobs.json");

export function readJobLog(): JobLog {
  if (!fs.existsSync(JOB_FILE)) return { render: [], export: [] };
  try {
    return JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
  } catch {
    return { render: [], export: [] };
  }
}

export function writeJobLog(log: JobLog) {
  // Keep only the last 60 render jobs to avoid unbounded growth.
  log.render = log.render.slice(-60);
  log.export = log.export.slice(-20);
  fs.writeFileSync(JOB_FILE, JSON.stringify(log, null, 2), "utf8");
}

/**
 * Mark jobs that were still in flight when the process last exited.
 *
 * A render/export job only lives in memory while it runs; the JSON log is just a
 * snapshot. If the backend is killed or restarted mid-render, the snapshot is
 * left saying "queued"/"running" but no queue will ever pick it up again. The
 * UI treats any queued/running job as active, so a stale entry makes a shot look
 * like it is rendering forever and disables the Render buttons app-wide.
 *
 * Called once at startup, when we know for certain the in-memory queues are
 * empty, so every such job is genuinely orphaned.
 */
export function reconcileOrphanJobs(): number {
  const log = readJobLog();
  const stuck = (s?: string) => s === "queued" || s === "running";
  let fixed = 0;

  for (const job of log.render) {
    if (!stuck(job.status)) continue;
    const reason = "Interrupted — the app restarted while this render was in progress.";
    for (const st of Object.values(job.perShot ?? {})) {
      if (st.status === "queued" || st.status === "running") {
        st.status = "cancelled";
        st.error = reason;
      }
    }
    job.status = "cancelled";
    job.error = reason;
    job.updatedAt = Date.now();
    fixed++;
  }

  for (const job of log.export) {
    if (!stuck(job.status)) continue;
    job.status = "cancelled";
    job.error = "Interrupted — the app restarted while this export was in progress.";
    job.updatedAt = Date.now();
    fixed++;
  }

  if (fixed) writeJobLog(log);
  return fixed;
}

export function upsertRenderJob(job: RenderJob) {
  const log = readJobLog();
  const idx = log.render.findIndex((j) => j.id === job.id);
  if (idx >= 0) log.render[idx] = job;
  else log.render.push(job);
  writeJobLog(log);
}

export function upsertExportJob(job: ExportJob) {
  const log = readJobLog();
  const idx = log.export.findIndex((j) => j.id === job.id);
  if (idx >= 0) log.export[idx] = job;
  else log.export.push(job);
  writeJobLog(log);
}

export function ensureOutputDirs(projectId: string, shotId: string) {
  const d = path.join(OUTPUTS_DIR, projectId, shotId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function exportsDir() {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  return EXPORTS_DIR;
}

export function cacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

// ---------- media cleanup ----------
// Deleting a shot (or a project) used to drop only the JSON entry, so every deleted
// shot leaked its rendered takes, its still-stage images and its cached last frames
// for good. These two helpers remove exactly the media a shot/project owns.
//
// Library assets are deliberately NOT touched: they are user-owned media that other
// shots and boards may still reference, and the Library has its own delete button.

function rmDir(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  try {
    fs.rmSync(abs, { recursive: true, force: true });
    return abs;
  } catch {
    // A file locked by ffmpeg/ComfyUI must not fail the whole delete.
    return null;
  }
}

/** Remove one shot's takes/thumbs, still-stage images and cached last-frame PNGs. */
export function purgeShotMedia(projectId: string, shotId: string): string[] {
  const removed: string[] = [];
  for (const d of [path.join(OUTPUTS_DIR, projectId, shotId), path.join(IMAGES_DIR, projectId, `shot-${shotId}`)]) {
    const gone = rmDir(d);
    if (gone) removed.push(gone);
  }
  // Cache files are flat, named "<shotId>_<takeId>_last.png".
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.startsWith(`${shotId}_`)) continue;
      const p = path.join(CACHE_DIR, f);
      try {
        fs.rmSync(p, { force: true });
        removed.push(p);
      } catch {
        /* locked - skip */
      }
    }
  } catch {
    /* cache dir does not exist yet */
  }
  return removed;
}

/** Remove everything a whole project owns: every shot's media plus its images tree. */
export function purgeProjectMedia(project: Project): string[] {
  const removed: string[] = [];
  for (const s of project.shots) removed.push(...purgeShotMedia(project.id, s.id));
  for (const d of [path.join(OUTPUTS_DIR, project.id), path.join(IMAGES_DIR, project.id)]) {
    const gone = rmDir(d);
    if (gone) removed.push(gone);
  }
  // Exports are per job (exports/<jobId>.mp4) and stay - they are finished films.
  return removed;
}
