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
    const iv = setInterval(() => void refreshAll(), 20000);
    return () => clearInterval(iv);
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

  const selectProject = useCallback(async (id: string) => {
    projectIdRef.current = id;
    storeProjectId(id);
    const p = await api.getProject(id).catch(() => null);
    setProject(p);
    setTab("script");
  }, []);

  const saveProject = useCallback(
    (p: Project) => {
      setProject(p);
      api.putProject(p).catch((e) => toast(`Save failed: ${e.message}`, "err"));
    },
    [toast],
  );

  const mutateShot = useCallback(
    (shotId: string, patch: Partial<Shot>) => {
      const p = project;
      if (!p) return;
      const next: Project = {
        ...p,
        shots: p.shots.map((s) => (s.id === shotId ? { ...s, ...patch } : s)),
      };
      saveProject(next);
    },
    [project, saveProject],
  );

  const renderShots = useCallback(
    (shotIds: string[], forceChain = false) => {
      const pid = project?.id;
      if (!pid) return;
      api
        .render(pid, shotIds, forceChain)
        .then(() => toast(forceChain ? "Chained render queued — shots will continue from one another" : "Render queued"))
        .catch((e) => toast(`Could not queue render: ${e.message}`, "err"))
        .finally(() => void refreshAll());
    },
    [project, toast, refreshAll],
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
