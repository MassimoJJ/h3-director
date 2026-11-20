import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, assetUrl, imageUrl } from "./api";
import { useUi } from "./ui";
import { MediaThumb } from "./MediaViewer";
import type { ImageBoard, ImageJob, ImageMode, ImageTake, LibraryAsset } from "./api";

const IMG_SAMPLERS = ["euler", "euler_ancestral", "euler_cfg_pp", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep", "er_sde"];
const IMG_SCHEDULERS = ["simple", "sgm_uniform", "karras", "exponential", "beta", "normal"];

/** Canvas presets. Qwen Image 2.1 renders natively up to ~2K; all values are multiples of 16. */
const CANVAS_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: "1:1 - 1328", w: 1328, h: 1328 },
  { label: "1:1 - 1024", w: 1024, h: 1024 },
  { label: "16:9 - 1344x768", w: 1344, h: 768 },
  { label: "9:16 - 768x1344", w: 768, h: 1344 },
  { label: "4:3 - 1152x864", w: 1152, h: 864 },
  { label: "3:4 - 864x1152", w: 864, h: 1152 },
  { label: "3:2 - 1584x1056", w: 1584, h: 1056 },
  { label: "2K - 2048", w: 2048, h: 2048 },
];

const MAX_REFS = 8;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/**
 * Qwen Image 2.1 still-image stage.
 *
 * A "board" is one reusable image setup (prompt + mode + references + sampling). Rendering a
 * board appends takes to it, and any take can be promoted into the Library, from where the
 * existing keyframe / reference pickers in the Script view can use it to drive a shot.
 */
