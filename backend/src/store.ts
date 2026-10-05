import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LIBRARY_DIR, OUTPUTS_DIR, EXPORTS_DIR, CACHE_DIR, DATA_DIR, IMAGES_DIR } from "./settings";
import { absData } from "./media";
import type { LibraryAsset, MediaKind, Project, RenderJob, ExportJob, Shot, Take } from "./types";
import { setAcceptedTakes } from "./types";

// ---------- durable JSON writes ----------

/**
 * How many times a corrupt JSON file has been reported. Corruption used to be
 * swallowed by a bare `catch { return undefined }`, which made a project simply
 * vanish from the picker with nothing in any log. Now every read failure is
 * reported on stderr (captured in logs\backend.error.log) and counted, so a
 * damaged file can never disappear silently again.
 */
let corruptReads = 0;

function reportCorrupt(file: string, err: unknown) {
  corruptReads++;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `[store] CORRUPT ${file}: ${msg} (read failure #${corruptReads}). ` +
      `A .bak is kept next to it; move the bad file aside to recover it.`,
  );
}

/** How many JSON parse failures this process has seen — used by the self-test. */
export function corruptReadCount() {
  return corruptReads;
}

/**
 * Write JSON so a crash can never leave a half-written file behind.
 *
 * Writing straight onto the live file means a kill during the write truncates
 * it, and the project then reads back as corrupt. Instead we write a sibling
 * `.tmp`, keep the previous good copy as `.bak`, and `renameSync` into place —
 * rename is atomic within a filesystem, so a reader sees either the old file or
 * the new one, never a partial one.
 */
function writeJsonAtomic(file: string, value: unknown) {
  const json = JSON.stringify(value, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, json, "utf8");
  try {
    // Keep one generation of the last-known-good content before we replace it.
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    /* a missing/failed backup must not block the real write */
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // renameSync can fail if something holds the file open on Windows; fall back
    // to a direct write rather than losing the update entirely.
    console.error(`[store] atomic rename failed for ${file}: ${e instanceof Error ? e.message : String(e)}`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(file, json, "utf8");
  }
}

/**
 * Read a JSON file, reporting corruption instead of hiding it. `fallback` is
 * returned when the file is absent, and `onCorrupt` (when given) decides what to
 * return when the file exists but cannot be parsed.
 */
function readJsonFile<T>(file: string, fallback: T, onCorrupt?: () => T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    reportCorrupt(file, e);
    return onCorrupt ? onCorrupt() : fallback;
  }
}

// ---------- library index ----------

const LIBRARY_INDEX = path.join(DATA_DIR, "library.json");

/**
 * `library.json` re-read on every call. Cache it keyed on mtime+size so the
 * many `getAsset` lookups the render path does per reference do not re-parse
 * the whole file each time. Any external write (or our own write, which changes
 * mtime) invalidates the cache automatically.
 */
let libCache: { mtimeMs: number; size: number; assets: LibraryAsset[] } | null = null;

function readLibrary(): LibraryAsset[] {
  if (!fs.existsSync(LIBRARY_INDEX)) return [];
  const st = fs.statSync(LIBRARY_INDEX);
  if (libCache && libCache.mtimeMs === st.mtimeMs && libCache.size === st.size) return libCache.assets;
  const assets = readJsonFile<{ assets?: LibraryAsset[] }>(LIBRARY_INDEX, { assets: [] }, () => ({ assets: [] }))
    .assets ?? [];
  libCache = { mtimeMs: st.mtimeMs, size: st.size, assets };
  return assets;
}

function writeLibrary(assets: LibraryAsset[]) {
  writeJsonAtomic(LIBRARY_INDEX, { assets });
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
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    // A corrupt project used to be skipped in silence, so it just disappeared
    // from the picker. Report it and try the .bak before giving up.
    const file = path.join(dir, f);
    let p: Project | undefined;
    try {
      p = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      reportCorrupt(file, e);
      p = readBackup(file);
      if (p) console.warn(`[store] recovered project ${f} from its .bak`);
    }
    if (p && Array.isArray(p.shots)) out.push(p);
  }
  return out
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, shots: p.shots }));
}

/** Last-known-good copy of a JSON file, if the atomic write ever left one. */
function readBackup(file: string): any {
  const bak = `${file}.bak`;
  if (!fs.existsSync(bak)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(bak, "utf8"));
  } catch (e) {
    reportCorrupt(bak, e);
    return undefined;
  }
}

export function getProject(id: string): Project | undefined {
  const f = projectFile(id);
  if (!fs.existsSync(f)) return undefined;
  const p = readJsonFile<Project | undefined>(f, undefined, () => {
    const b = readBackup(f);
    if (b) console.warn(`[store] recovered project ${id} from its .bak`);
    return b;
  });
  return p && Array.isArray(p.shots) ? p : undefined;
}

