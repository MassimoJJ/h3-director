import { useCallback, useEffect, useRef, useState } from "react";
import { api, onBusEvent } from "./api";
import type {
  AppSettings,
  EngineProbe,
  ExportJob,
  LibraryAsset,
  Project,
  RenderJob,
  Shot,
} from "./api";
import { UiCtx, useUi, type Ui } from "./ui";
import { MediaViewer, type MediaTarget } from "./MediaViewer";
import { uploadFilesToLibrary } from "./DropZone";
import { ImagesView } from "./ImagesView";
import { AiPane, ExportView, GalleryView, LibraryView, ScriptView, SettingsView } from "./views";

export type Tab = "script" | "images" | "library" | "gallery" | "export";

/** Which project was open last time this browser loaded the app. */
const PROJECT_KEY = "h3.projectId";

/**
 * How long to wait after the last keystroke before writing the project.
 *
 * Long enough that a typed word is one write, short enough that a pause in
 * thinking still feels saved. Anything that needs the state flushed right now
 * (blur, render, export, project switch, tab close) calls `flushSave`.
 */
const SAVE_DEBOUNCE_MS = 500;

/** localStorage is best-effort (throws in restricted webviews), like the timeline keys. */
function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProjectId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(PROJECT_KEY, id);
    else window.localStorage.removeItem(PROJECT_KEY);
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [status, setStatus] = useState<EngineProbe | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [project, setProject] = useState<Project | null>(null);
  // The newest project, readable from callbacks that would otherwise close over
  // a stale copy. Save handlers run after the state update has been scheduled, so
  // they must not depend on the `project` binding being current.
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [jobs, setJobs] = useState<{ render: RenderJob[]; export: ExportJob[] }>({ render: [], export: [] });
  const [tab, setTab] = useState<Tab>("script");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);
  // The one full-screen image/video viewer. Any thumbnail can open into it.
  const [viewer, setViewer] = useState<MediaTarget | null>(null);
  const openMedia = useCallback((m: MediaTarget) => setViewer(m), []);

  // The open project outlives a reload: the ref starts from localStorage (read once,
  // lazily) and selectProject writes it back.
  const projectIdRef = useRef<string | null>(null);
  const restoredProject = useRef(false);
  if (!restoredProject.current) {
    restoredProject.current = true;
    projectIdRef.current = readStoredProjectId();
  }
  const toastId = useRef(0);

  const toast = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [st, pr, as, js] = await Promise.all([api.status(), api.listProjects(), api.assets(), api.jobs()]);
      setStatus(st);
      setSettings(st.settings);
      setProjects(pr.map((p) => ({ id: p.id, name: p.name })));
      setAssets(as);
      setJobs(js);
      const pid = projectIdRef.current;
      if (pid) {
        const p = await api.getProject(pid).catch(() => null);
        if (p) setProject(p);
        else {
          // Gone (deleted elsewhere): forget it so we stop retrying it on every poll.
          projectIdRef.current = null;
          storeProjectId(null);
        }
      }
    } catch (e) {
      // quiet: server may be starting
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.refreshStatus());
    } catch {
      /* ignore */
    }
  }, []);

  // ---------- drag & drop anywhere ----------
  // Files can be dropped anywhere in the app, not just in the Library tab, and
  // land in the Library. The DropZone calls stopPropagation on drop, so a file
  // dropped inside it isn't uploaded a second time here.
  //
  // Built from the local toast/refreshAll rather than useUploadFiles(): <App>
  // *renders* the UiCtx provider, so consuming that context from here throws
  // "ui context missing" and blanks the whole UI (empty #root = black screen).
  const uploadFiles = useCallback(
    (files: File[]) => uploadFilesToLibrary(files, { toast, refreshAll }),
    [toast, refreshAll],
  );
  // `uploadFiles` is a fresh closure each render; keep it behind a ref so the
  // window listeners aren't torn down and re-added on every state change.
  const uploadRef = useRef(uploadFiles);
  uploadRef.current = uploadFiles;
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dropDepth.current++;
      setDropping(true);
    };
    // A shot tile is its own drop target and calls stopPropagation on dragenter, so
    // this never fires for a file hovering a tile - which is what keeps the full-screen
    // "Drop to add to the Library" veil from covering the tile that is about to receive it.
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dropDepth.current = Math.max(0, dropDepth.current - 1);
      if (dropDepth.current === 0) setDropping(false);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // without this the browser refuses the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      dropDepth.current = 0;
      setDropping(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length) void uploadRef.current(Array.from(files));
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    return onBusEvent((ev) => {
      if (ev.type === "job" || ev.type === "export") {
        if (!ev.projectId || ev.projectId === projectIdRef.current) void refreshAll();
      }
      if (ev.type === "jobDone") {
        const data = ev.data as RenderJob | undefined;
        if (data?.projectId === projectIdRef.current) {
          if (data.status === "error") toast(`Render finished with errors: ${data.error ?? "see details"}`, "err");
          else if (data.status === "cancelled") toast("Render cancelled", "err");
          else toast("Render complete 🎬", "ok");
        }
        void refreshAll();
      }
    });
  }, [refreshAll, toast]);

  // ---------------------------------------------------------------------
  // Saving
  //
  // Every keystroke in the shot inspector used to PUT the ENTIRE project. On a
  // 30-shot project with takes that is ~200 KB per character typed, and the
  // server re-read + re-merged + re-stringified the whole file each time, so
  // typing felt heavy long before the GPU was involved.
  //
  // Now: one in-flight PUT at a time, with the newest state queued behind it.
  // The UI updates instantly; the write coalesces. `lastSavedRef` guarantees we
  // never send a stale snapshot, and `drainSave` guarantees the final state
  // always lands (on blur, unmount and before a render/export are queued).
  const lastSavedRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<Project | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveErrorRef = useRef(false);

  /** Write `p` now if nothing is in flight, otherwise remember it as pending. */
  const writeProject = useCallback(
    (p: Project) => {
      pendingRef.current = p;
      if (inFlightRef.current) return;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (!next) return;
      inFlightRef.current = true;
      lastSavedRef.current = JSON.stringify(next);
      api
        .putProject(next)
        .catch((e) => {
          saveErrorRef.current = true;
          toast(`Save failed: ${e.message}`, "err");
        })
        .finally(() => {
          inFlightRef.current = false;
          if (pendingRef.current) void writeProject(pendingRef.current);
        });
    },
    [toast],
  );

  /**
   * Push the current project to the server, coalescing rapid edits.
   * `immediate` flushes now instead of after the debounce — used on blur and
   * before anything that reads the saved state (render, export, project switch).
   */
  const saveProject = useCallback(
    (p: Project, immediate = false) => {
      setProject(p);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (immediate) {
        writeProject(p);
        return;
      }
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        writeProject(p);
      }, SAVE_DEBOUNCE_MS);
    },
    [writeProject],
  );

  /**
   * Force any debounced write out now. Safe to call when nothing is pending.
   * Also used before switching projects and on tab close, so an edit can never
   * be lost or land against the wrong project.
   */
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const p = pendingRef.current ?? projectRef.current;
    if (p) writeProject(p);
  }, [writeProject]);

  // Switching projects or closing the tab with a debounced edit pending would
  // otherwise lose it. These must be registered after flushSave exists.
  useEffect(() => {
    const flush = () => flushSave();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [flushSave]);

  // The 20s poll must not overwrite an edit that has not been written yet.
  useEffect(() => {
    const t = setInterval(() => {
      if (saveTimerRef.current || inFlightRef.current) return;
      const p = projectRef.current;
      if (p && lastSavedRef.current && JSON.stringify(p) !== lastSavedRef.current) return;
      void refreshAll();
    }, 20000);
    return () => clearInterval(t);
  }, [refreshAll]);

  // ---------------------------------------------------------------------
  // Undo
  //
  // Reorder, resize, delete, mode switch and take-accept all commit instantly and
  // used to be irreversible — a mis-drag across 15 shots had no way back except
  // redoing the work by hand. This keeps the last N project snapshots in memory
  // so Ctrl+Z (and the toolbar button) can step back.
  //
  // Deliberately snapshot-based rather than per-action inverse: a reorder's
  // inverse is another reorder, and getting that wrong is how data gets lost.
  // Storing whole snapshots is simple and provably correct, at the cost of
  // memory — which is why the stack is capped and holds no media (takes are
  // references to files, not bytes).
  /** A project snapshot plus the metadata that makes the undo message useful. */
  interface UndoEntry {
    project: Project;
    label: string;
    shotId?: string;
    at: number;
  }
  const undoStack = useRef<UndoEntry[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const UNDO_LIMIT = 40;

  /**
   * Record the state to return TO, i.e. call this BEFORE mutating.
   * Coalesces a burst of related edits (a drag, a resize) into one undo step by
   * ignoring repeats of the same shot within a short window.
   */
  const pushUndo = useCallback((label: string, shotId?: string) => {
    const p = projectRef.current;
    if (!p) return;
    const top = undoStack.current[undoStack.current.length - 1];
    const now = Date.now();
    if (top && shotId && top.shotId === shotId && now - top.at < 700) {
      top.at = now;
      return; // still the same gesture
    }
    undoStack.current.push({ project: structuredClone(p), label, shotId, at: now });
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoDepth(undoStack.current.length);
  }, []);

  const undoTimeline = useCallback(() => {
    const entry = undoStack.current.pop();
    if (!entry) return;
    setUndoDepth(undoStack.current.length);
    // Undo is a user-visible state change like any other edit: write it
    // immediately, or a reload could resurrect what the user just undid.
    saveProject(entry.project, true);
    toast(`Undone: ${entry.label}`);
  }, [saveProject, toast]);

  const canUndoTimeline = undoDepth > 0;

  // Ctrl+Z / Ctrl+Shift+Z, ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      if (typing) return; // let the field have its own undo
      e.preventDefault();
      undoTimeline();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoTimeline]);

  // Switching projects with an unsaved edit pending would write the old project
  // into the newly selected one. Force the write out before the id changes.
  const selectProject = useCallback(
    async (id: string) => {
      flushSave();
      projectIdRef.current = id;
      storeProjectId(id);
      const p = await api.getProject(id).catch(() => null);
      setProject(p);
      setTab("script");
    },
    [flushSave],
  );

  const mutateShot = useCallback(
    (shotId: string, patch: Partial<Shot>) => {
      const p = projectRef.current;
      if (!p) return;
      const next: Project = {
        ...p,
        shots: p.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)),
      };
      saveProject(next);
    },
    [saveProject],
  );

  const renderShots = useCallback(
    (shotIds: string[], forceChain = false) => {
      const pid = project?.id;
      if (!pid) return;
      // The queue reads prompts and durations from the SAVED project, so a
      // debounced edit must land before the render starts or it renders the
      // previous version of the shot.
      flushSave();
      api
        .render(pid, shotIds, forceChain)
        .then(() => toast(forceChain ? "Chained render queued — shots will continue from one another" : "Render queued"))
        .catch((e) => toast(`Could not queue render: ${e.message}`, "err"))
        .finally(() => void refreshAll());
    },
    [project, toast, refreshAll, flushSave],
  );

  // ---------- ComfyUI engine start / stop ----------
  const [comfyBusy, setComfyBusy] = useState<"" | "starting" | "stopping">("");
  const comfyAct = useCallback(async () => {
    const targetUp = !status?.comfyUp;
    if (targetUp) {
      setComfyBusy("starting");
      try {
        const r = await api.startComfy();
        if (r.error && !r.started) throw new Error(r.error);
        if (r.alreadyRunning) toast("ComfyUI is already online");
      } catch (e) {
        toast(`Could not start ComfyUI: ${(e as Error).message}`, "err");
        setComfyBusy("");
        return;
      }
    } else {
      setComfyBusy("stopping");
      try {
        const r = await api.stopComfy();
        if (!r.ok && r.error) toast(r.error, "err");
      } catch (e) {
        toast(`Could not stop ComfyUI: ${(e as Error).message}`, "err");
        setComfyBusy("");
        return;
      }
    }
    const deadline = Date.now() + (targetUp ? 100_000 : 25_000);
    let up = false;
    while (Date.now() < deadline) {
      const st = await api.refreshStatus().catch(() => null);
      if (st && st.comfyUp === targetUp) {
        up = true;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 2500));
    }
    setComfyBusy("");
    await refreshAll();
    if (targetUp && up) toast("ComfyUI is online 🎬");
    else if (targetUp) toast("ComfyUI is still starting — it runs in its own console window. If it never appears, check that console for errors.", "err");
    else if (up) toast("ComfyUI stopped");
  }, [status?.comfyUp, toast, refreshAll]);

  const activeJob = jobs.render.find((j) => j.status === "queued" || j.status === "running") ?? null;

  // One source of truth for "you cannot render right now" - shown on every render button.
  const renderBlocked = !status
    ? "Waiting for the engine status…"
    : status.comfyUp
      ? ""
      : "ComfyUI is offline — start the engine with the ▶ Start button in the top bar (or run_nvidia_gpu.bat), then render.";

  const ui: Ui = {
    status,
    settings,
    assets,
    project,
    projects,
    jobs,
    activeJob,
    renderBlocked,
    saveProject,
    mutateShot,
    selectProject,
    refreshAll,
    refreshStatus,
    toast,
    renderShots,
    openMedia,
    flushSave,
    undo: undoTimeline,
    canUndo: canUndoTimeline,
    pushUndo,
    assetsById: new Map(assets.map((a) => [a.id, a])),
  };

  const activeRenderJob = activeJob;

  return (
    <UiCtx.Provider value={ui}>
      <div className="layout">
        <header className="topbar">
          <div className="brand">
            H3 <span className="acc">Director</span>
            <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12, marginLeft: 8 }}>Studio</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <ComfyDot />
            {status && (
              <button
                className={`small ${status.comfyUp ? "danger" : ""}`}
                disabled={comfyBusy !== ""}
                onClick={() => void comfyAct()}
                title={status.comfyUp ? "Stop the local ComfyUI server" : "Launch the local ComfyUI server"}
              >
                {comfyBusy === "starting" ? "Starting…" : comfyBusy === "stopping" ? "Stopping…" : status.comfyUp ? "■ Stop" : "▶ Start"}
              </button>
            )}
          </div>
          <div className="row grow">
            {projects.length === 0 ? (
              <button onClick={() => api.createProject().then((p) => selectProject(p.id)).then(() => refreshAll()).catch(() => {})} className="small primary">
                + New project
              </button>
            ) : (
              <>
                <select
                  value={project?.id ?? ""}
                  onChange={(e) => selectProject(e.target.value)}
                  style={{ maxWidth: 260 }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="small" onClick={() => api.createProject().then((p) => selectProject(p.id)).then(() => refreshAll()).catch(() => {})}>
                  + New
                </button>
              </>
            )}
          </div>
          {project && (
            <div className="tabs">
              <button className={`tab ${tab === "script" ? "active" : ""}`} onClick={() => setTab("script")}>Script</button>
              <button className={`tab ${tab === "images" ? "active" : ""}`} onClick={() => setTab("images")} title="Stills that are not attached to a shot. For shot images use the still stage in the Script tab.">Stills</button>
              <button className={`tab ${tab === "library" ? "active" : ""}`} onClick={() => setTab("library")}>Library</button>
              <button className={`tab ${tab === "gallery" ? "active" : ""}`} onClick={() => setTab("gallery")}>Gallery</button>
              <button className={`tab ${tab === "export" ? "active" : ""}`} onClick={() => setTab("export")}>Export</button>
            </div>
          )}
          {project && (
            <button className={`small ${aiOpen ? "primary" : ""}`} onClick={() => setAiOpen((v) => !v)} title="AI co-director">
              ✦ AI
            </button>
          )}
          {activeRenderJob && (
            <button
              className="small danger"
              onClick={() =>
                api.cancelRender(activeRenderJob.id).then(() => toast("Cancelling…")).catch(() => {})
              }
            >
              Cancel render
            </button>
          )}
          <button className="small" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </button>
        </header>

        {!project ? (
          <div className="content" style={{ padding: 20 }}>
            <div className="empty grow" style={{ alignSelf: "center" }}>
              {projects.length === 0 ? (
                <>
                  <h3>Welcome to H3 Director Studio</h3>
                  <p className="muted">A clean director desk for MiniMax H3 on top of ComfyUI.</p>
                  <button className="primary" onClick={() => api.createProject("First film").then((p) => selectProject(p.id)).then(() => refreshAll()).catch(() => {})}>
                    Create your first project
                  </button>
                </>
              ) : (
                <p>Select a project above to start directing.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="content">
            <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: 14, gap: 12, overflow: "hidden" }}>
              {tab === "script" && <ScriptView />}
              {tab === "images" && <ImagesView />}
              {tab === "library" && <LibraryView />}
              {tab === "gallery" && <GalleryView />}
              {tab === "export" && <ExportView />}
            </main>
            {aiOpen && (
              <aside style={{ width: 360, borderLeft: "1px solid var(--line)", padding: 12, overflowY: "auto", background: "var(--bg2)" }}>
                <AiPane onClose={() => setAiOpen(false)} />
              </aside>
            )}
          </div>
        )}
      </div>

      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
      {viewer && <MediaViewer media={viewer} onClose={() => setViewer(null)} />}
      {dropping && (
        <div className="drop-overlay">
          <span>Drop to add to the Library</span>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </UiCtx.Provider>
  );
}

function ComfyDot() {
  const { status } = useUi();
  const ok = status?.comfyUp;
  return (
    <div className="chip" title={status?.error ?? (ok ? "ComfyUI engine online" : "ComfyUI offline")}>
      <span className={`dot ${ok ? "ok" : "bad"}`} />
      <span>
        {ok ? (status?.gpuName ? `ComfyUI ${status.comfyVersion} · ${status.gpuName}` : "ComfyUI online") : "ComfyUI offline"}
      </span>
    </div>
  );
}
