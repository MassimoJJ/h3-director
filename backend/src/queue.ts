import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ComfyClient } from "./comfy";
import { nodePresence, renderShot, resolveEngineModels } from "./engine";
import { renderImage } from "./qwen";
import { concatVideos, extractLastFrame, probeVideo } from "./ffmpeg";
import { cacheDir, exportsDir, getProject, saveProject, upsertExportJob, upsertRenderJob, acceptedTakeOf, addAsset, getAsset, appendShotTake, appendStillTake, mutateShotOnDisk } from "./store";
import { DATA_DIR, appendJobLog } from "./settings";
import type { AppSettings, ExportJob, ImageBoard, ImageJob, ImageTake, LibraryAsset, Project, RenderJob, Shot, ShotStill, Take } from "./types";

export type BusFn = (event: { type: string; projectId?: string; jobId?: string; data?: unknown }) => void;

interface PendingImage {
  projectId: string;
  boardId: string;
  count: number;
  job: ImageJob;
}

/** A shot's own still stage, queued so it serializes against other GPU work. */
interface PendingShotStill {
  projectId: string;
  shotId: string;
  count: number;
  job: ImageJob;
}

interface PendingRender {
  projectId: string;
  shotIds: string[];
  forceChain: boolean;
  job: RenderJob;
}

interface PendingExport {
  projectId: string;
  shotIds?: string[];
  job: ExportJob;
}

const absolute = (dataRel: string) => (path.isAbsolute(dataRel) ? dataRel : path.join(DATA_DIR, dataRel));

const CANCELLED: RenderJob["status"] = "cancelled";
const OK: RenderJob["status"] = "ok";

/** The shots a job will render, in timeline order. */
function ordered0(project: Project, job: RenderJob): Shot[] {
  return project.shots.filter((s) => job.shotIds.length === 0 || job.shotIds.includes(s.id));
}

export class Director {
  private renderQueue: PendingRender[] = [];
  private exportQueue: PendingExport[] = [];
  private imageQueue: PendingImage[] = [];
  private shotStillQueue: PendingShotStill[] = [];
  private imageJobs = new Map<string, ImageJob>();
  /** Which worker owns each queued image job: a stills board, or a shot's still stage. */
  private imageJobKinds = new Map<string, "board" | "shotStill">();
  private activeRender: RenderJob | null = null;
  private activeExport: ExportJob | null = null;
  private activeImage: ImageJob | null = null;

  constructor(
    private getSettings: () => AppSettings,
    private getComfy: () => ComfyClient,
    private bus: BusFn,
  ) {}

  private emit(type: string, projectId?: string, jobId?: string, data?: unknown) {
    this.bus({ type, projectId, jobId, data });
  }

  // ---------------- render ----------------

  enqueueRender(projectId: string, shotIds: string[], forceChain: boolean): RenderJob {
    const job: RenderJob = {
      id: crypto.randomUUID().slice(0, 8),
      projectId,
      mode: forceChain ? "chainAll" : shotIds.length ? "selected" : "all",
      shotIds: [...shotIds],
      status: "queued",
      perShot: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      takeCount: 0,
    };
    upsertRenderJob(job);
    this.renderQueue.push({ projectId, shotIds: [...shotIds], forceChain, job });
    this.emit("job", projectId, job.id, job);
    void this.pumpRender();
    return job;
  }