export function saveProject(p: Project) {
  p.updatedAt = Date.now();
  writeJsonAtomic(projectFile(p.id), p);
}

/**
 * Append a take to a shot WITHOUT clobbering concurrent edits.
 *
 * The render queue holds one project object for the whole job, which is correct
 * for reading the shots it is about to render but catastrophic for writing: if
 * you fix a prompt while a render is running, the old in-memory copy still holds
 * the old prompt, and `saveProject(project)` writes it back over your change.
 * The take-reattach in the PUT handler cannot help here because this is
 * server→server, not browser→server.
 *
 * So every take write re-reads the project, appends to the FRESH shot, and
 * persists that. Returns the fresh project so the caller can keep using an
 * up-to-date copy.
 */
export function appendShotTake(projectId: string, shotId: string, take: Take): Project | undefined {
  const fresh = getProject(projectId);
  if (!fresh) return undefined;
  const shot = fresh.shots.find((s) => s.id === shotId);
  if (!shot) return undefined;
  shot.takes.push(take);
  saveProject(fresh);
  return fresh;
}

/**
 * Apply a change to ONE shot's state against the freshest on-disk project.
 *
 * This is the field-wise counterpart of `appendShotTake`, for the still stage:
 * promoting a still has to touch `selectedTakeId`, `firstFrameId`,
 * `continueFromPrev` and `kind` at once, and doing that on a job-long snapshot
 * would again roll back the director's concurrent edits. `fn` receives the FRESH
 * shot, so it never sees stale data. Returns the fresh project.
 */
export function mutateShotOnDisk(
  projectId: string,
  shotId: string,
  fn: (shot: Shot) => void,
): Project | undefined {
  const fresh = getProject(projectId);
  if (!fresh) return undefined;
  const shot = fresh.shots.find((s) => s.id === shotId);
  if (!shot) return undefined;
  fn(shot);
  saveProject(fresh);
  return fresh;
}

/** Append a still take to a shot's still stage, against fresh on-disk state. */
export function appendStillTake(
  projectId: string,
  shotId: string,
  take: Take,
): Project | undefined {
  return mutateShotOnDisk(projectId, shotId, (shot) => {
    if (!shot.still) return;
    shot.still.takes.push(take);
  });
}

export function deleteProject(id: string) {
  fs.rmSync(projectFile(id), { force: true });
  fs.rmSync(`${projectFile(id)}.bak`, { force: true });
  fs.rmSync(`${projectFile(id)}.tmp`, { force: true });
  fs.rmSync(path.join(OUTPUTS_DIR, id), { recursive: true, force: true });
}

// ---------- shot helpers ----------

export function newShotId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * The take a viewer/export should use: the accepted one if the director picked
 * it, otherwise the most recent successful take.
 *
 * The fallback used to be `takes.find(...)`, which returns the OLDEST ok take
 * because takes are pushed in render order — and nothing in the render path ever
 * set `accepted: true`, so re-rendering a shot five times still exported the
 * first attempt forever. Reverse-find, so "latest wins" is the real default.
 */
export function acceptedTakeOf(shot: Shot) {
  const ok = (t: { status: string; accepted?: boolean }) => t.status === "ok";
  return shot.takes.find((t) => ok(t) && t.accepted) ?? lastSuccessfulTake(shot);
}

/**
 * Make exactly one take of a shot the accepted one, clearing the flag on every
 * other take. Returns the new take list, or undefined when the shot is unknown.
 */
export function setAcceptedTake(shot: Shot, takeId: string, accepted: boolean): Take[] | undefined {
  return setAcceptedTakes(shot.takes, takeId, accepted);
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
  // A corrupt jobs.json used to parse as empty and then be overwritten by the
  // next upsert, erasing the whole job history. Quarantine the bad file first so
  // it can still be inspected, and start clean rather than pretending it parsed.
  const quarantine = `${JOB_FILE}.corrupt-${Date.now()}`;
  return readJsonFile<JobLog>(JOB_FILE, { render: [], export: [] }, () => {
    try { fs.renameSync(JOB_FILE, quarantine); } catch { /* ignore */ }
    console.error(`[store] jobs.json was unreadable; moved to ${path.basename(quarantine)} and started a fresh log`);
    return { render: [], export: [] };
  });
}

export function writeJobLog(log: JobLog) {
  // Keep only the last 60 render jobs to avoid unbounded growth.
  log.render = log.render.slice(-60);
  log.export = log.export.slice(-20);
  writeJsonAtomic(JOB_FILE, log);
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
