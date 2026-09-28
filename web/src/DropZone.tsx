import { useCallback, useRef, useState } from "react";
import { api } from "./api";
import { useUi, type Ui } from "./ui";

/** Every media type the Library accepts. */
export const ALL_MEDIA = "image/*,video/*,audio/*";

/**
 * Upload a batch of files into the Library, reporting per-file failures.
 * Shared by the Library drop zone and the app-wide "drop anywhere" handler so
 * both behave identically.
 *
 * Takes `ui` as an argument instead of reading the context itself: the app-wide
 * handler lives in <App>, which *renders* the UiCtx provider and therefore must
 * not consume it. Calling useUi() there throws "ui context missing", React
 * unmounts the tree and the dark page renders as a black screen with an empty
 * #root - a failure mode TypeScript and the production build both accept.
 */
export async function uploadFilesToLibrary(
  files: File[],
  ui: Pick<Ui, "toast" | "refreshAll">,
): Promise<void> {
  let ok = 0;
  for (const f of files) {
    try {
      await api.uploadAsset(f);
      ok++;
    } catch (e) {
      ui.toast(`Upload of ${f.name} failed: ${(e as Error).message}`, "err");
    }
  }
  if (ok) ui.toast(`Imported ${ok} asset${ok === 1 ? "" : "s"} into the Library`);
  void ui.refreshAll();
}

/**
 * Context-bound uploader for components that live *inside* the UiCtx provider
 * (the Library drop zone). <App> itself must use `uploadFilesToLibrary`.
 */
export function useUploadFiles(): (files: File[]) => Promise<void> {
  const ui = useUi();
  return useCallback((files: File[]) => uploadFilesToLibrary(files, ui), [ui]);
}

/** Does one file match an `accept` string like "image/*,.png" (comma separated)? */
function typeOk(file: File, accept: string): boolean {
  if (!accept.trim()) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => {
      if (p.startsWith(".")) return name.endsWith(p); // .png
      if (p.endsWith("/*")) return type.startsWith(p.slice(0, -1)); // image/*
      return type === p;
    });
}

/**
 * Click-to-upload + drag-and-drop zone.
 *
 * Clicking anywhere in the box opens the OS file dialog (Windows Explorer), and
 * files can equally be dragged straight in. Deliberately mirrors the input
 * behaviour of GrokToddlerAutomation: `onDragOver` must call `preventDefault()`
 * or the browser refuses the drop.
 *
 * `onDrop` calls `stopPropagation()` so an app-wide drop handler doesn't upload
 * the same file a second time.
 */
export function DropZone({ onFiles, accept = ALL_MEDIA, multiple = true, label, hint, style, className = "" }: {
  onFiles: (files: File[]) => void | Promise<void>;
  accept?: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const ui = useUi();
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child element, so count depth instead of
  // trusting a single enter/leave pair.
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const take = async (list: FileList | File[] | null) => {
    if (!list) return;
    const all = Array.from(list);
    if (!all.length) return;
    const ok = all.filter((f) => typeOk(f, accept));
    const bad = all.filter((f) => !typeOk(f, accept));
    if (bad.length) {
      ui.toast(`Not supported here: ${bad.map((f) => f.name).join(", ")}`, "err");
    }
    if (ok.length) await onFiles(ok);
  };

  return (
    <div
      className={`dropzone ${over ? "over" : ""} ${className}`}
      style={style}
      onClick={() => inputRef.current?.click()}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        depth.current = 0;
        setOver(false);
        void take(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          void take(e.target.files);
          e.target.value = "";
        }}
      />
      <span className="dz-icon">⬆</span>
      <span className="dz-label">{label ?? "Click to choose files"}</span>
      <span className="muted dz-hint">{hint ?? "or drag & drop them here"}</span>
    </div>
  );
}