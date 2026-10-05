import { createContext, useContext } from "react";
import type {
  AppSettings,
  EngineProbe,
  ExportJob,
  LibraryAsset,
  Project,
  RenderJob,
  Shot,
} from "./api";
import type { MediaTarget } from "./MediaViewer";

export interface Ui {
  status: EngineProbe | null;
  /**
   * Write any debounced edit out immediately. Anything that depends on the
   * server's copy of the project (render, export, project switch) must call
   * this first, or it acts on the previous version of the shot.
   */
  flushSave: () => void;
  /** Step back one structural change (reorder, resize, delete, accept). */
  undo: () => void;
  /** Whether there is anything to undo. */
  canUndo: boolean;
  /**
   * Record an undo point. Call this BEFORE mutating, with a short human label so
   * the toast can say what was undone. Pass the shot id so a burst of edits to
   * one shot (a drag, a resize) coalesces into a single undo step.
   */
  pushUndo: (label: string, shotId?: string) => void;
  settings: AppSettings | null;
  assets: LibraryAsset[];
  project: Project | null;
  projects: Array<{ id: string; name: string }>;
  jobs: { render: RenderJob[]; export: ExportJob[] };
  activeJob: RenderJob | null;
  /** Why rendering is unavailable right now ("" when the engine is ready). Every render
   *  button uses it for `disabled` + `title`, so an offline ComfyUI says "start the engine"
   *  up front instead of failing minutes later from inside the render queue. */
  renderBlocked: string;
  saveProject: (p: Project) => void;
  mutateShot: (shotId: string, patch: Partial<Shot>) => void;
  selectProject: (id: string) => void;
  refreshAll: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  toast: (msg: string, kind?: "ok" | "err") => void;
  renderShots: (shotIds: string[], forceChain?: boolean) => void;
  /** Open an image or video full-screen. Every thumbnail in the app uses this. */
  openMedia: (m: MediaTarget) => void;
  assetsById: Map<string, LibraryAsset>;
}

export const UiCtx = createContext<Ui | null>(null);

export function useUi(): Ui {
  const u = useContext(UiCtx);
  if (!u) throw new Error("ui context missing");
  return u;
}