export function ImagesView() {
  const ui = useUi();
  const { project, assets } = ui;
  const [selId, setSelId] = useState<string | null>(null);
  const [qwen, setQwen] = useState<{ ready: boolean; models: { unet: string; clip: string; vae: string } | null; error?: string } | null>(null);
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [count, setCount] = useState(1);
  const [picker, setPicker] = useState(false);
  const toast = ui.toast;

  const boards = useMemo(() => project?.boards ?? [], [project]);
  const sel = boards.find((b) => b.id === selId) ?? boards[0];

  useEffect(() => {
    void api.qwenStatus().then(setQwen).catch(() => setQwen({ ready: false, models: null, error: "backend unreachable" }));
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await api.imageJobs());
    } catch {
      /* backend may be restarting */
    }
  }, []);

  useEffect(() => {
    void refreshJobs();
    const iv = setInterval(() => void refreshJobs(), 2500);
    return () => clearInterval(iv);
  }, [refreshJobs]);

  if (!project) return null;

  const jobForBoard = (id: string) => jobs.find((j) => j.boardId === id && (j.status === "running" || j.status === "queued"));

  const createBoard = async (mode: ImageMode) => {
    try {
      const b = await api.createBoard(project.id, mode);
      await ui.refreshAll();
      setSelId(b.id);
      toast(mode === "edit" ? "Edit board created - pick a reference image" : "Text-to-image board created");
    } catch (e) {
      toast(`Could not create board: ${(e as Error).message}`, "err");
    }
  };

  /** Board fields are patched on blur so typing never round-trips through the server. */
  const patch = async (board: ImageBoard, p: Partial<ImageBoard>, save = true) => {
    Object.assign(board, p);
    if (!save) return;
    try {
      await api.updateBoard(project.id, board.id, p);
    } catch (e) {
      toast(`Could not save board: ${(e as Error).message}`, "err");
    }
  };

  const render = async (board: ImageBoard) => {
    try {
      await api.renderBoard(project.id, board.id, count);
      await refreshJobs();
      toast(`Rendering ${count} ${count === 1 ? "image" : "images"}...`);
    } catch (e) {
      toast(`Render failed to start: ${(e as Error).message}`, "err");
    }
  };

  const remove = async (board: ImageBoard) => {
    if (!window.confirm(`Delete board "${board.name}" and its images?`)) return;
    try {
      await api.deleteBoard(project.id, board.id);
      setSelId(null);
      await ui.refreshAll();
    } catch (e) {
      toast(`Could not delete board: ${(e as Error).message}`, "err");
    }
  };

  const toAsset = async (board: ImageBoard, take: ImageTake) => {
    try {
      const asset = await api.takeToAsset(project.id, board.id, take.id);
      await ui.refreshAll();
      toast(`Added "${asset.name}" to the Library - use it as a shot's first frame`);
    } catch (e) {
      toast(`Could not add to library: ${(e as Error).message}`, "err");
    }
  };

  /** Send a still straight to a shot's first frame so it can be animated as i2v. */
  const useAsFirstFrame = async (board: ImageBoard, take: ImageTake) => {
    const target = project.shots.find((s) => s.firstFrameId) ?? project.shots[0];
    if (!target) {
      toast("Create a shot in the Script tab first", "err");
      return;
    }
    try {
      const asset = await api.takeToAsset(project.id, board.id, take.id);
      await ui.refreshAll();
      ui.mutateShot(target.id, { firstFrameId: asset.id, kind: "i2v" });
      toast(`Set as the first frame of "${target.name}"`);
    } catch (e) {
      toast(`Could not set the first frame: ${(e as Error).message}`, "err");
    }
  };

  const imageAssets = assets.filter((a) => a.kind === "image");
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 12 }}>
      <div className="panel" style={{ width: 240, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div className="panel-head">
          <strong>Boards</strong>
          <span className="muted">{boards.length}</span>
        </div>
        <div style={{ display: "flex", gap: 6, padding: 8, borderBottom: "1px solid var(--line)" }}>
          <button className="small primary" style={{ flex: 1 }} onClick={() => createBoard("t2i")} title="Prompt to image">+ T2I</button>
          <button className="small" style={{ flex: 1 }} onClick={() => createBoard("edit")} title="Image to image (edit)">+ Edit</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {boards.length === 0 && <div className="empty" style={{ padding: 20 }}>No boards yet.</div>}
          {boards.map((b) => {
            const job = jobForBoard(b.id);
            const ok = b.takes.filter((t) => t.status === "ok").length;
            return (
              <div key={b.id} className={`board-item ${sel?.id === b.id ? "active" : ""}`} onClick={() => setSelId(b.id)}>
                <div className="row" style={{ gap: 6, alignItems: "center" }}>
                  <span className={`mode-tag ${b.mode}`}>{b.mode === "edit" ? "EDIT" : "T2I"}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                </div>
                <div className="muted" style={{ fontSize: 11 }}>{b.width}x{b.height} / {ok} {ok === 1 ? "image" : "images"}</div>
                {job ? <div className="muted" style={{ fontSize: 11 }}>{job.progress.label}</div> : null}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, gap: 12 }}>
        {!sel ? (
          <div className="empty grow" style={{ alignSelf: "center", padding: 30 }}>
            <h3>Qwen Image 2.1</h3>
            <p className="muted">Make stills with text-to-image or image-edit, then send any result to a shot as its first frame.</p>
            <div className="row" style={{ gap: 8, justifyContent: "center" }}>
              <button className="primary" onClick={() => createBoard("t2i")}>New text-to-image board</button>
              <button onClick={() => createBoard("edit")}>New edit board</button>
            </div>
          </div>
        ) : (
          <>
            <div className="panel" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <input
                  className="grow" value={sel.name}
                  onChange={(e) => patch(sel, { name: e.target.value }, false)}
                  onBlur={(e) => patch(sel, { name: e.target.value })}
                />
                <select
                  value={sel.mode} title="Generation mode"
                  onChange={(e) => {
                    const mode = e.target.value as ImageMode;
                    patch(sel, { mode, imageIds: mode === "t2i" ? [] : sel.imageIds });
                    if (mode === "edit") setPicker(true);
                  }}
                >
                  <option value="t2i">Text to image</option>
                  <option value="edit">Image edit (i2i)</option>
                </select>
                <button className="small danger" onClick={() => remove(sel)} title="Delete board">Delete</button>
              </div>

              <Field
                label="Character lock"
                hint="This image is attached to every still this board renders, so successive takes keep the same face."
              >
                <select
                  value={sel.characterId ?? ""}
                  onChange={(e) => patch(sel, { characterId: e.target.value || null })}
                >
                  <option value="">None — no identity lock</option>
                  {ui.assets.filter((a) => a.kind === "image")
                    .sort((a, b) => Number(b.role === "character") - Number(a.role === "character"))
                    .map((a) => (
                      <option key={a.id} value={a.id}>{a.role === "character" ? "★ " : ""}{a.name}</option>
                    ))}
                </select>
              </Field>

              <Field
                label="Prompt"
                hint={sel.mode === "edit" ? "Describe the change. Source framing, subject and lighting are preserved." : undefined}
              >
                <textarea
                  rows={3} value={sel.prompt}
                  placeholder={sel.mode === "edit" ? "e.g. Replace the neon rain with heavy snow, keep the framing" : "e.g. A lone detective in a trench coat, neon-lit rain, anamorphic flare, 35mm"}
                  onChange={(e) => patch(sel, { prompt: e.target.value }, false)}
                  onBlur={(e) => patch(sel, { prompt: e.target.value })}
                />
              </Field>

              {sel.mode === "edit" && (
                <Field
                  label={`References (${sel.imageIds.length}/${MAX_REFS})`}
                  hint="The first image defines the output size and framing. Extra images become visual context for the text encoder."
                >
                  <div className="row wrap" style={{ gap: 6 }}>
                    {sel.imageIds.map((id) => {
                      const a = ui.assetsById.get(id);
                      return (
                        <div key={id} className="ref-chip">
                          {a ? <MediaThumb className="ref-open" kind="image" src={assetUrl(a)} name={a.name} /> : <span className="muted">missing</span>}
                          <button className="x" title="Remove reference"
                            onClick={() => patch(sel, { imageIds: sel.imageIds.filter((x) => x !== id) })}>x</button>
                        </div>
                      );
                    })}
                    {sel.imageIds.length < MAX_REFS && <button className="small" onClick={() => setPicker(true)}>+ Add image</button>}
                  </div>
                </Field>
              )}
              <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
                <Field label="Canvas">
                  <select
                    value={`${sel.width}x${sel.height}`}
                    onChange={(e) => {
                      const [w, h] = e.target.value.split("x").map(Number);
                      patch(sel, { width: w, height: h });
                    }}
                  >
                    {CANVAS_PRESETS.some((p) => p.w === sel.width && p.h === sel.height)
                      ? null
                      : <option value={`${sel.width}x${sel.height}`}>custom {sel.width}x{sel.height}</option>}
                    {CANVAS_PRESETS.map((p) => <option key={p.label} value={`${p.w}x${p.h}`}>{p.label}</option>)}
                  </select>
                </Field>
                <Field label="Steps">
                  <input type="number" min={1} max={100} value={sel.steps} style={{ width: 80 }}
                    onChange={(e) => patch(sel, { steps: Number(e.target.value) || 1 }, false)}
                    onBlur={(e) => patch(sel, { steps: Number(e.target.value) || 1 })} />
                </Field>
                <Field label="CFG">
                  <input type="number" min={0} max={20} step={0.5} value={sel.cfg} style={{ width: 80 }}
                    onChange={(e) => patch(sel, { cfg: Number(e.target.value) || 0 }, false)}
                    onBlur={(e) => patch(sel, { cfg: Number(e.target.value) || 0 })} />
                </Field>
                <Field label="Sampler">
                  <select value={sel.sampler} onChange={(e) => patch(sel, { sampler: e.target.value })}>
                    {IMG_SAMPLERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="Scheduler">
                  <select value={sel.scheduler} onChange={(e) => patch(sel, { scheduler: e.target.value })}>
                    {IMG_SCHEDULERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
              </div>

              <div className="row wrap" style={{ gap: 10, alignItems: "flex-end" }}>
                <Field label="Seed">
                  <div className="row" style={{ gap: 4 }}>
                    <select value={sel.seedMode} onChange={(e) => patch(sel, { seedMode: e.target.value as "random" | "fixed" })}>
                      <option value="random">random</option>
                      <option value="fixed">fixed</option>
                    </select>
                    <input type="number" value={sel.seed} style={{ width: 120 }} disabled={sel.seedMode !== "fixed"}
                      onChange={(e) => patch(sel, { seed: Number(e.target.value) || 0 }, false)}
                      onBlur={(e) => patch(sel, { seed: Number(e.target.value) || 0 })} />
                  </div>
                </Field>
                <Field label="Variants" hint="Up to 4 per run.">
                  <input type="number" min={1} max={4} value={count} style={{ width: 64 }}
                    onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
                </Field>
                <Field label="KV cache" hint="Where the prefix cache lives.">
                  <div className="row" style={{ gap: 4 }}>
                    <select value={sel.cacheDevice} onChange={(e) => patch(sel, { cacheDevice: e.target.value as ImageBoard["cacheDevice"] })}>
                      <option value="auto">auto</option><option value="gpu">gpu</option>
                      <option value="cpu">cpu</option><option value="off">off</option>
                    </select>
                    <select value={sel.cacheDtype} onChange={(e) => patch(sel, { cacheDtype: e.target.value as ImageBoard["cacheDtype"] })}>
                      <option value="default">default</option><option value="int8">int8</option><option value="int4">int4</option>
                    </select>
                  </div>
                </Field>
                <Field label="Negative">
                  <input value={sel.negativePrompt} style={{ width: 180 }} placeholder="optional"
                    onChange={(e) => patch(sel, { negativePrompt: e.target.value }, false)}
                    onBlur={(e) => patch(sel, { negativePrompt: e.target.value })} />
                </Field>
              </div>

              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <button className="primary" onClick={() => render(sel)} disabled={!qwen?.ready || !!jobForBoard(sel.id)}>
                  {jobForBoard(sel.id) ? "Rendering..." : `Render ${count > 1 ? `${count} variants` : "image"}`}
                </button>
                {!qwen?.ready && qwen?.error ? <span className="muted" style={{ fontSize: 12 }}>{qwen.error}</span> : null}
                {qwen?.ready ? <span className="muted" style={{ fontSize: 12 }}>{qwen.models?.unet}</span> : null}
              </div>
            </div>

            <div className="panel grow" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div className="panel-head">
                <strong>Takes</strong>
                <span className="muted">{sel.takes.length}</span>
              </div>
              <div className="takes-grid" style={{ overflowY: "auto", padding: 10 }}>
                {sel.takes.length === 0 && !jobForBoard(sel.id) && (
                  <div className="empty" style={{ padding: 24 }}>Nothing rendered yet.</div>
                )}
                {[...sel.takes].reverse().map((t) => (
                  <TakeCard
                    key={t.id} take={t}
                    onAsset={() => toAsset(sel, t)}
                    onFirstFrame={() => useAsFirstFrame(sel, t)}
                    onAccept={async () => {
                      try { await api.acceptTake(project.id, sel.id, t.id); await ui.refreshAll(); } catch { /* ignore */ }
                    }}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {picker && sel && (
        <RefPicker
          assets={imageAssets}
          onClose={() => setPicker(false)}
          onPick={(id) => {
            if (!sel.imageIds.includes(id) && sel.imageIds.length < MAX_REFS) {
              patch(sel, { imageIds: [...sel.imageIds, id] });
            }
            setPicker(false);
          }}
        />
      )}
    </div>
  );
}
function TakeCard({
  take, onAsset, onFirstFrame, onAccept,
}: {
  take: ImageTake;
  onAsset: () => void;
  onFirstFrame: () => void;
  onAccept: () => void;
}) {
  const fail = take.status === "error";
  return (
    <div className={`take-card ${take.accepted ? "accepted" : ""} ${fail ? "failed" : ""}`}>
      {take.imageFile ? (
        <MediaThumb className="thumb" kind="image" src={imageUrl(take.imageFile)} name={`Seed ${take.seed}`}>
          <img src={imageUrl(take.imageFile)} alt="" loading="lazy" />
          {take.accepted ? <span className="star">*</span> : null}
        </MediaThumb>
      ) : (
        <div className="thumb"><div className="err">{take.error ?? "No image"}</div></div>
      )}
      <div className="meta">
        <div className="row" style={{ gap: 6, alignItems: "center" }}>
          <span className="mono">{take.seed}</span>
          {take.width ? <span className="muted">{take.width}x{take.height}</span> : null}
        </div>
        {take.warnings?.map((w, i) => <div key={i} className="warn">{w}</div>)}
        {!fail && (
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <button className="tiny primary" onClick={onAccept}>{take.accepted ? "* Kept" : "Keep"}</button>
            <button className="tiny" onClick={onFirstFrame} title="Use as a shot's first frame (i2v)">First frame</button>
            <button className="tiny" onClick={onAsset} title="Add to the Library">Library</button>
          </div>
        )}
      </div>
    </div>
  );
}

function RefPicker({ assets, onClose, onPick }: { assets: LibraryAsset[]; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? assets.filter((a) => a.name.toLowerCase().includes(needle)) : assets;
  }, [assets, q]);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 720, maxHeight: "80vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Pick a reference image</strong>
          <button className="small" onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 10, borderBottom: "1px solid var(--line)" }}>
          <input ref={inputRef} className="grow" placeholder="Search the library..." value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="picker-grid" style={{ overflowY: "auto", padding: 10 }}>
          {filtered.length === 0 && <div className="empty" style={{ padding: 20 }}>No images in the library yet.</div>}
          {filtered.map((a) => (
            <div key={a.id} className="picker-item" onClick={() => onPick(a.id)} title={a.name}>
              <img src={assetUrl(a)} alt={a.name} loading="lazy" />
              <div className="muted" style={{ fontSize: 11 }}>{a.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}