  private async pumpRender() {
    if (this.activeRender || this.renderQueue.length === 0) return;
    const item = this.renderQueue.shift()!;
    const { job } = item;
    this.activeRender = job;
    try {
      await this.processRender(item);
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
    this.activeRender = null;
    job.updatedAt = Date.now();
    upsertRenderJob(job);
    this.emit("job", job.projectId, job.id, job);
    this.emit("jobDone", job.projectId, job.id, job);
    void this.pumpRender();
  }

  private async processRender(item: PendingRender) {
    const { projectId, forceChain, job } = item;
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);

    job.status = "running";
    job.error = undefined;
    upsertRenderJob(job);
    appendJobLog(job.id, "info", `Render started: ${ordered0(project, job).length} shot(s)${forceChain ? ", chained" : ""}`, {
      projectId,
      shots: ordered0(project, job).map((s) => s.id),
    });
    this.emit("job", projectId, job.id, job);

    const settings = this.getSettings();
    const comfy = this.getComfy();
    const presence = await nodePresence(comfy, true);
    const missing = ["MiniMaxH3EasyLoader", "MiniMaxH3Easy", "MiniMaxH3EasyOutput", "SaveVideo", "CreateVideo"].filter(
      (k) => !presence.nodes[k],
    );
    if (missing.length) {
      throw new Error(`Required ComfyUI nodes are missing: ${missing.join(", ")}. Restart ComfyUI or reinstall the MiniMaxH3-Easy pack.`);
    }

    const models = await resolveEngineModels(comfy, project);
    if (!models.fl2va && !models.ref2va) throw new Error("No MiniMax H3 model files are available in ComfyUI.");
    if (!models.textEncoder) throw new Error("No Qwen3-VL text encoder is available in ComfyUI.");

    const comfyInputDir = await this.resolveInputDir(settings);
    if (!comfyInputDir) {
      throw new Error(
        "Could not locate the ComfyUI input folder. Open Settings and set the ComfyUI folder path, or make sure the app can auto-discover the running ComfyUI.",
      );
    }

    const ordered = project.shots.filter((s) => job.shotIds.length === 0 || job.shotIds.includes(s.id));
    if (ordered.length === 0) throw new Error("No shots to render (project is empty or the selection is empty).");

    let rendered = 0;
    // Last-frame of the previous shot, extracted and staged for the next shot to chain from.
    let chainFrameAbs: string | null = null;
    // Source clip of chainFrameAbs, so the seam conform can report a framing change.
    let chainSrcVideoAbs: string | null = null;

    /** Last-frame PNG for the shot immediately BEFORE `shot` in timeline order —
     *  taken from this run when just rendered, otherwise extracted from that
     *  shot's latest successful take. Lets a single "Render this shot" chain
     *  without re-rendering the whole project. */
    const prevShotFrame = async (shot: Shot): Promise<string | null> => {
      const idx = project.shots.findIndex((s) => s.id === shot.id);
      if (idx <= 0) return null;
      const prev = project.shots[idx - 1];
      const take =
        prev.takes.find((t) => t.status === "ok" && t.accepted) ??
        [...prev.takes].reverse().find((t) => t.status === "ok"); // newest ok take
      if (!take?.videoFile) return null;
      const framePng = path.join(cacheDir(), `${prev.id}_${take.id}_last.png`);
      const srcVideo = absolute(take.videoFile);
      if (!fs.existsSync(framePng)) await extractLastFrame(srcVideo, framePng).catch(() => null);
      if (!fs.existsSync(framePng)) return null;
      chainSrcVideoAbs = srcVideo;
      return framePng;
    };

    for (let i = 0; i < ordered.length; i++) {
      if (job.status === CANCELLED) return;
      const shot = ordered[i];
      const st = (job.perShot[shot.id] ??= { shotId: shot.id, status: "queued" });
      st.status = "running";
      st.error = undefined;
      job.updatedAt = Date.now();
      upsertRenderJob(job);
      this.emit("job", projectId, job.id, job);

      try {
        const seed = shot.seedMode === "fixed" ? Math.max(0, Math.floor(shot.seed)) : crypto.randomInt(0, 2 ** 32);

        // ---- pipeline stage 1: the shot's own still (Qwen), if it has one ----
        // Runs here rather than in the UI so "Render" means the whole pipeline:
        // still -> video, with no manual promote/pick step in between.
        let stagedStill = false;
        if (shot.still && shot.still.mode !== "none") {
          this.emit("log", projectId, job.id, { level: "info", message: `[${shot.name}] Stage 1/2: rendering the still (${shot.still.mode})…` });
          await this.renderShotStill(project, shot, (pct, label) => {
            st.progress = { pct: Math.round(pct / 2), label }; // first half of the shot's progress
            job.updatedAt = Date.now();
            upsertRenderJob(job);
            this.emit("job", projectId, job.id, job);
          });
          stagedStill = true;
          this.emit("log", projectId, job.id, { level: "info", message: `[${shot.name}] Stage 2/2: animating the still…` });
          st.progress = { pct: 50, label: "Animating still" };
        }

        // A still we just generated is the shot's real first frame, so chaining
        // must not replace it -- even when the user asked to force-chain.
        const wantsChain = !stagedStill && (forceChain || shot.continueFromPrev);
        // The video engine has no progress callback, so hold at the halfway mark
        // rather than showing a stalled 0% for the whole (long) second stage.
        if (stagedStill) {
          st.progress = { pct: 50, label: "Animating the still…" };
          job.updatedAt = Date.now();
          upsertRenderJob(job);
          this.emit("job", projectId, job.id, job);
        }
        // In-run seam if the previous shot rendered in THIS job; otherwise pull
        // the previous shot's stored take (single-shot renders, re-renders).
        let frame: string | null = chainFrameAbs;
        if (wantsChain && !frame) frame = await prevShotFrame(shot);
        const wantChain = wantsChain && frame != null;
        const isRefKind = shot.kind === "r2v";
        const result = await renderShot({
          project,
          shot,
          models,
          seed,
          comfy,
          comfyInputDir,
          timeoutMs: settings.renderTimeoutMin * 60_000,
          firstFrameOverride: wantChain && !isRefKind ? frame : null,
          extraRefImageOverride: wantChain && isRefKind ? frame : null,
          extraWarnings:
            wantsChain && !frame && project.shots.findIndex((s) => s.id === shot.id) > 0
              ? ["Continue-from-previous was requested, but the previous shot has no finished take to chain from — rendered as a fresh video."]
              : undefined,
          r2vContinuationText:
            wantChain && isRefKind
              ? "The scene begins exactly where the previous shot ended. Match the character, pose, framing, lighting and environment of the previous shot's final frame as closely as possible."
              : undefined,
        });

        const absVideo = absolute(result.videoFile);
        const info = await probeVideo(absVideo).catch(() => null);
        if (chainFrameAbs && info?.width && info?.height) {
          const prevInfo = chainSrcVideoAbs ? await probeVideo(chainSrcVideoAbs).catch(() => null) : null;
          if (prevInfo?.width && prevInfo?.height && (prevInfo.width !== info.width || prevInfo.height !== info.height)) {
            const extra =
              `Chained from a ${prevInfo.width}x${prevInfo.height} shot into a ${info.width}x${info.height} canvas: ` +
              "the seam frame was re-framed (centre-cropped/scaled) to fit this shot's resolution.";
            result.warnings.push(extra);
            this.emit("log", projectId, job.id, { level: "warn", message: `[${shot.name}] ${extra}` });
          }
        }
        const take: Take = {
          id: crypto.randomUUID().slice(0, 8),
          seed,
          createdAt: Date.now(),
          status: "ok",
          videoFile: result.videoFile,
          thumbFile: result.thumbFile,
          promptId: result.promptId,
          accepted: false,
          meta: {
            durationS: info?.durationS,
            fps: info?.fps,
            width: info?.width,
            height: info?.height,
            compiledPrompt: result.compiledPrompt,
            warnings: result.warnings,
          },
        };
        // Append through the store rather than saveProject(project): the local
        // `project` is a snapshot from the start of the job, so writing it back
        // would revert every prompt/duration edit made while this job ran.
        const fresh = appendShotTake(projectId, shot.id, take);
        // Keep our local copy in step with what was just persisted, so the next
        // shot's still-stage write merges onto the new state instead of stale one.
        if (fresh) {
          const i2 = fresh.shots.findIndex((s) => s.id === shot.id);
          if (i2 >= 0) ordered[i] = fresh.shots[i2];
        }
        st.status = "ok";
        st.takeId = take.id;
        rendered++;
        job.takeCount = rendered;

        // The durable record of this take: seed, prompt and any warnings, kept
        // even if the browser is long gone by the time you look for it.
        appendJobLog(job.id, "ok", `[${shot.name}] rendered`, {
          shotId: shot.id,
          takeId: take.id,
          seed,
          promptId: take.promptId,
          compiledPrompt: result.compiledPrompt,
          warnings: result.warnings.length ? result.warnings : undefined,
        });

        // Prepare the seam for the NEXT shot when that shot will chain from this one.
        chainFrameAbs = null;
        chainSrcVideoAbs = null;
        const nextWantsChain = i + 1 < ordered.length && (forceChain || ordered[i + 1].continueFromPrev);
        if (nextWantsChain) {
          const framePng = path.join(cacheDir(), `${shot.id}_${take.id}_last.png`);
          await extractLastFrame(absVideo, framePng).catch(() => null);
          if (fs.existsSync(framePng)) {
            chainFrameAbs = framePng;
            chainSrcVideoAbs = absVideo;
          }
        }
        this.emit("shotDone", projectId, job.id, { shotId: shot.id, take, project });
        this.emit("job", projectId, job.id, job);
      } catch (e) {
        chainFrameAbs = null;
        const msg = e instanceof Error ? e.message : String(e);
        // Same reload-and-merge as the success path — an error take must never
        // be the reason your other edits get rolled back.
        //
        // promptId is recorded on the ERROR path too (it used to be omitted, so
        // a failed take could not be traced back to /history/<id>).
        const freshErr = appendShotTake(projectId, shot.id, {
          id: crypto.randomUUID().slice(0, 8),
          seed: shot.seedMode === "fixed" ? shot.seed : 0,
          createdAt: Date.now(),
          status: "error",
          error: msg,
          promptId: /prompt ([0-9a-f-]{8,})/.exec(msg)?.[1],
          accepted: false,
        });
        // Write it where it will still be there tomorrow: the WebSocket log
        // lines only exist in the browser, and vanish on restart.
        appendJobLog(job.id, "error", `[${shot.name}] ${msg}`, { shotId: shot.id, promptId: /prompt ([0-9a-f-]{8,})/.exec(msg)?.[1] });
        if (freshErr) {
          const i2 = freshErr.shots.findIndex((s) => s.id === shot.id);
          if (i2 >= 0) ordered[i] = freshErr.shots[i2];
        }
        st.status = "error";
        st.error = msg;
        this.emit("shotDone", projectId, job.id, { shotId: shot.id, error: msg, project });
        this.emit("job", projectId, job.id, job);
      }
    }

    if (job.status === CANCELLED) return;
    const anyOk = ordered.some((s) => job.perShot[s.id]?.status === OK);
    job.status = anyOk ? "done" : "error";
    if (!anyOk) job.error = "No shots rendered successfully — see per-shot errors.";
    appendJobLog(job.id, job.status, `Render finished: ${rendered} take(s)`, {
      projectId,
      status: job.status,
      error: job.error,
    });
  }

  async cancelRender(jobId: string): Promise<boolean> {
    const active = this.activeRender;
    const queued = this.renderQueue.find((q) => q.job.id === jobId);
    const target = queued?.job ?? (active?.id === jobId ? active : null);
    if (!target) return false;
    target.status = "cancelled";
    upsertRenderJob(target);
    this.renderQueue = this.renderQueue.filter((q) => q.job.id !== jobId);
    if (active?.id === jobId) {
      try {
        await this.getComfy().interrupt();
      } catch {
        /* ignore */
      }
    }
    this.emit("job", target.projectId, jobId, target);
    return true;
  }

  // ---------------- export ----------------
  // ---------------- Qwen Image 2.1 stills ----------------
  /**
   * Render `count` variants of a board. Queued through the same serial pump as the
   * video renders so an image job never fights a video job for the GPU.
   */
  enqueueImageRender(projectId: string, boardId: string, count = 1): ImageJob {
    const project = getProject(projectId);
    const board = project?.boards?.find((b) => b.id === boardId);
    const job: ImageJob = {
      id: crypto.randomUUID().slice(0, 8),
      projectId,
      boardId,
      boardName: board?.name ?? "Image",
      status: "queued",
      progress: { pct: 0, label: "Queued" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.imageQueue.push({ projectId, boardId, count, job });
    this.imageJobs.set(job.id, job);
    this.imageJobKinds.set(job.id, "board");
    this.pruneImageJobs();
    this.emit("imageJob", projectId, job.id, job);
    void this.pumpImage();
    return job;
  }

  /**
   * Queue a single shot's still stage through the same serial pump as every other
   * GPU job, and return immediately.
   *
   * This used to `await renderShotStill(...)` on the request thread. That had two
   * real consequences: the browser request hung for the whole (multi-minute)
   * render, and — because the only concurrency guard lives in `pumpImage` — a
   * second click, or a still click during a video render, put two jobs on the GPU
   * at once and could OOM the card. Going through the queue makes stills serialize
   * against images, videos and exports exactly like everything else.
   */
  enqueueShotStill(projectId: string, shotId: string, count = 1): ImageJob {
    const project = getProject(projectId);
    const shot = project?.shots.find((s) => s.id === shotId);
    const job: ImageJob = {
      id: crypto.randomUUID().slice(0, 8),
      projectId,
      boardId: shotId,
      boardName: shot ? `${shot.name || "Shot"} — still` : "Shot still",
      status: "queued",
      progress: { pct: 0, label: "Queued" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.shotStillQueue.push({ projectId, shotId, count, job });
    this.imageJobs.set(job.id, job);
    this.imageJobKinds.set(job.id, "shotStill");
    this.pruneImageJobs();
    this.emit("imageJob", projectId, job.id, job);
    void this.pumpImage();
    return job;
  }

  /**
   * `imageJobs` only ever grew, was returned unpaginated by /api/image-jobs and
   * vanished on restart, so a long session accumulated every still job ever made.
   * Cap it, never dropping a job that is still queued or running.
   */
  private pruneImageJobs() {
    const MAX_JOBS = 200;
    if (this.imageJobs.size <= MAX_JOBS) return;
    const live = new Set<string>([
      ...this.imageQueue.map((q) => q.job.id),
      ...this.shotStillQueue.map((q) => q.job.id),
    ]);
    if (this.activeImage) live.add(this.activeImage.id);
    const finished = [...this.imageJobs.values()]
      .filter((j) => j.status !== "queued" && j.status !== "running" && !live.has(j.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const j of finished) {
      if (this.imageJobs.size <= MAX_JOBS) break;
      this.imageJobs.delete(j.id);
    }
  }

  private async pumpImage() {
    if (this.activeImage) return;
    if (this.imageQueue.length === 0 && this.shotStillQueue.length === 0) return;
    // Images, stills and video share one GPU: wait for any running render first.
    if (this.activeRender || this.activeExport) {
      setTimeout(() => void this.pumpImage(), 1500);
      return;
    }
    // Dispatch by asking each worker to claim `job`, rather than shifting here,
    // so the item stays on its own queue until a worker actually takes it.
    const next = this.imageQueue[0] ?? this.shotStillQueue[0];
    if (!next) return;
    const job = next.job;
    this.activeImage = job;
    try {
      await this.processNextImageItem(job);
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
    this.activeImage = null;
    job.updatedAt = Date.now();
    this.imageJobs.set(job.id, job);
    this.emit("imageJob", job.projectId, job.id, job);
    this.emit("imageJobDone", job.projectId, job.id, job);
    void this.pumpImage();
  }

  /**
   * Run the queued item matching `job` with the right worker, removing it from
   * its queue first. `imageJobKinds` is the authority on which worker a job
   * belongs to, so a shot whose still stage was switched off mid-queue still
   * reports the right failure instead of silently running as a board job.
   */
  private async processNextImageItem(job: ImageJob) {
    if (this.imageJobKinds.get(job.id) === "shotStill") {
      this.imageJobKinds.delete(job.id);
      const found = this.shotStillQueue.find((q) => q.job.id === job.id);
      this.shotStillQueue = this.shotStillQueue.filter((q) => q.job.id !== job.id);
      await this.processShotStillJob(found ?? { projectId: job.projectId, shotId: job.boardId, count: 1, job });
      return;
    }
    this.imageJobKinds.delete(job.id);
    const found = this.imageQueue.find((q) => q.job.id === job.id);
    this.imageQueue = this.imageQueue.filter((q) => q.job.id !== job.id);
    await this.processImage(found ?? { projectId: job.projectId, boardId: job.boardId, count: 1, job });
  }

  /**
   * Render a shot's still stage as a tracked, cancellable, serialized job.
   * Every write goes through the fresh-state store helpers so a concurrent edit
   * by the director is never reverted.
   */
  private async processShotStillJob(item: PendingShotStill) {
    const { projectId, shotId, count, job } = item;
    job.status = "running";
    job.progress = { pct: 0, label: "Rendering still" };
    this.emit("imageJob", projectId, job.id, job);

    const project0 = getProject(projectId);
    const shot0 = project0?.shots.find((s) => s.id === shotId);
    if (!project0 || !shot0?.still || shot0.still.mode === "none") {
      throw new Error("This shot has no still stage.");
    }
    const settings = this.getSettings();
    const comfyInputDir = await this.resolveInputDir(settings);
    if (!comfyInputDir) throw new Error("Could not locate the ComfyUI input folder. Check Settings.");

    const n = Math.max(1, Math.min(4, Math.round(count)));
    let made = 0;
    for (let i = 0; i < n; i++) {
      if (job.status === CANCELLED) break;
      // Re-read every variant: the still config may have been edited meanwhile.
      const project = getProject(projectId);
      const shot = project?.shots.find((s) => s.id === shotId);
      if (!project || !shot?.still || shot.still.mode === "none") break;
      try {
        const chosen = await this.renderShotStill(project, shot, (pct, label) => {
          job.progress = { pct: Math.round(((i + pct / 100) / n) * 100), label };
          job.updatedAt = Date.now();
          this.imageJobs.set(job.id, job);
          this.emit("imageJob", projectId, job.id, job);
        });
        made++;
        this.emit("shotStillDone", projectId, job.id, { shotId, take: chosen });
      } catch (e) {
        // A failed variant must not abort the rest, and must not revert edits.
        appendStillTake(projectId, shotId, {
          id: crypto.randomUUID().slice(0, 8),
          seed: 0,
          createdAt: Date.now(),
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          accepted: false,
        });
      }
    }
    if (made === 0 && job.status !== CANCELLED) {
      throw new Error("The still stage produced no image.");
    }
    job.status = job.status === CANCELLED ? CANCELLED : "done";
    job.progress = { pct: 100, label: "Done" };
    this.emit("project", projectId);
  }

  private async processImage(item: PendingImage) {
    const { projectId, boardId, count, job } = item;
    const settings = this.getSettings();
    const comfy = this.getComfy();

    const reload = (): { project: Project; board: ImageBoard } | null => {
      const p = getProject(projectId);
      const b = p?.boards?.find((x) => x.id === boardId);
      return p && b ? { project: p, board: b } : null;
    };
    if (!reload()) throw new Error("Board not found.");

    const comfyInputDir = await this.resolveInputDir(settings);
    if (!comfyInputDir) {
      throw new Error(
        "Could not locate the ComfyUI input folder. Open Settings and set the ComfyUI folder path, or let the app auto-discover the running ComfyUI.",
      );
    }

    for (let i = 0; i < count; i++) {
      if (job.status === CANCELLED) return;
      const ctx = reload();
      if (!ctx) throw new Error("Board was deleted while rendering.");
      const { project, board } = ctx;
      const seed = board.seedMode === "fixed" ? Math.max(0, Math.floor(board.seed)) : crypto.randomInt(0, 2 ** 32);
      job.status = "running";
      job.progress = { pct: Math.round((i / count) * 100), label: `Rendering ${i + 1} of ${count}` };
      job.updatedAt = Date.now();
      this.imageJobs.set(job.id, job);
      this.emit("imageJob", projectId, job.id, job);

      try {
        const result = await renderImage({ project, board, seed, comfy, comfyInputDir, destId: board.id, timeoutMs: settings.imageTimeoutMin * 60_000 });
        // Re-read: the board object may have been replaced by a save in the meantime.
        const after = reload();
        if (after) {
          after.board.takes.push({
            id: crypto.randomUUID().slice(0, 8),
            seed: result.seed,
            createdAt: Date.now(),
            status: "ok",
            imageFile: result.imageFile,
            promptId: result.promptId,
            width: result.width,
            height: result.height,
            compiledPrompt: result.compiledPrompt,
            warnings: result.warnings,
            accepted: false,
          });
          saveProject(after.project);
        }
      } catch (e) {
        const after = reload();
        const msg = e instanceof Error ? e.message : String(e);
        if (after) {
          after.board.takes.push({
            id: crypto.randomUUID().slice(0, 8),
            seed,
            createdAt: Date.now(),
            status: "error",
            error: msg,
            accepted: false,
          });
          saveProject(after.project);
        }
        job.status = "error";
        job.error = msg;
        job.updatedAt = Date.now();
        this.imageJobs.set(job.id, job);
        this.emit("imageJob", projectId, job.id, job);
        this.emit("imageJobDone", projectId, job.id, job);
        return;
      }
    }

    job.status = "done";
    job.progress = { pct: 100, label: "Done" };
    job.updatedAt = Date.now();
    this.imageJobs.set(job.id, job);
    this.emit("imageJob", projectId, job.id, job);
  }

  listImageJobs(projectId?: string): ImageJob[] {
    const all = [...this.imageJobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    return projectId ? all.filter((j) => j.projectId === projectId) : all;
  }

  async cancelImageJob(jobId: string): Promise<boolean> {
    // A queued shot still cancels the same way a board job does.
    const queuedShotStill = this.shotStillQueue.find((q) => q.job.id === jobId);
    if (queuedShotStill) {
      queuedShotStill.job.status = CANCELLED;
      this.shotStillQueue = this.shotStillQueue.filter((q) => q.job.id !== jobId);
      this.imageJobKinds.delete(jobId);
      this.emit("imageJob", queuedShotStill.job.projectId, jobId, queuedShotStill.job);
      return true;
    }
    const queued = this.imageQueue.find((q) => q.job.id === jobId);
    if (queued) {
      queued.job.status = CANCELLED;
      this.imageQueue = this.imageQueue.filter((q) => q.job.id !== jobId);
      this.imageJobKinds.delete(jobId);
      this.emit("imageJob", queued.job.projectId, jobId, queued.job);
      return true;
    }
    const active = this.activeImage?.id === jobId ? this.activeImage : null;
    if (!active) return false;
    active.status = CANCELLED;
    this.emit("imageJob", active.projectId, jobId, active);
    try { await this.getComfy().interrupt(); } catch { /* ignore */ }
    return true;
  }



  enqueueExport(projectId: string, shotIds?: string[]): ExportJob {
    const job: ExportJob = {
      id: crypto.randomUUID().slice(0, 8),
      projectId,
      shotIds: shotIds ? [...shotIds] : [],
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertExportJob(job);
    this.exportQueue.push({ projectId, shotIds: shotIds ? [...shotIds] : undefined, job });
    this.emit("export", projectId, job.id, job);
    void this.pumpExport();
    return job;
  }

  private async pumpExport() {
    if (this.activeExport || this.exportQueue.length === 0) return;
    const item = this.exportQueue.shift()!;
    this.activeExport = item.job;
    try {
      await this.processExport(item);
    } catch (e) {
      item.job.status = "error";
      item.job.error = e instanceof Error ? e.message : String(e);
    }
    this.activeExport = null;
    item.job.updatedAt = Date.now();
    upsertExportJob(item.job);
    this.emit("export", item.job.projectId, item.job.id, item.job);
  }

  private async processExport(item: PendingExport) {
    const { projectId, job } = item;
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found.`);
    job.status = "running";
    upsertExportJob(job);
    this.emit("export", projectId, job.id, job);

    const ordered = project.shots.filter((s) => (job.shotIds.length ? job.shotIds.includes(s.id) : true));
    const files: string[] = [];
    for (const shot of ordered) {
      const take = acceptedTakeOf(shot);
      if (take && take.status === "ok" && take.videoFile) files.push(absolute(take.videoFile));
    }
    if (files.length === 0) throw new Error("No rendered takes to export — render some shots first.");

    const outAbs = path.join(exportsDir(), `${job.id}.mp4`);
    await concatVideos(files, outAbs);
    job.file = `exports/${job.id}.mp4`;
    job.status = "done";
    this.emit("export", projectId, job.id, job);
  }

  // ---------------- still stage (pipeline stage 1) ----------------

  /**
   * Run a shot's Qwen still stage. Returns the take the shot should animate:
   * the one the user picked, or the newest successful one.
   *
   * The rendered PNG is promoted into the Library automatically — a still that
   * drives a shot is not a throwaway, and this removes the manual
   * "promote -> switch tab -> pick asset" hop entirely.
   */
  async renderShotStill(project: Project, shot: Shot, onProgress?: (pct: number, label: string) => void): Promise<ImageTake> {
    const still = shot.still!;
    const comfyInputDir = await this.resolveInputDir(this.getSettings());
    const n = Math.max(1, Math.min(4, Math.round(still.variants || 1)));
    const rendered: ImageTake[] = [];

    for (let i = 0; i < n; i++) {
      onProgress?.(Math.round((i / n) * 100), `Still ${i + 1} of ${n}`);
      const seed = still.seedMode === "fixed" ? Math.max(0, Math.floor(still.seed)) : crypto.randomInt(0, 2 ** 32);
      try {
        const out = await renderImage({
          project,
          board: still,
          fallbackPrompt: shot.prompt,
          seed,
          comfy: this.getComfy(),
          comfyInputDir,
          destId: `shot-${shot.id}`,
          timeoutMs: this.getSettings().imageTimeoutMin * 60_000,
        });
        const take: ImageTake = {
          id: crypto.randomUUID().slice(0, 8),
          seed,
          createdAt: Date.now(),
          status: "ok",
          imageFile: out.imageFile,
          promptId: out.promptId,
          width: out.width,
          height: out.height,
          compiledPrompt: out.compiledPrompt,
          warnings: out.warnings,
          accepted: false,
        };
        rendered.push(take);
        // Append against fresh on-disk state (see appendShotTake): writing the
        // job-long `project` snapshot back would revert the user's edits.
        appendStillTake(project.id, shot.id, take);
        this.emit("project", project.id);
      } catch (e) {
        // A failed variant must not abort the whole still stage: keep the ones
        // that worked and report the failure alongside them.
        appendStillTake(project.id, shot.id, {
          id: crypto.randomUUID().slice(0, 8),
          seed,
          createdAt: Date.now(),
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          accepted: false,
        });
      }
    }

    const ok = rendered.filter((t) => t.status === "ok" && t.imageFile);
    if (ok.length === 0) {
      const lastErr = still.takes.filter((t) => t.status === "error").pop()?.error;
      throw new Error(lastErr ?? "The still stage produced no image.");
    }

    // Honour an explicit pick when it still exists, else fall back to the newest.
    const picked = still.selectedTakeId
      ? ok.find((t) => t.id === still.selectedTakeId)
      : undefined;
    const chosen = picked ?? ok[ok.length - 1];
    await this.useStillAsFirstFrame(project, shot, chosen);
    return chosen;
  }

  /** Promote a still take into the Library and point the shot's first frame at it. */
  async useStillAsFirstFrame(project: Project, shot: Shot, take: ImageTake): Promise<LibraryAsset> {
    if (!take.imageFile) throw new Error("That still has no image file.");
    const abs = absolute(take.imageFile);
    if (!fs.existsSync(abs)) throw new Error("The still's image file is missing on disk.");
    const asset = addAsset({ name: `${shot.name || "Shot"} still ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`, absSrc: abs });
    // Four fields change together, so write them against fresh on-disk state in
    // one pass rather than persisting a job-long snapshot.
    mutateShotOnDisk(project.id, shot.id, (s) => {
      if (s.still) s.still.selectedTakeId = take.id;
      s.firstFrameId = asset.id;
      // A still we generated is always the real first frame — it must not be
      // overwritten by the seamless-chaining logic during the video render.
      s.continueFromPrev = false;
      // The still now drives the shot, so an image-mode render is required.
      if (s.kind === "t2v") s.kind = "i2v";
    });
    this.emit("project", project.id);
    return asset;
  }

  // ---------------- helpers ----------------

  private async resolveInputDir(settings: AppSettings): Promise<string> {
    if (settings.comfyRoot) {
      const input = path.join(settings.comfyRoot, "input");
      if (fs.existsSync(input)) return input;
    }
    const { discoverComfyRoot } = await import("./media");
    const root = await discoverComfyRoot();
    if (root && fs.existsSync(path.join(root, "input"))) return path.join(root, "input");
    return "";
  }
}

export type { Project, Shot };
