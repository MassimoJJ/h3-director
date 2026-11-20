import { useEffect, useMemo, useRef, useState } from "react";
import { api, assetUrl, exportUrl, imageUrl, onBusEvent, outputUrl } from "./api";
import { useUi } from "./ui";
import { MediaThumb } from "./MediaViewer";
import { DropZone, useUploadFiles } from "./DropZone";
import type { AppSettings, LibraryAsset, OllamaModelInfo, Project, ProviderKeyMeta, RenderJob, Shot, ShotKind, ShotStill, StillMode, StructureAllDone, Take } from "./api";
import { PROVIDER_CARDS } from "./catalog";
import type { ProviderCard } from "./catalog";

/** Canvas presets for the still stage (Qwen renders natively to ~2K; all multiples of 16). */
const IMG_CANVAS: Array<{ label: string; w: number; h: number }> = [
  { label: "1:1 - 1328", w: 1328, h: 1328 },
  { label: "1:1 - 1024", w: 1024, h: 1024 },
  { label: "16:9 - 1344x768", w: 1344, h: 768 },
  { label: "9:16 - 768x1344", w: 768, h: 1344 },
  { label: "4:3 - 1152x864", w: 1152, h: 864 },
  { label: "3:4 - 864x1152", w: 864, h: 1152 },
  { label: "3:2 - 1584x1056", w: 1584, h: 1056 },
  { label: "2K - 2048", w: 2048, h: 2048 },
];

// ----------------------------------------------------------------------
// tiny form helpers
// ----------------------------------------------------------------------

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

const RESOLUTIONS = ["360P", "416P", "480P", "540P", "640P", "720P", "768P", "832P", "928P", "1024P", "1080P", "custom"];
const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"];
const SAMPLERS = ["euler", "euler_ancestral", "euler_cfg_pp", "euler_ancestral_cfg_pp", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep", "er_sde", "uni_pc"];
const SCHEDULERS = ["simple", "sgm_uniform", "karras", "exponential", "ddim_uniform", "beta", "normal"];
const REF_IMAGE_SIZES = ["match", "1k", "1.5k", "2k", "original"];

const KIND_LABEL: Record<ShotKind, string> = {
  t2v: "Text → video",
  i2v: "First frame",
  fl2v: "First + last frame",
  r2v: "References + voice",
};

// ----------------------------------------------------------------------
// Script
// ----------------------------------------------------------------------

export function ScriptView() {
  const ui = useUi();
  const { project, activeJob } = ui;
  /** Record an undo point before a structural change. */
  const pushUndo = ui.pushUndo;
  const [selId, setSelId] = useState<string | null>(null);
  // Structure-all dialog, scoped to a timeline window [start, end).
  const [saWin, setSaWin] = useState<{ start: number; end: number } | null>(null);
  // Context menu (right-click or ⌄) for structuring this shot + following ones.
  const [ctx, setCtx] = useState<{ x: number; y: number; index: number } | null>(null);
  // Single-shot structuring launched from a shot card's free-form badge.
  const [structingId, setStructingId] = useState<string | null>(null);
  const [playCutOpen, setPlayCutOpen] = useState(false);
  // Playhead position in the assembled cut, drawn on the timeline ruler. Null
  // when the cut player is closed, so the line never lingers after review.
  const [playhead, setPlayhead] = useState<number | null>(null);
  // Multi-selection for batch actions. Kept as a Set of shot ids rather than an
  // index range so it survives reorders — a range-based selection silently
  // changes meaning the moment a shot moves.
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set());
  // Anchor for shift-click range selection: the last shot clicked normally.
  const [selAnchor, setSelAnchor] = useState<number | null>(null);
  // Set by the timeline right after a drag-reorder so the resulting click does
  // not also re-select whatever landed under the pointer.
  const suppressClickRef = useRef(false);
  // Timeline workspace sizing — how much of the window the timeline owns (percent) and
  // how many pixels a second of shot duration is worth. Both persist, so the timeline
  // stays the size the director last worked at.
  const [tlPct, setTlPct] = useState(() => clamp(readStoredNumber(SPLIT_KEY, 58), 25, 88));
  const [zoom, setZoom] = useState(() =>
    clamp(Math.round(readStoredNumber(ZOOM_KEY, TIMELINE_ZOOM_DEFAULT)), 0, TIMELINE_ZOOMS.length - 1));
  const splitHostRef = useRef<HTMLDivElement | null>(null);
  const [quickReview, setQuickReview] = useState<{
    shotId: string; original: string; proposed: string; source: string; model?: string;
  } | null>(null);
  if (!project) return null;
  const sel = project.shots.find((s) => s.id === selId) ?? project.shots[0];
  // Live scope for Structure all: how many prompts still need the four-section rewrite.
  const freeFormCount = project.shots.filter((s) => s.prompt.trim().length > 0 && !isStructuredPrompt(s.prompt)).length;
  const structuredCount = project.shots.filter((s) => s.prompt.trim().length > 0 && isStructuredPrompt(s.prompt)).length;

  /** Runs the four-section rewrite for one shot and opens the review dialog (nothing is
   *  written until Apply). Same LLM path as the inspector's Structure prompt button. */
  const quickStructure = async (shot: Shot) => {
    if (structingId) return;
    setStructingId(shot.id);
    try {
      const r = await api.structurePrompt(project.id, shot.prompt);
      if (r.unchanged) {
        ui.toast("Prompt already has the four-section structure");
      } else {
        const src = PROVIDER_CARDS.find((c) => c.id === r.provider)?.label ?? r.provider ?? "";
        setQuickReview({
          shotId: shot.id,
          original: shot.prompt,
          proposed: r.structured || r.raw || "",
          source: src,
          model: r.model,
        });
      }
    } catch (e) {
      ui.toast(`Structure failed: ${(e as Error).message}`, "err");
    } finally {
      setStructingId(null);
    }
  };

  /** Open the Structure-all dialog scoped to shot indexes [start, end). */
  const openRange = (start: number, end: number) => {
    const clampedEnd = Math.min(end, project.shots.length);
    if (start < 0 || start >= clampedEnd) return;
    setSelId(project.shots[start].id);
    setSaWin({ start, end: clampedEnd });
  };

  /** Right-click / ⌄ chevron: build menu entries for "this shot + N after it". */
  const menuOptions = (index: number) => {
    const L = project.shots.length;
    const opts = new Map<number, { label: string }>();
    const add = (label: string, e: number) => {
      const end = Math.min(e, L);
      if (end > index + 1 && !opts.has(end)) opts.set(end, { label });
    };
    add("This shot + the 1 shot after it", index + 2);
    add("This shot + the 2 shots after it", index + 3);
    add("This shot + the 5 shots after it", index + 6);
    if (index + 1 < L) opts.set(L, { label: "This shot → end of timeline" });
    return [...opts].map(([end, { label }]) => ({ label, start: index, end, count: end - index }));
  };

  const showRangeMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (menuOptions(index).length === 0) return; // nothing follows this shot
    setCtx({ x: Math.min(e.clientX, window.innerWidth - 260), y: Math.min(e.clientY, window.innerHeight - 190), index });
  };

  /** Razor-split a shot on the timeline: the backend cuts the prompt at a sensible
   *  boundary into two consecutive shots (B continues from A's final frame). */
  const splitShot = async (shotId: string) => {
    try {
      const r = await api.splitShot(project.id, shotId);
      setSelId(r.split.aId);
      await ui.refreshAll();
      ui.toast("Shot split into two — the seam will be locked when rendered seamlessly");
    } catch (e) {
      ui.toast(`Could not split shot: ${(e as Error).message}`, "err");
    }
  };

  /** Drag the bar between the timeline and the inspector. The timeline is the primary
   *  workspace, so the default split leans toward it (58%), and the drag is clamped so
   *  neither pane can be starved away. */
  const startSplit = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const host = splitHostRef.current;
    if (!host) return;
    const height = host.getBoundingClientRect().height || 1;
    const startY = e.clientY;
    const startPct = tlPct;
    document.body.classList.add("tl-resizing-v");
    const move = (ev: PointerEvent) => {
      setTlPct(clamp(Math.round(startPct + ((ev.clientY - startY) / height) * 100), 25, 88));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("tl-resizing-v");
      setTlPct((v) => { storeNumber(SPLIT_KEY, v); return v; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Bulk operations act on the multi-selection, or on the single selected shot. */
  const actionTargets = (): Shot[] => {
    if (multiSel.size > 0) return project.shots.filter((s) => multiSel.has(s.id));
    return sel ? [sel] : [];
  };

  const clearMulti = () => {
    setMultiSel(new Set());
    setSelAnchor(null);
  };

  /**
   * Click / shift-click on a tile. Plain click selects one; shift-click extends
   * from the anchor, which is how every NLE and file browser behaves.
   */
  const selectShot = (shot: Shot, index: number, shift: boolean) => {
    if (!shift) {
      setSelId(shot.id);
      setSelAnchor(index);
      setMultiSel(new Set());
      return;
    }
    setSelId(shot.id);
    const from = selAnchor ?? index;
    const lo = Math.min(from, index);
    const hi = Math.max(from, index);
    const next = new Set(multiSel);
    for (const s of project.shots.slice(lo, hi + 1)) next.add(s.id);
    setMultiSel(next);
  };

  const batchDelete = () => {
    const targets = actionTargets();
    if (!targets.length) return;
    const names = targets.slice(0, 4).map((s) => s.name || "Untitled").join(", ");
    if (!confirm(`Delete ${targets.length} shot${targets.length === 1 ? "" : "s"} (${names}${targets.length > 4 ? ", …" : ""})?\n\nTheir takes and media are deleted too.`)) return;
    pushUndo(`delete ${targets.length} shot${targets.length === 1 ? "" : "s"}`);
    // Fire them together; each delete is independent, and serialising would just
    // make a 20-shot delete take 20 round-trips.
    void Promise.allSettled(targets.map((s) => api.deleteShot(project.id, s.id)))
      .then(() => ui.refreshAll())
      .then(() => ui.toast(`Deleted ${targets.length} shot${targets.length === 1 ? "" : "s"} — Ctrl+Z restores them`));
  };

  const batchChain = () => {
    const targets = actionTargets();
    if (targets.length < 2) { ui.toast("Select at least two shots to chain.", "err"); return; }
    pushUndo("chain shots");
    // Chain means "continue from the previous shot's last frame", so every shot
    // but the first in the selection gets the flag.
    const ids = targets.map((s) => s.id);
    const next: Project = {
      ...project,
      shots: project.shots.map((s, i) => {
        if (!multiSel.size) return s;
        const at = ids.indexOf(s.id);
        if (at <= 0) return s;
        return { ...s, continueFromPrev: true };
      }),
    };
    ui.saveProject(next);
    ui.toast(`Chained ${targets.length} shots — they will continue from one another`);
  };

  const batchUnchain = () => {
    if (!multiSel.size) return;
    pushUndo("unchain shots");
    const next: Project = {
      ...project,
      shots: project.shots.map((s) => (multiSel.has(s.id) ? { ...s, continueFromPrev: false } : s)),
    };
    ui.saveProject(next);
    ui.toast("Removed the continue-from-previous flag from the selection");
  };

  /**
   * Insert a shot at a position. `index` is the slot it should occupy, so 0 puts
   * it first and shots.length appends. `+ Shot` used to always append, which
   * meant inserting between shot 7 and 8 required drag-reorder gymnastics.
   */
  const addShotAt = async (index: number) => {
    const at = Math.max(0, Math.min(index, project.shots.length));
    try {
      const r = await api.addShot(project.id, { name: `Shot ${at + 1}` });
      // The server appends; move it into place locally and persist the order.
      const created = r.shot;
      if (created && at < project.shots.length) {
        const without = project.shots.filter((s) => s.id !== created.id);
        without.splice(at, 0, created);
        ui.saveProject({ ...project, shots: without });
        await ui.refreshAll();
        setSelId(created.id);
        return;
      }
      await ui.refreshAll();
      if (created) setSelId(created.id);
    } catch (e) {
      ui.toast(`Could not add a shot: ${(e as Error).message}`, "err");
    }
  };

  /** Selection entry point used by the timeline tiles (supports shift-click). */
  const selectShotById = (id: string, ev?: React.MouseEvent) => {
    const index = project.shots.findIndex((x) => x.id === id);
    if (index < 0) return;
    const shot = project.shots[index];
    // A drop-suppressed click (just finished a drag) must not change selection.
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    selectShot(shot, index, ev?.shiftKey ?? false);
  };

  const stepZoom = (dir: 1 | -1) => {
    setZoom((z) => {
      const next = clamp(z + dir, 0, TIMELINE_ZOOMS.length - 1);
      storeNumber(ZOOM_KEY, next);
      return next;
    });
  };

  return (
    <div ref={splitHostRef} className="script-split">
      <div className="tl-host" style={{ flex: `${tlPct} 1 0` }}>
        <ShotTimeline
          zoom={zoom}
          onZoom={stepZoom}
        project={project}
        assets={ui.assets}
        selId={sel?.id ?? null}
        onSelect={selectShotById}
        onSplit={(id) => void splitShot(id)}
        onPlayCut={() => setPlayCutOpen(true)}
        activeJob={activeJob}
        freeFormCount={freeFormCount}
        structuredCount={structuredCount}
        onStructureAll={() => setSaWin({ start: 0, end: project.shots.length })}
        onRename={(name) => ui.saveProject({ ...project, name })}
        onAddShot={() => void addShotAt(project.shots.length)}
        onRender={(ids, chain) => ui.renderShots(ids, chain)}
        structingId={structingId}
        onStructShot={(s) => { setSelId(s.id); void quickStructure(s); }}
        onStructMenu={showRangeMenu}
        onReorder={(from, to) => {
          // Snapshot BEFORE the splice so Ctrl+Z can put the order back exactly.
          pushUndo("reorder shots", project.shots[from]?.id);
          const shots = [...project.shots];
          const [it] = shots.splice(from, 1);
          shots.splice(to, 0, it);
          ui.saveProject({ ...project, shots });
        }}
        onResize={(shotId, seconds) => {
          pushUndo("resize shot", shotId);
          ui.mutateShot(shotId, { seconds });
        }}
        onDuplicate={(shotId) => api.duplicateShot(project.id, shotId).then(() => ui.refreshAll())}
        onDelete={(shotId) => {
          const s = project.shots.find((x) => x.id === shotId);
          // Undo makes this safe enough that a plain confirm is no longer the
          // only thing standing between a mis-click and lost work — but deleting
          // a shot also deletes its media, so still confirm.
          if (!confirm(`Delete shot “${s?.name || "Untitled"}”?\n\nIts takes and media are deleted too. You can undo the shot itself with Ctrl+Z, but the media is gone.`)) return;
          pushUndo("delete shot", shotId);
          api.deleteShot(project.id, shotId).then(() => ui.refreshAll());
        }}
        onAcceptTake={(shotId, takeId, accepted) => {
          const s = project.shots.find((x) => x.id === shotId);
          if (!s) return;
          pushUndo(accepted ? "accept take" : "un-accept take", shotId);
          setAccept(project, s, takeId, accepted, ui);
        }}
        onSetStillMode={async (shotId, m) => {
          try {
            pushUndo("change still mode", shotId);
            const updated = await api.setShotStill(project.id, shotId, m);
            ui.mutateShot(shotId, { still: updated.still, kind: updated.kind, firstFrameId: updated.firstFrameId });
            ui.toast(`Shot mode set to ${m === "t2i" ? "Text → Image (T2I)" : m === "i2i" ? "Image → Image (I2I)" : "Direct Video"}`);
          } catch (e) {
            ui.toast(`Could not change still stage: ${(e as Error).message}`, "err");
          }
        }}
        onAddShotAt={(index) => void addShotAt(index)}
        onDragSettled={() => { suppressClickRef.current = true; }}
        batch={{
          count: multiSel.size,
          anySelected: multiSel.size > 0,
          chain: batchChain,
          unchain: batchUnchain,
          render: () => {
            ui.renderShots(project.shots.filter((s) => multiSel.has(s.id)).map((s) => s.id));
            clearMulti();
          },
          structure: () => openRange(project.shots.findIndex((s) => multiSel.has(s.id)), project.shots.length),
          remove: batchDelete,
          clear: clearMulti,
        }}
        canUndo={ui.canUndo}
        onUndo={ui.undo}
        multiSel={multiSel}
        playhead={playhead}
      />
      </div>
      <div className="tl-vsplit" onPointerDown={startSplit}
        title="Drag to give the timeline more or less room (double-click resets it)"
        onDoubleClick={() => { setTlPct(58); storeNumber(SPLIT_KEY, 58); }}>
        <span className="tl-vsplit-grip" />
      </div>
      <div className="list-scroll" style={{ minWidth: 0, flex: `${100 - tlPct} 1 0`, minHeight: 140 }}>
        {sel ? <ShotInspector key={sel.id} shot={sel} /> : <div className="empty">Select or add a shot</div>}
      </div>
      {saWin && (
        <StructureAllModal
          key={`${project.id}:${saWin.start}:${saWin.end}`}
          start={saWin.start}
          end={saWin.end}
          onClose={() => setSaWin(null)}
        />
      )}
      {ctx && (
        <>
          <div
            className="ctx-back"
            onClick={() => setCtx(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}
          />
          <div className="ctxmenu" style={{ left: ctx.x, top: ctx.y }}>
            <div className="ctxmenu-title">⧉ Structure from shot {ctx.index + 1}</div>
            {menuOptions(ctx.index).map((o) => (
              <button key={o.end} onClick={() => { setCtx(null); openRange(o.start, o.end); }}>
                <span className="grow">{o.label}</span>
                <span className="muted small">{o.count} {o.count === 1 ? "shot" : "shots"}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {quickReview && (
        <StructReview
          review={{ proposed: quickReview.proposed, source: quickReview.source, model: quickReview.model }}
          original={quickReview.original}
          onApply={(t) => {
            ui.mutateShot(quickReview.shotId, { prompt: t });
            ui.toast(`Prompt restructured${quickReview.model ? ` with ${quickReview.model}` : ""}`);
            setQuickReview(null);
          }}
          onDiscard={() => setQuickReview(null)}
        />
      )}
      {playCutOpen && (
        <PlayCutModal
          onClose={() => { setPlayhead(null); setPlayCutOpen(false); }}
          onScrubToShot={setSelId}
          onPlayhead={setPlayhead}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Play cut — stitch accepted takes and play/scrub the assembled sequence
// ----------------------------------------------------------------------

/** Assembles the project's accepted (or last-ok) takes in order via the export
 *  pipeline, then plays the result with a custom scrubber: vertical markers mark
 *  each shot boundary, and the segment under the playhead is selected in the
 *  timeline as you scrub. */
function PlayCutModal({ onClose, onScrubToShot, onPlayhead }: {
  onClose: () => void;
  onScrubToShot?: (shotId: string) => void;
  /** Report the current time so the timeline can draw a playhead. */
  onPlayhead?: (seconds: number | null) => void;
}) {
  const ui = useUi();
  const project = ui.project!;
  const [phase, setPhase] = useState<"assembling" | "ready" | "error">("assembling");
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const jobIdRef = useRef<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const lastSegRef = useRef(-1);

  // Segment boundaries in normalized time [0..1], from each shot's accepted/last-ok
  // take duration (meta.durationS, else the shot's target seconds).
  const segs = project.shots.map((s) => {
    const acc = s.takes.find((t) => t.accepted && t.status === "ok") ?? [...s.takes].reverse().find((t) => t.status === "ok");
    const d = acc?.meta?.durationS && acc.meta.durationS > 0 ? acc.meta.durationS : s.seconds;
    return { id: s.id, name: s.name || "Untitled", d };
  });
  let cum = 0;
  const b = segs.map((g) => { const at = cum; cum += g.d; return { ...g, at }; });
  const total = cum || 1;
  const segIdxOf = (t: number) => {
    const raw = b.findIndex((g) => g.at + g.d > t);
    return raw === -1 ? segs.length - 1 : Math.max(0, raw); // past the end → last segment
  };
  const segIdx = segIdxOf(dur > 0 ? cur : 0);

  useEffect(() => {
    let disposed = false;
    api
      .export(project.id, project.shots.map((s) => s.id))
      .then((j) => { if (!disposed) jobIdRef.current = j.id; })
      .catch((e) => {
        if (disposed) return;
        setError((e as Error).message || "Could not start the assembly.");
        setPhase("error");
      });
    const iv = setInterval(async () => {
      const id = jobIdRef.current;
      if (!id) return;
      try {
        const log = await api.jobs();
        const j = log.export.find((x) => x.id === id);
        if (!j) return;
        if (j.status === "done" && j.file) {
          if (disposed) return;
          setFile(j.file);
          setPhase("ready");
          clearInterval(iv);
        } else if (j.status === "error") {
          if (disposed) return;
          setError(j.error || "Assembly failed.");
          setPhase("error");
          clearInterval(iv);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => { disposed = true; clearInterval(iv); };
  }, [project.id]);

  const okTakes = project.shots.filter((s) => s.takes.some((t) => t.status === "ok")).length;
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;

  const seekTo = (clientX: number) => {
    const v = videoRef.current;
    const bar = scrubRef.current;
    if (!v || !bar || !v.duration) return;
    const rect = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = f * v.duration;
    setCur(v.currentTime);
  };

  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      if (v.ended) v.currentTime = 0; // replay from the start after the cut finishes
      void v.play();
    } else {
      v.pause();
    }
  };

  const fmtT = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const ticks = [];
  for (let i = 0; i < b.length - 1; i++) ticks.push((b[i + 1].at / total) * 100);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(880px, 94vw)" }}>
        <div className="row" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", alignItems: "center" }}>
          <b>▶ Play cut</b>
          <div className="grow" />
          <span className="muted small">
            {phase === "assembling" ? `Assembling ${project.shots.length} shot${project.shots.length === 1 ? "" : "s"}…` : phase === "ready" ? `Ready · ${okTakes} shot${okTakes === 1 ? "" : "s"} with takes` : "Failed"}
          </span>
          <button className="small ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          {phase === "assembling" && (
            <div className="muted" style={{ padding: "40px 0", textAlign: "center" }}>
              <div className="progressbar" style={{ width: 320 }}><div style={{ width: "45%" }} /></div>
              <div className="small" style={{ marginTop: 10 }}>Stitching accepted takes into one sequence…</div>
            </div>
          )}
          {phase === "error" && <div className="err small" style={{ padding: 20 }}>{error}</div>}
          {phase === "ready" && file && (
            <div className="pl-wrap">
              <video
                ref={videoRef}
                src={exportUrl(file)}
                autoPlay
                playsInline
                preload="metadata"
                style={{ width: "100%", maxHeight: "56vh", borderRadius: 8, background: "#000" }}
                onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
                onTimeUpdate={(e) => {
                  setCur(e.currentTarget.currentTime);
                  onPlayhead?.(e.currentTarget.currentTime);
                  const idx = segIdxOf(e.currentTarget.currentTime);
                  if (idx !== lastSegRef.current && onScrubToShot) {
                    lastSegRef.current = idx;
                    onScrubToShot(segs[idx].id);
                  }
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => { setPlaying(false); onPlayhead?.(null); }}
              />
              <div className="pl-controls">
                <button className="pl-play" onClick={togglePlay} title={playing ? "Pause" : "Play"}>{playing ? "⏸" : "▶"}</button>
                <div className="pl-scrub" ref={scrubRef} onPointerDown={startScrub}
                  title="Click / drag to scrub · the vertical marks are shot boundaries">
                  <div className="pl-fill" style={{ width: `${pct}%` }} />
                  {ticks.map((tf, i) => (
                    <div key={i} className="pl-tick" style={{ left: `${tf}%` }} title={`${segs[i + 1].name} starts here`} />
                  ))}
                  <div className="pl-head" style={{ left: `${pct}%` }} />
                </div>
                <span className="pl-time">{fmtT(cur)} / {fmtT(dur)}</span>
              </div>
              <div className="pl-now">
                <span className="muted small">Scene {segIdx + 1}/{segs.length}</span>
                <span className="pl-now-name">{segs[segIdx].name}</span>
              </div>
            </div>
          )}
          <div className="muted small">Shots rendered with the seamless chain have frame-perfect cuts here. The marks on the bar are approximate shot boundaries; scrubbing selects that shot in the timeline.</div>
        </div>
        <div className="row" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", justifyContent: "flex-end" }}>
          <button className="small" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Timeline — the Script tab's primary workspace: a time-scaled storyboard strip
// whose zoom and vertical share of the window are both under the director's
// control (and remembered between sessions).
// ----------------------------------------------------------------------

/** Zoom steps in pixels per second of shot duration. Index 2 is the default, which
 *  makes a 5s shot a ~280px tile — big enough to read and to click. */
const TIMELINE_ZOOMS = [28, 40, 56, 76, 100, 128];
const TIMELINE_ZOOM_DEFAULT = 2;
/** Tiles never render narrower than this many seconds of scale, so even a 1s shot can
 *  hold its controls. The ruler uses the same widths, so it stays aligned either way. */
const TIMELINE_MIN_SEC = 4;

/**
 * H3's single-generation ceiling, in seconds.
 *
 * This was hardcoded to 12 here while the engine clamped to 15, so a 13-15s shot
 * was impossible to reach by dragging even though the model can render it, and
 * the tile tooltip asserted a limit the engine did not have. The backend owns
 * the real constant (MAX_SHOT_SECONDS in backend/src/types.ts) and exposes it
 * through the settings/status payload; this is the fallback used before that
 * arrives, and the two are asserted equal by the timeline check.
 */
const TIMELINE_MAX_SEC = 15;
/** Horizontal space between tiles — mirrored by the gap on .timeline-track and
 *  .timeline-ruler in styles.css, so every pixel calculation here lines up with paint. */
const TIMELINE_GAP = 6;
const ZOOM_KEY = "h3.timelineZoom";
const SPLIT_KEY = "h3.timelineSplit";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** localStorage is best-effort: throw on read/write in restricted webviews. */
function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function storeNumber(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

function fmtDur(sec: number): string {
  const rounded = Math.round(sec * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

function tileWidth(seconds: number, pxPerSec: number): number {
  return Math.max(Math.round(pxPerSec * TIMELINE_MIN_SEC), Math.round(seconds * pxPerSec));
}

/** The thumbnail height scales with the zoom so the whole workspace grows together
 *  instead of only stretching horizontally. */
function thumbHeight(pxPerSec: number): number {
  return clamp(Math.round(pxPerSec * 2.6), 110, 320);
}

/** Smoothly animate a scroll container's scrollLeft to `to` over `dur` ms. We drive
 *  scrollLeft through requestAnimationFrame with an ease-in-out instead of relying on
 *  `scrollTo({ behavior: "smooth" })`, which is not animated in the app's webview.
 *  Returns a cancel function so a newer animation can supersede an in-flight one
 *  (e.g. rapid playhead scrubbing must not stack competing scroll loops). */
function animateScroll(el: HTMLElement, to: number, dur = 260): () => void {
  const from = el.scrollLeft;
  const dist = to - from;
  if (Math.abs(dist) < 1) return () => {};
  const start = performance.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  let raf = 0;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / dur);
    el.scrollLeft = from + dist * ease(t);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/** Primary timeline: a horizontal, time-scaled storyboard of the shot sequence with
 *  thumbnails, duration ruler, chain seams, drag-to-reorder, edge-drag duration and
 *  click-to-select. It is now the Script tab's primary view; the inspector below is
 *  the detail view. All project-wide actions (rename, +shot, render, chain, structure
 *  all, play cut) live in its toolbar. */
function ShotTimeline({ project, assets, selId, onSelect, onSplit, onPlayCut, activeJob, freeFormCount, structuredCount, onStructureAll, onRename, onAddShot, onAddShotAt, onDragSettled, canUndo, onUndo, batch, multiSel, playhead, onRender, onReorder, onResize, onDuplicate, onDelete, onAcceptTake, structingId, onStructShot, onStructMenu, onSetStillMode, zoom, onZoom }: {
  project: Project;
  assets: LibraryAsset[];
  selId: string | null;
  onSplit?: (shotId: string) => void;
  onPlayCut?: () => void;
  activeJob: RenderJob | null;
  freeFormCount: number;
  structuredCount: number;
  onStructureAll: () => void;
  onRename: (name: string) => void;
  onAddShot: () => void;
  /** Insert a shot at a slot (0 = first, shots.length = append). */
  onAddShotAt?: (index: number) => void;
  /** A drag-reorder just committed; swallow the click that follows it. */
  onDragSettled?: () => void;
  canUndo?: boolean;
  onUndo?: () => void;
  /**
   * Batch toolbar, owned by ScriptView but rendered by the timeline so it sits
   * with the other project-wide actions. Only shown when anySelected is true.
   */
  batch?: {
    count: number;
    anySelected: boolean;
    chain: () => void;
    unchain: () => void;
    render: () => void;
    structure: () => void;
    remove: () => void;
    clear: () => void;
  };
  onRender: (shotIds: string[], forceChain?: boolean) => void;
  onReorder: (from: number, to: number) => void;
  onResize: (shotId: string, seconds: number) => void;
  onDuplicate: (shotId: string) => void;
  onDelete: (shotId: string) => void;
  onAcceptTake: (shotId: string, takeId: string, accepted: boolean) => void;
  structingId: string | null;
  onStructShot: (shot: Shot) => void;
  onStructMenu: (e: React.MouseEvent, index: number) => void;
  onSetStillMode?: (shotId: string, mode: "t2i" | "i2i" | "none") => void;
  /** Index into TIMELINE_ZOOMS; onZoom steps it from the toolbar control. */
  zoom: number;
  onZoom: (dir: 1 | -1) => void;
  onSelect: (id: string, ev?: React.MouseEvent) => void;
  /** Ids in the shift-click batch selection, for the tile's selected outline. */
  multiSel: Set<string>;
  /** Current playhead position in seconds within the cut, or null when stopped. */
  playhead?: number | null;
}) {
  const pxPerSec = TIMELINE_ZOOMS[clamp(zoom, 0, TIMELINE_ZOOMS.length - 1)];
  // The engine's real ceiling, once Settings has loaded; the constant is only a
  // pre-load fallback.
  const maxSec = useUi().settings?.limits?.maxShotSeconds ?? TIMELINE_MAX_SEC;
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [resize, setResize] = useState<{ id: string; seconds: number } | null>(null);
  const suppressClick = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Live reorder preview: while dragging, the grabbed tile is rendered in its target slot.
  const ordered = drag
    ? (() => {
        const arr = [...project.shots];
        const [it] = arr.splice(drag.from, 1);
        arr.splice(drag.to, 0, it);
        return arr;
      })()
    : project.shots;
  const widths = ordered.map((s) => tileWidth(resize && resize.id === s.id ? resize.seconds : s.seconds, pxPerSec));
  let cum = 0;
  const rulerSegs = ordered.map((s, i) => {
    const at = cum;
    cum += resize && resize.id === s.id ? resize.seconds : s.seconds;
    return { at, width: widths[i] };
  });
  const total = cum;
  const hasOkTake = project.shots.some((s) => s.takes.some((t) => t.status === "ok"));

  /**
   * The playhead's x offset, in the same pixel space as the ruler.
   *
   * The ruler segments are not uniform (each is a shot's own width), so the
   * playhead has to be placed by walking the segments rather than by scaling
   * `time * pxPerSec` — otherwise it would drift against the tick labels
   * whenever the min-width floor made a short shot wider than its duration.
   */
  const playheadPx = (() => {
    if (playhead == null) return 0;
    let x = 0;
    for (let i = 0; i < rulerSegs.length; i++) {
      const seg = rulerSegs[i];
      if (playhead <= seg.at) break;
      const dur = (resize && resize.id === ordered[i]?.id ? resize.seconds : ordered[i]?.seconds) ?? 0;
      if (playhead < seg.at + dur) {
        // Inside a shot: scale by the real px/second, not the floored tile width,
        // so the line moves smoothly while a sub-4s shot is drawn wide.
        x += (playhead - seg.at) * pxPerSec;
        return x;
      }
      x += seg.width;
    }
    return x;
  })();

  // Drop-caret: a visible "drop here" line at the left edge of the target slot (the
  // boundary the grabbed tile will land on), so the destination stays clear during
  // fast auto-scroll. `ordered` already has the grabbed tile spliced to drag.to, so
  // summing the widths before that index gives the insertion boundary's x offset.
  let caretX = 0;
  if (drag) for (let i = 0; i < drag.to; i++) caretX += widths[i] + TIMELINE_GAP;

  /** Drag-to-reorder: pointerdown on a tile body starts a drag; tiles reflow live to
   *  the hovered slot and the new order is committed (via /reorder) on release. When
   *  the pointer nears the container's left/right edge the timeline auto-scrolls, so
   *  long timelines can be reordered without ever lifting the mouse. */
  const startDrag = (e: React.PointerEvent, from: number) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, .tl-actions, .tl-resize, .tl-takes, a, input, textarea")) return;
    e.preventDefault();
    setDrag({ from, to: from });
    const ptrX = { v: e.clientX };
    const cur = { from, to: from }; // mutable live target, so `up` can read the final slot
    let raf = 0;
    let lastScrollLeft = -1;

    /** Which slot is under a given client-X (in the current scroll position). */
    const hoverFor = (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = clientX - rect.left;
      let hover = project.shots.length - 1;
      let acc = 0;
      for (let i = 0; i < project.shots.length; i++) {
        acc += tileWidth(project.shots[i].seconds, pxPerSec) + TIMELINE_GAP;
        if (x < acc) { hover = i; break; }
      }
      cur.to = hover;
      setDrag((d) => (d ? { from: d.from, to: hover } : d));
    };

    /** Scroll loop: runs for the whole drag; only acts (and updates the drop target)
     *  when the pointer is within EDGE_ZONE px of a visible edge. */
    const tick = () => {
      const el = scrollRef.current;
      if (!el) { raf = 0; return; }
      const rect = el.getBoundingClientRect();
      const zone = 44;
      let speed = 0;
      if (ptrX.v < rect.left + zone) speed = -Math.max(3, (rect.left + zone - ptrX.v) * 0.45);
      else if (ptrX.v > rect.right - zone) speed = Math.max(3, (ptrX.v - (rect.right - zone)) * 0.45);
      panelRef.current?.classList.toggle("tl-edge-left", speed < 0);
      panelRef.current?.classList.toggle("tl-edge-right", speed > 0);
      if (speed !== 0) {
        el.scrollLeft += speed;
        if (el.scrollLeft !== lastScrollLeft) {
          lastScrollLeft = el.scrollLeft;
          hoverFor(ptrX.v); // re-evaluate the target as new tiles scroll into view
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const move = (ev: PointerEvent) => {
      ptrX.v = ev.clientX;
      hoverFor(ev.clientX);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scrollRef.current?.classList.remove("tl-edge-left", "tl-edge-right");
      if (cur.to !== cur.from) {
        onReorder(cur.from, cur.to);
        suppressClick.current = true; // don't let the drop select a different tile
        onDragSettled?.();
        // Keep the just-moved tile in view: after an auto-scroll the drop can land far
        // off-screen, so smooth-scroll the container to bring that tile back into view.
        const el = scrollRef.current;
        if (el) {
          const arr = [...project.shots];
          const [moved] = arr.splice(cur.from, 1);
          arr.splice(cur.to, 0, moved);
          let left = 0;
          for (let i = 0; i < cur.to; i++) left += tileWidth(arr[i].seconds, pxPerSec) + TIMELINE_GAP;
          const w = tileWidth(moved.seconds, pxPerSec);
          const vp = el.clientWidth;
          let target: number | undefined;
          if (left < el.scrollLeft) target = left;
          else if (left + w > el.scrollLeft + vp) target = left + w - vp;
          if (target !== undefined) animateScroll(el, Math.max(0, target));
        }
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    raf = requestAnimationFrame(tick);
  };

  /**
   * Edge-drag: the right-edge handle resizes the shot's duration in 0.5s steps,
   * previewing live via local state and committing on release.
   *
   * The ceiling is H3's real single-generation limit, taken from the server so
   * this handle cannot claim a range the engine will not render. It used to be a
   * local 12 while the engine allowed 15, making 13-15s unreachable by dragging.
   */
  const startResize = (e: React.PointerEvent, shot: Shot) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startSec = shot.seconds;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - e.clientX;
      const sec = Math.round(((startSec * pxPerSec + dx) / pxPerSec) * 2) / 2;
      setResize({ id: shot.id, seconds: Math.min(maxSec, Math.max(1, sec)) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResize((r) => {
        if (r && Math.abs(r.seconds - startSec) >= 0.4) onResize(r.id, r.seconds);
        return null;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const select = (id: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    onSelect(id);
  };

  const { renderBlocked } = useUi();
  const thumbH = thumbHeight(pxPerSec);

  return (
    <div className="tl-panel" ref={panelRef}>
      <div className="timeline-toolbar">
        <input value={project.name} style={{ width: 170, fontWeight: 700 }} title="Project name"
          onChange={(e) => onRename(e.target.value)} />
        <button className="small" onClick={onAddShot} title="Add a shot to the end of the timeline">+ Shot</button>
        <button className="primary small" disabled={!!activeJob || !!renderBlocked || project.shots.length === 0}
          onClick={() => onRender(project.shots.map((s) => s.id))} title={renderBlocked || "Render every shot"}>
          ▶ Render all
        </button>
        <button className="small" disabled={!!activeJob || !!renderBlocked || project.shots.length < 2}
          onClick={() => onRender(project.shots.map((s) => s.id), true)}
          title={renderBlocked || "Each next shot continues from the last frame of the previous one"}>
          🔗 Seamless chain
        </button>
        <button className="small" disabled={freeFormCount === 0}
          onClick={onStructureAll}
          title={freeFormCount === 0
            ? structuredCount > 0
              ? "Every prompt already has the four-section structure — nothing to rewrite."
              : "Add a prompt to a shot first."
            : `Rewrites ${freeFormCount} free-form prompt${freeFormCount === 1 ? "" : "s"}${structuredCount ? ` · ${structuredCount} already structured will be skipped` : ""} — review each result before applying.`}>
          ⧉ Structure all ({freeFormCount})
        </button>
        {batch && batch.anySelected && (
          <div className="tl-batch" title="Batch actions for the selected shots — shift-click tiles to build a range">
            <span className="chip">{batch.count} selected</span>
            <button className="small" onClick={batch.chain} title="Each selected shot continues from the previous selected shot's final frame">
              🔗 Chain
            </button>
            <button className="small" onClick={batch.unchain} title="Remove continue-from-previous from the selection">
              Unchain
            </button>
            <button
              className="small"
              disabled={!!activeJob || !!renderBlocked}
              title={renderBlocked || "Render every selected shot"}
              onClick={batch.render}
            >
              ▶ Render {batch.count}
            </button>
            <button className="small" onClick={batch.structure} title="Structure the selected shots and everything after them">
              ⧉ Structure
            </button>
            <button className="small tl-act-danger" onClick={batch.remove} title="Delete the selected shots and their media">
              ✕ Delete {batch.count}
            </button>
            <button className="small" onClick={batch.clear} title="Clear the selection">Clear</button>
          </div>
        )}
        <div className="grow" />
        <button
          className="small"
          disabled={!canUndo}
          onClick={onUndo}
          title={canUndo ? "Undo the last change (Ctrl+Z)" : "Nothing to undo"}
        >
          ↶ Undo
        </button>
        {/* Zoom lives in the always-visible toolbar so the timeline can be made as big
            or as overview-y as the work of the moment needs. */}
        <div className="tl-zoom" title="Timeline zoom — how many pixels one second of shot duration is worth">
          <button className="tl-zbtn" disabled={zoom <= 0} onClick={() => onZoom(-1)}
            title="Zoom out (more shots on screen)">−</button>
          <span className="tl-zval">{pxPerSec} px/s</span>
          <button className="tl-zbtn" disabled={zoom >= TIMELINE_ZOOMS.length - 1} onClick={() => onZoom(1)}
            title="Zoom in (bigger frames, easier clicking)">+</button>
        </div>
        <span className="muted small">Cut — {fmtDur(total)}</span>
        {hasOkTake && onPlayCut && (
          <button className="small primary" onClick={onPlayCut}
            title="Stitch the accepted takes in order into one sequence and play it (with scrubbing)">
            ▶ Play cut
          </button>
        )}
      </div>
      <div className="timeline-scroll" ref={scrollRef}>
        {project.shots.length === 0 ? (
          <div className="tl-empty"><span className="muted small">No shots yet — press “+ Shot” to start directing.</span></div>
        ) : (
          <>
            <div className="timeline-ruler">
              {/* The "now" line: where the running cut is. A director reading the
                  timeline needs to know which shot they are looking at mid-review,
                  and the PlayCut player already knows this time. */}
              {playhead != null && (
                <div className="tl-playhead" style={{ left: playheadPx }} title={`Playhead at ${fmtDur(playhead)}`}>
                  <span className="tl-playhead-label">{fmtDur(playhead)}</span>
                </div>
              )}
              {rulerSegs.map((seg, i) => (
                <div key={ordered[i].id} className="tl-ruler-seg" style={{ width: seg.width }} title={`shot starts at ${seg.at.toFixed(1)}s`}>
                  <span>{fmtDur(seg.at)}</span>
                </div>
              ))}
              <div className="tl-ruler-end">total {fmtDur(total)}</div>
            </div>
            <div className="timeline-track" ref={trackRef}>
              {ordered.map((s, i) => {
                const origIndex = project.shots.findIndex((x) => x.id === s.id);
                const isDrag = drag !== null && drag.from === origIndex;
                return (
                  <TimelineTile
                    key={s.id}
                    shot={s}
                    index={origIndex}
                    width={widths[i]}
                    thumbH={thumbH}
                    assets={assets}
                    selected={s.id === selId && !isDrag}
                    dragging={isDrag}
                    structing={s.id === structingId}
                    onSelect={onSelect}
                    onPointerDown={(e) => startDrag(e, origIndex)}
                    onResizeStart={(e) => startResize(e, s)}
                    onSplit={onSplit}
                    onRender={onRender}
                    onDuplicate={onDuplicate}
                    onDelete={onDelete}
                    activeJob={activeJob}
                    onAcceptTake={onAcceptTake}
                    onStructClick={(e) => { e.stopPropagation(); onStructShot(s); }}
                    onStructMenu={(e) => onStructMenu(e, origIndex)}
                    onSetStillMode={onSetStillMode}
                    maxSec={maxSec}
                    inMulti={multiSel.has(s.id)}
                    onInsertBefore={() => onAddShotAt?.(origIndex)}
                  />
                );
              })}
              {drag && <div className="tl-caret" style={{ left: caretX }} title="drop here" />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Reference caps. These MUST match the engine, which silently drops anything beyond
 * them at render time (PICTURE_MAX / VIDEO_MAX / AUDIO_MAX in backend/src/engine.ts);
 * showing 0 / 9 while only ever allowing 8 would be a lie. The still-stage editor
 * matches ImagesView's MAX_REFS of 8.
 */
const REF_IMAGE_MAX = 9;
const REF_VIDEO_MAX = 3;
const REF_AUDIO_MAX = 3;
const STILL_REF_MAX = 8;

/**
 * Append new ids to a reference list, keeping order, dropping duplicates (re-attaching
 * an asset that is already there must not duplicate it) and capping at `max`.
 */
function mergeRefs(current: string[], next: string[], max: number): string[] {
  const out = [...current];
  for (const id of next) if (!out.includes(id)) out.push(id);
  return out.slice(0, max);
}

/** True when a drag carries OS files (not a tile being reordered, not a text selection). */
function dragHasFiles(e: React.DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files");
}

function TimelineTile({ shot, index, width, thumbH, assets, selected, dragging, structing, onSelect, onPointerDown, onResizeStart, onSplit, onRender, onDuplicate, onDelete, activeJob, onAcceptTake, onStructClick, onStructMenu, onSetStillMode, inMulti, onInsertBefore }: {
  shot: Shot;
  index: number;
  width: number;
  /** Thumbnail height in px for the current zoom (also drives --tl-thumb-h). */
  thumbH: number;
  assets: LibraryAsset[];
  selected: boolean;
  dragging: boolean;
  structing: boolean;
  onSelect: (id: string, ev?: React.MouseEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onSplit?: (shotId: string) => void;
  onRender: (ids: string[], forceChain?: boolean) => void;
  onDuplicate: (shotId: string) => void;
  onDelete: (shotId: string) => void;
  activeJob: RenderJob | null;
  onAcceptTake: (shotId: string, takeId: string, accepted: boolean) => void;
  onStructClick: (e: React.MouseEvent) => void;
  onStructMenu: (e: React.MouseEvent) => void;
  onSetStillMode?: (shotId: string, mode: "t2i" | "i2i" | "none") => void;
  /** H3's real per-shot ceiling, so the tooltips above cannot lie about it. */
  maxSec?: number;
  /** Part of the shift-click batch selection. */
  inMulti?: boolean;
  /** Insert a new shot immediately before this one. */
  onInsertBefore?: () => void;
}) {
  const uiCtx = useUi();
  const maxSec = uiCtx.settings?.limits?.maxShotSeconds ?? TIMELINE_MAX_SEC;
  const lastOk = [...shot.takes].reverse().find((t) => t.status === "ok");
  const firstFrame = shot.firstFrameId ? assets.find((a) => a.id === shot.firstFrameId) : undefined;
  const characterAsset = shot.characterId ? assets.find((a) => a.id === shot.characterId) : undefined;
  const refImage = shot.kind === "r2v"
    ? (characterAsset ?? (shot.imageIds[0] ? assets.find((a) => a.id === shot.imageIds[0]) : undefined))
    : undefined;

  // Resolve still take thumbnail if available
  const stillTakes = shot.still?.takes ?? [];
  const selectedStillTake = shot.still?.selectedTakeId ? stillTakes.find((t) => t.id === shot.still?.selectedTakeId) : undefined;
  const lastStillOk = selectedStillTake || [...stillTakes].reverse().find((t) => t.status === "ok");

  const badge = width >= 110 ? promptStructureBadge(shot.prompt, onStructClick, onStructMenu) : null;
  const isFree = shot.prompt.trim().length > 0 && !isStructuredPrompt(shot.prompt);
  const rendering = activeJob?.perShot[shot.id]?.status === "running";
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  const accept = (t: Take) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (t.status !== "ok") return; // error takes can't be accepted
    onAcceptTake(shot.id, t.id, !t.accepted);
  };
  /**
   * These are role="button" spans so they can sit inside the draggable tile
   * without each one being a real <button> (which would swallow the pointer
   * events the drag handler relies on). That left them focusable but inert for
   * keyboard users, so give them the activation keys a button is expected to
   * have. Enter and Space both fire click on a real button, so they must here.
   */
  const keyActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  const actProps = (title: string, fn: () => void) => ({
    role: "button" as const,
    tabIndex: 0,
    title,
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); fn(); },
    onKeyDown: keyActivate(fn),
  });
  const { renderBlocked } = useUi();
  const currentMode: "t2i" | "i2i" | "none" = shot.still?.mode ?? "none";

  // ---------- drop an image straight onto this shot ----------
  // Dragging a file in from Explorer used to fall through to the app-wide handler in
  // <App> and land in the Library with no link to the shot you aimed at. Now the tile
  // is a real drop target: the file is uploaded, then attached to THIS shot.
  //
  // stopPropagation() on the drop is what keeps the window-level handler in <App> from
  // uploading the same file a second time - the same reason DropZone stops it.
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const { toast, refreshAll, mutateShot } = useUi();

  const onFilesDropped = async (list: FileList | null) => {
    if (!list) return;
    const files = Array.from(list);
    if (!files.length) return;
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
    const others = files.filter((f) => !images.includes(f));
    if (others.length) toast(`Only images can be dropped on a shot — skipped: ${others.map((f) => f.name).join(", ")}`, "err");
    if (!images.length) return;

    const uploaded: string[] = [];
    for (const f of images) {
      try {
        const a = await api.uploadAsset(f);
        uploaded.push(a.id);
      } catch (e) {
        toast(`Upload of ${f.name} failed: ${(e as Error).message}`, "err");
      }
    }
    if (!uploaded.length) return;
    await refreshAll();

    if (shot.kind === "r2v") {
      // r2v drives the engine from its reference list, so the images go there.
      const merged = mergeRefs(shot.imageIds, uploaded, REF_IMAGE_MAX);
      const added = merged.length - shot.imageIds.length;
      mutateShot(shot.id, { imageIds: merged });
      toast(added
        ? `Added ${added} reference image${added === 1 ? "" : "s"} to "${shot.name || "Untitled"}"`
        : "Those images are already references on this shot");
      return;
    }

    // Everything else takes the first image as its start frame. A t2v shot with a start
    // image is really i2v, and an explicit image must beat seamless chaining - the same
    // two rules the server applies in useStillAsFirstFrame.
    const [first, ...rest] = uploaded;
    const patch: Partial<Shot> = { firstFrameId: first, continueFromPrev: false };
    if (shot.kind === "t2v") patch.kind = "i2v";
    if (rest.length) patch.imageIds = mergeRefs(shot.imageIds, rest, REF_IMAGE_MAX);
    mutateShot(shot.id, patch);
    toast(rest.length
      ? `Set the first frame of "${shot.name || "Untitled"}" and added ${rest.length} more as reference${rest.length === 1 ? "" : "s"}`
      : `Set as the first frame of "${shot.name || "Untitled"}"`);
  };

  const compact = width < 190; // too narrow for the full three-button mode switcher
  const nextMode: "t2i" | "i2i" | "none" = currentMode === "t2i" ? "i2i" : currentMode === "i2i" ? "none" : "t2i";
  const modeShort = currentMode === "t2i" ? "T2I" : currentMode === "i2i" ? "I2I" : "Vid";
  const modeKey = currentMode === "none" ? "direct" : currentMode;

  return (
    <div
      className={`tl-tile ${selected ? "sel" : ""} ${inMulti ? "tl-multi" : ""} ${shot.continueFromPrev ? "chained" : ""} ${dragging ? "tl-drag" : ""} ${dropping ? "tl-file-over" : ""}`}
      style={{ width, "--tl-thumb-h": `${thumbH}px` } as React.CSSProperties}
      onClick={(e) => onSelect(shot.id, e)}
      onPointerDown={onPointerDown}
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation(); // don't let the window overlay take over the whole screen
        dropDepth.current++;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault(); // without this the browser refuses the drop
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dropDepth.current = Math.max(0, dropDepth.current - 1);
        if (dropDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        // Always swallow the drop, files or not, so the window handler can't also act.
        e.preventDefault();
        e.stopPropagation();
        dropDepth.current = 0;
        setDropping(false);
        if (dragHasFiles(e)) void onFilesDropped(e.dataTransfer.files);
      }}
      title={`${index + 1}. ${shot.name || "Untitled"} — ${fmtDur(shot.seconds)}${shot.continueFromPrev ? " · continues from previous shot's final frame" : ""}\nDrag to reorder · drag the right edge to change the length (1–${maxSec}s)`}
    >
      {/* Control row lives ABOVE the frame, never on top of it: the mode switcher and
          the action buttons share this flex row, so they can no longer collide with each
          other or with the duration handle at narrow widths. */}
      <div className="tl-head">
        {shot.continueFromPrev && <span className="tl-chain" title="Continues from the previous shot's final frame">🔗</span>}
        {characterAsset && (
          <span className="tl-chain" title={`Identity locked to ${characterAsset.name}`}>🔒</span>
        )}

        {onSetStillMode && (compact ? (
          <button
            type="button"
            className={`tl-mode-btn compact active ${modeKey}`}
            title={`Still stage: ${modeShort} — click to switch to ${nextMode === "t2i" ? "T2I" : nextMode === "i2i" ? "I2I" : "direct video"}`}
            onClick={stop(() => onSetStillMode(shot.id, nextMode))}
          >
            {modeShort}
          </button>
        ) : (
          <div className="tl-mode-switcher" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`tl-mode-btn ${currentMode === "t2i" ? "active t2i" : ""}`}
              title="Text to Image (Qwen Still Stage)"
              onClick={stop(() => onSetStillMode(shot.id, "t2i"))}
            >
              T2I
            </button>
            <button
              type="button"
              className={`tl-mode-btn ${currentMode === "i2i" ? "active i2i" : ""}`}
              title="Image to Image (Qwen Still Stage)"
              onClick={stop(() => onSetStillMode(shot.id, "i2i"))}
            >
              I2I
            </button>
            <button
              type="button"
              className={`tl-mode-btn ${currentMode === "none" ? "active direct" : ""}`}
              title="Direct Video (No Still Stage)"
              onClick={stop(() => onSetStillMode(shot.id, "none"))}
            >
              Vid
            </button>
          </div>
        ))}

        <span className="tl-head-fill" />

        <div className="tl-actions" onPointerDown={(e) => e.stopPropagation()}>
            <span className="tl-act" {...actProps(renderBlocked || "Render this shot", () => { if (!renderBlocked) onRender([shot.id]); })}>▶</span>
            {onSplit && !compact && (
              <span className="tl-act" {...actProps("Split this shot into two consecutive shots", () => onSplit(shot.id))}>✂</span>
            )}
            {!compact && (
              <span className="tl-act" {...actProps("Duplicate this shot", () => onDuplicate(shot.id))}>⧉</span>
            )}
            {onInsertBefore && !compact && (
              <span className="tl-act" {...actProps("Insert a new shot directly before this one", () => onInsertBefore())}>＋</span>
            )}
            <span className="tl-act tl-act-danger" {...actProps("Delete this shot", () => onDelete(shot.id))}>✕</span>
        </div>
      </div>
      <div className="tl-thumb">
        {lastOk?.videoFile ? (
          <video src={outputUrl(lastOk.videoFile)} muted preload="metadata" />
        ) : firstFrame ? (
          <img src={assetUrl(firstFrame)} alt="" />
        ) : lastStillOk?.imageFile ? (
          <img src={imageUrl(lastStillOk.imageFile)} alt="" />
        ) : refImage ? (
          <img src={assetUrl(refImage)} alt="" />
        ) : (
          <div className="tl-ph">
            <div className="tl-ph-icon">{currentMode === "t2i" ? "🎨" : currentMode === "i2i" ? "🖼️" : "🎬"}</div>
            <div className="tl-ph-label">{currentMode === "t2i" ? "TEXT → STILL" : currentMode === "i2i" ? "IMG → STILL" : shot.kind.toUpperCase()}</div>
            <div className="tl-ph-sub">{currentMode !== "none" ? "Stage 1 ready" : "Direct video"}</div>
          </div>
        )}
        <div className="tl-resize" title={`Drag to change the duration (1–${maxSec}s)`} onPointerDown={onResizeStart} />
        {dropping && (
          <div className="tl-file-hint">
            <span className="tl-file-hint-icon">🖼</span>
            <span>{shot.kind === "r2v" ? "Add as reference" : "Set as first frame"}</span>
          </div>
        )}
      </div>
      <div className="tl-info">
        <span className="tl-name">{index + 1}. {shot.name || "Untitled"}</span>
        <span className="tl-dur">{fmtDur(shot.seconds)}</span>
      </div>
      {shot.prompt && (
        <div className="tl-prompt-preview" title={shot.prompt}>
          {shot.prompt.replace(/^\[.*?\]\s*/, "")}
        </div>
      )}
      <div className="tl-badge">
        {structing ? (
          <span className="chip" title="Structuring this prompt with the AI co-director…">⧉ structuring…</span>
        ) : badge}
        {badge && isFree && (
          <span className="chip chip-caret actionable" role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onStructMenu(e); }}
            onContextMenu={(e) => { e.stopPropagation(); onStructMenu(e); }}
            title="Structure this shot plus the shots that follow it">
            ▾
          </span>
        )}
      </div>
      {(rendering || shot.takes.length > 0) && (
        <div className="tl-takes" onPointerDown={(e) => e.stopPropagation()}>
          {rendering && <div className="tl-take rendering" title="This shot is being rendered now">⟳ rendering…</div>}
          {shot.takes.map((t) => (
            <div
              key={t.id}
              className={`tl-take ${t.status === "ok" ? "ok" : "error"}${t.accepted ? " acc" : ""}`}
              onClick={accept(t)}
              title={t.status === "ok"
                ? (t.accepted ? "Accepted — click to un-accept" : `Seed ${t.seed}${t.meta?.durationS ? ` · ${t.meta.durationS.toFixed(1)}s` : ""} — click to accept (used by Play cut & export)`)
                : `Failed: ${t.error || "render error"}`}
            >
              {t.status === "ok" && (t.videoFile || t.thumbFile) && (
                t.videoFile
                  ? <video src={outputUrl(t.videoFile)} muted preload="metadata" className="tl-take-thumb" />
                  : <img src={outputUrl(t.thumbFile!)} alt="" className="tl-take-thumb" />
              )}
              <span className="tl-take-glyph">{t.status === "ok" ? "✓" : "✗"}</span>
              <span className="tl-take-seed">#{t.seed}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** True when the prompt already opens with the four-section header (mirrors the
 *  backend's isStructuredPrompt — such shots are skipped by Structure all). */
function isStructuredPrompt(prompt: string): boolean {
  return /^\[\s*Subject \+ Action\s*\]/i.test(prompt.trim());
}

/** Small pill on each shot card showing the structure state of its prompt. When a
 *  free-form prompt is shown and onClick is given, the badge is clickable and jumps
 *  straight into structuring that single shot. Right-click (or the ▾ caret beside
 *  it) opens a menu to structure this shot plus the shots that follow it. */
function promptStructureBadge(
  prompt: string,
  onClick?: (e: React.MouseEvent) => void,
  onContextMenu?: (e: React.MouseEvent) => void,
): React.ReactNode | null {
  if (!prompt.trim()) return null; // no prompt yet — nothing to structure
  if (isStructuredPrompt(prompt)) {
    return (
      <span className="chip ok" title="Prompt is already in the four-section [Subject + Action] format — Structure all skips it">
        ✓ structured
      </span>
    );
  }
  const clickable = !!onClick;
  const hasMenu = !!onContextMenu;
  return (
    <span
      className={`chip muted${clickable ? " actionable" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } } : undefined}
      title={clickable
        ? (hasMenu ? "Click: structure this shot · Right-click (or ▾): this shot + following" : "Free-form prompt — click to structure it now into the four sections")
        : "Free-form prompt — structure it with ⧉ Structure prompt or Structure all"}
    >
      ⧉ free-form
    </span>
  );
}

/** Stage 1 of the shot pipeline: the Qwen still that this shot will animate.
 *  Lives inside the shot inspector so picture and motion are one workflow. */
function StillStage({ shot, imageAssets }: { shot: Shot; imageAssets: LibraryAsset[] }) {
  const ui = useUi();
  const p = ui.project!;
  const still = shot.still!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Local edits save on blur so typing never round-trips per keystroke.
  const patch = async (p2: Partial<ShotStill>) => {
    ui.mutateShot(shot.id, { still: { ...still, ...p2 } } as Partial<Shot>);
    try {
      const updated = await api.setShotStill(p.id, shot.id, null, p2);
      ui.mutateShot(shot.id, { still: updated.still });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /**
   * Queue a still render. The server used to block this request for the whole
   * multi-minute render, so the button sat on "Rendering…" with no feedback and
   * a second click could put two jobs on the GPU. It now returns an ImageJob
   * immediately and the work is serialized with every other GPU job; the bus
   * tells us when it lands.
   */
  const renderStill = async () => {
    setErr("");
    setBusy(true);
    try {
      const job = await api.renderShotStill(p.id, shot.id);
      setPendingJob(job.id);
      ui.toast("Still queued — it will render as soon as the GPU is free");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  // While our own still job is in flight the button stays busy; the shot's
  // `still` block arrives over the bus, so we clear it there.
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingJob) return;
    return onBusEvent((ev) => {
      if (ev.type === "shotStillDone" && ev.jobId === pendingJob) {
        setPendingJob(null);
        setBusy(false);
        void ui.refreshAll();
        ui.toast("Still rendered — it is now this shot's first frame");
      }
      if (ev.type === "imageJobDone" && ev.jobId === pendingJob) {
        const data = ev.data as { status?: string; error?: string } | undefined;
        setPendingJob(null);
        setBusy(false);
        if (data?.status === "error") setErr(data.error ?? "The still render failed.");
        void ui.refreshAll();
      }
    });
  }, [pendingJob, ui]);

  const useTake = async (takeId: string) => {
    setErr("");
    try {
      const updated = await api.useShotStill(p.id, shot.id, takeId);
      ui.mutateShot(shot.id, { still: updated.still, firstFrameId: updated.firstFrameId, kind: updated.kind });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const takes = still.takes ?? [];
  const good = takes.filter((t) => t.status === "ok" && t.imageFile);

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 12, border: "1px solid #2a3550" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <strong>Stage 1 · still</strong>
          <div className="muted small">
            {still.mode === "i2i" ? "Edit a reference image" : "Generate the picture from a prompt"} — then stage 2 animates it.
          </div>
        </div>
        <button className="primary small" onClick={renderStill} disabled={busy || !!ui.activeJob || !!ui.renderBlocked} title={ui.renderBlocked || "Render the still for this shot"}>
          {busy ? "Rendering…" : good.length ? "Render more stills" : "Render still"}
        </button>
      </div>

      <Field label="Still prompt" hint="Leave empty to reuse the shot's own prompt above.">
        <textarea rows={2} value={still.prompt} placeholder={shot.prompt || "Describe the picture…"}
          onChange={(e) => ui.mutateShot(shot.id, { still: { ...still, prompt: e.target.value } } as Partial<Shot>)}
          onBlur={(e) => patch({ prompt: e.target.value })} />
      </Field>

      {still.mode === "i2i" && (
        <MultiPicker title="Reference images to edit" kind="image" ids={still.imageIds} assets={imageAssets} max={STILL_REF_MAX}
          onToggle={(id) => patch({ imageIds: toggle(still.imageIds, id) })}
          onAttach={(ids) => patch({ imageIds: mergeRefs(still.imageIds, ids, STILL_REF_MAX) })} tagOf={(i) => `ref ${i + 1}`} />
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))" }}>
        <Field label="Canvas" hint={still.mode === "i2i" ? "In image-to-image the output follows the reference image's shape, so this is ignored." : undefined}>
          <select value={`${still.width}x${still.height}`} disabled={still.mode === "i2i"}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              patch({ width: w, height: h });
            }}>
            {!IMG_CANVAS.some((c) => c.w === still.width && c.h === still.height) && (
              <option value={`${still.width}x${still.height}`}>custom {still.width}x{still.height}</option>
            )}
            {IMG_CANVAS.map((c) => <option key={c.label} value={`${c.w}x${c.h}`}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Steps">
          <input type="number" min={1} max={100} value={still.steps}
            onChange={(e) => ui.mutateShot(shot.id, { still: { ...still, steps: Number(e.target.value) || 1 } } as Partial<Shot>)}
            onBlur={(e) => patch({ steps: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
        </Field>
        <Field label="CFG">
          <input type="number" min={0} max={20} step={0.5} value={still.cfg}
            onChange={(e) => ui.mutateShot(shot.id, { still: { ...still, cfg: Number(e.target.value) || 0 } } as Partial<Shot>)}
            onBlur={(e) => patch({ cfg: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Variants" hint="1–4 per run.">
          <input type="number" min={1} max={4} value={still.variants}
            onChange={(e) => ui.mutateShot(shot.id, { still: { ...still, variants: Number(e.target.value) || 1 } } as Partial<Shot>)}
            onBlur={(e) => patch({ variants: Math.max(1, Math.min(4, Number(e.target.value) || 1)) })} />
        </Field>
      </div>

      {good.length > 0 && (
        <Field label={`Still takes — click one to animate it (${good.length})`}>
          <div className="row wrap" style={{ gap: 8 }}>
            {good.map((t) => {
              const isSel = still.selectedTakeId === t.id;
              return (
                <button key={t.id} onClick={() => useTake(t.id)}
                  style={{ padding: 0, border: isSel ? "2px solid #4da3ff" : "1px solid #2a3550", borderRadius: 6, overflow: "hidden" }}
                  title={`Seed ${t.seed}${isSel ? " — currently the first frame" : ""}`}>
                  <img src={imageUrl(t.imageFile!)} alt="" style={{ width: 132, height: 74, objectFit: "cover", display: "block" }} />
                  {isSel && <div className="muted" style={{ fontSize: 10, padding: "2px 4px" }}>in use</div>}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      {shot.firstFrameId && (
        <div className="muted small">
          This shot’s first frame is set from the still. “Render this shot” runs both stages in order.
        </div>
      )}
      {err && <div className="err small">{err}</div>}
    </div>
  );
}

function ShotInspector({ shot }: { shot: Shot }) {
  const ui = useUi();
  const p = ui.project!;
  const up = (patch: Partial<Shot>) => ui.mutateShot(shot.id, patch);
  const lastError = [...shot.takes].reverse().find((t) => t.status === "error");
  const lastOk = [...shot.takes].reverse().find((t) => t.status === "ok");

  const [structuring, setStructuring] = useState(false);
  const [structErr, setStructErr] = useState("");
  // Pending restructure review: the LLM's proposed prompt is NOT written until the user hits Apply.
  const [review, setReview] = useState<{ proposed: string; source: string; model?: string } | null>(null);
  const doStructure = async () => {
    setStructErr("");
    setStructuring(true);
    try {
      const r = await api.structurePrompt(p.id, shot.prompt);
      if (r.unchanged) {
        ui.toast("Prompt already has the four-section structure");
      } else {
        const proposed = r.structured || r.raw || "";
        const providerLabel = PROVIDER_CARDS.find((c) => c.id === r.provider)?.label ?? r.provider;
        setReview({ proposed, source: providerLabel ?? "", model: r.model });
      }
    } catch (e) {
      setStructErr((e as Error).message);
    } finally {
      setStructuring(false);
    }
  };
  const applyReview = (proposed: string) => {
    setReview(null);
    up({ prompt: proposed });
    ui.toast(`Prompt restructured${review?.model ? ` with ${review.model}` : ""}`);
  };

  const kindOpts: Array<{ k: ShotKind; desc: string }> = [
    { k: "t2v", desc: "Pure text prompt" },
    { k: "i2v", desc: "Start from an image" },
    { k: "fl2v", desc: "Lock start AND end frame" },
    { k: "r2v", desc: "Character / scene / voice references" },
  ];

  const stillOpts: Array<{ m: StillMode; label: string; desc: string }> = [
    { m: "none", label: "No still", desc: "Go straight to video" },
    { m: "t2i", label: "Text → image", desc: "Qwen writes the picture" },
    { m: "i2i", label: "Image → image", desc: "Edit a reference image" },
  ];

  const stillMode: StillMode = shot.still?.mode ?? "none";

  /** Switching stage 1 on/off goes through the API so the server owns the shape. */
  const setStillMode = async (m: StillMode) => {
    try {
      const updated = await api.setShotStill(p.id, shot.id, m);
      ui.mutateShot(shot.id, { still: updated.still, kind: updated.kind, firstFrameId: updated.firstFrameId });
    } catch (e) {
      ui.toast(`Could not change the still stage: ${(e as Error).message}`, "err");
    }
  };

  const imageAssets = ui.assets.filter((a) => a.kind === "image");
  const audioAssets = ui.assets.filter((a) => a.kind === "audio");
  const videoAssets = ui.assets.filter((a) => a.kind === "video");

  const r2vTags = useMemo(() => {
    return [
      ...shot.imageIds.map((_, i) => ({ kind: "image" as const, n: i + 1 })),
      ...shot.videoIds.map((_, i) => ({ kind: "video" as const, n: i + 1 })),
      ...shot.audioIds.map((_, i) => ({ kind: "audio" as const, n: i + 1 })),
    ];
  }, [shot.imageIds, shot.videoIds, shot.audioIds]);

  // The engine prepends a continuity/start frame first when one is present, then the
  // character portrait, then the last frame, before the director's own references.
  // Keep the tag picker honest about the index H3 will actually see. The portrait is
  // identity-only; <Picture 1> is the visual anchor H3 builds frame 0 from.
  const identityRefOffset = shot.characterId
    ? 1 + ((shot.continueFromPrev || shot.firstFrameId) ? 1 : 0) + (shot.lastFrameId ? 1 : 0)
    : 0;

  return (
    <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Field label="Shot name">
          <input value={shot.name} onChange={(e) => up({ name: e.target.value })} />
        </Field>
        <button className="primary small" disabled={!!ui.activeJob || !!ui.renderBlocked} title={ui.renderBlocked || "Render this shot"} onClick={() => ui.renderShots([shot.id])}>▶ Render this shot</button>
      </div>

      {/* ---- the pipeline: stage 1 (picture) then stage 2 (motion) ---- */}
      <Field label="Stage 1 — make the picture" hint="Qwen Image 2.1. Leave it off for pure text-to-video, or let the shot generate its own first frame.">
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          {stillOpts.map((o) => (
            <button key={o.m} className={stillMode === o.m ? "primary" : ""} title={o.desc}
              style={{ textAlign: "left" }} onClick={() => setStillMode(o.m)}>
              <div style={{ fontSize: 13 }}>{o.label}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{o.desc}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Stage 2 — animate it" hint={stillMode !== "none" ? "This shot's video will be driven by the still from stage 1." : undefined}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
          {kindOpts.map((o) => (
            <button key={o.k} className={shot.kind === o.k ? "primary" : ""} title={o.desc} style={{ textAlign: "left" }}
              onClick={() => up({ kind: o.k, ...(o.k === "i2v" || o.k === "fl2v" ? { audioIds: [], imageIds: [], videoIds: [] } : {}) })}>
              <div style={{ fontSize: 13 }}>{KIND_LABEL[o.k]}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{o.desc}</div>
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Source character — identity lock"
        hint="Attach one clear portrait. It is sent to every video as an identity-only reference: <Picture 2> behind the seam/start frame when continuity is on (otherwise <Picture 1>), and as a reference on every still. The seam stays <Picture 1> and is written back as the exact first frame, so the next shot never jumps to the portrait. Attaching it switches stage 2 to Reference Video: H3's image mode only has room for first/last frames."
      >
        <div className="row" style={{ gap: 8 }}>
          <select
            className="grow"
            value={shot.characterId ?? ""}
            onChange={(e) => {
              const id = e.target.value || null;
              void api.setShotCharacter(p.id, shot.id, id).then((updated) => {
                ui.mutateShot(shot.id, { characterId: updated.characterId, kind: updated.kind });
                ui.toast(id ? "Source character locked to this shot" : "Character lock removed");
                void ui.refreshAll();
              }).catch((e: unknown) => ui.toast((e as Error).message, "err"));
            }}
          >
            <option value="">None — no identity lock</option>
            {[...imageAssets]
              .sort((a, b) => Number(b.role === "character") - Number(a.role === "character"))
              .map((a) => (
                <option key={a.id} value={a.id}>{a.role === "character" ? "★ " : ""}{a.name}</option>
              ))}
          </select>
          {shot.characterId && (
            <button
              className="small"
              title="Use this character on every shot and still board in the project"
              onClick={() => {
                void api.setProjectCharacter(p.id, shot.characterId ?? null, true).then((r) => {
                  void ui.refreshAll();
                  ui.toast(`Identity locked on ${r.touched.length} shot(s)`);
                }).catch((e: unknown) => ui.toast((e as Error).message, "err"));
              }}
            >
              Apply to all
            </button>
          )}
        </div>
        {shot.characterId && shot.kind !== "r2v" && (
          <div className="err small" style={{ marginTop: 4 }}>
            This older shot is still in image mode. Re-select the character above to move it to reference mode; until then H3 cannot see the identity image.
          </div>
        )}
      </Field>

      {/* the still stage itself, only when enabled */}
      {stillMode !== "none" && (
        <StillStage shot={shot} imageAssets={imageAssets} />
      )}

      {/* keyframe mode media */}
      {(shot.kind === "i2v" || shot.kind === "fl2v") && (
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <KeyframePicker title="First frame" assetId={shot.firstFrameId} assets={imageAssets}
            onChange={(id) => up({ firstFrameId: id, ...(id ? { continueFromPrev: false } : {}) })}
            hint={shot.continueFromPrev ? "Chained from previous shot (automatic)" : ""} />
          {shot.kind === "fl2v" && (
            <KeyframePicker title="Last frame" assetId={shot.lastFrameId} assets={imageAssets}
              onChange={(id) => up({ lastFrameId: id })} />
          )}
        </div>
      )}

      {/* chaining — also valid in reference mode: the seam frame becomes <Picture 1> and is conformed as frame 0 */}
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={shot.continueFromPrev} onChange={(e) => up({ continueFromPrev: e.target.checked, ...(e.target.checked ? { firstFrameId: null } : {}) })} />
        <label style={{ margin: 0, textTransform: "none" }}>
          Continue from previous shot’s final frame (seamless){shot.kind === "r2v" ? " — attached as a reference image" : ""}
        </label>
      </div>
      {shot.continueFromPrev && shot.characterId && (
        <div className="muted small">
          The seam's location and camera are locked for the whole shot. Remove "camera follows", "zoom" or "cut" from the prompt, or H3 may generate a new scene.
        </div>
      )}

      {/* reference media for r2v */}
      {shot.kind === "r2v" && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
            <MultiPicker title="Other reference images (location / style / prop)" kind="image" ids={shot.imageIds} assets={imageAssets} max={REF_IMAGE_MAX}
              onToggle={(id) => up({ imageIds: toggle(shot.imageIds, id) })}
              onAttach={(ids) => up({ imageIds: mergeRefs(shot.imageIds, ids, REF_IMAGE_MAX) })} tagOf={(i) => `<Picture ${identityRefOffset + i + 1}>`} />
            <MultiPicker title="Reference videos (motion / edit)" kind="video" ids={shot.videoIds} assets={videoAssets} max={REF_VIDEO_MAX}
              onToggle={(id) => up({ videoIds: toggle(shot.videoIds, id) })}
              onAttach={(ids) => up({ videoIds: mergeRefs(shot.videoIds, ids, REF_VIDEO_MAX) })} tagOf={(i) => `<Video ${i + 1}>`} />
            <MultiPicker title="Voice / audio references (dialogue voice)" kind="audio" ids={shot.audioIds} assets={audioAssets} max={REF_AUDIO_MAX}
              onToggle={(id) => up({ audioIds: toggle(shot.audioIds, id) })}
              onAttach={(ids) => up({ audioIds: mergeRefs(shot.audioIds, ids, REF_AUDIO_MAX) })} tagOf={(i) => `<Audio ${i + 1}>`} />
          </div>
          {shot.audioIds.length > 0 && <div className="muted small">Voice clips are automatically linked to dialogue: “All speech is in the voice of the person in &lt;Audio N&gt;.”</div>}
          {r2vTags.length > 0 && (
            <Field label="Insert reference tags into the prompt">
              <div className="row" style={{ flexWrap: "wrap" }}>
                {r2vTags.map((t) => {
                  const tag = t.kind === "image" ? `<Picture ${t.n + identityRefOffset}>` : t.kind === "video" ? `<Video ${t.n}>` : `<Audio ${t.n}>`;
                  return (
                    <button key={tag} className="small chip kind" style={{ cursor: "pointer" }}
                      onClick={() => up({ prompt: `${shot.prompt} ${tag}`.trim() })}>
                      + {tag}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </>
      )}

      {/* prompt */}
      <div>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 5, flexWrap: "wrap", rowGap: 4 }}>
          <label style={{ margin: 0, flex: "1 1 220px" }}>Prompt — what happens in this shot (H3 makes the picture AND sound)</label>
          <button
            className="small"
            disabled={structuring || !shot.prompt.trim()}
            onClick={() => void doStructure()}
            title="Restructure this prompt into four sections — [Subject + Action] / [Camera Movement] / [Environment & FX] / [Style & Technical] — using the AI co-director model"
          >
            {structuring ? "Structuring…" : "⧉ Structure prompt"}
          </button>
        </div>
        <textarea rows={7} value={shot.prompt} placeholder="e.g. Medium shot. Maria looks up from the table and says: “We should never have opened that door.” Slow dolly-in, rain against the window…"
          onChange={(e) => up({ prompt: e.target.value })} style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }} />
        {structErr && <div className="err small" style={{ marginTop: 4 }}>{structErr}</div>}
        {lastOk?.meta?.compiledPrompt && (
          <details>
            <summary className="muted small" style={{ cursor: "pointer" }}>Compiled prompt of last take (what was actually sent to H3)</summary>
            <pre className="monoline" style={{ marginTop: 6 }}>{lastOk.meta.compiledPrompt}</pre>
          </details>
        )}
      </div>

      {/* timing + picture */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))" }}>
        <Field label={`Duration ${shot.seconds.toFixed(1)}s`}>
          <input type="range" min={1} max={12} step={0.5} value={shot.seconds} onChange={(e) => up({ seconds: Number(e.target.value) })} />
        </Field>
        <Field label="FPS">
          <select value={shot.fps} onChange={(e) => up({ fps: Number(e.target.value) })}>
            {[24, 30].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
        <Field label="Resolution">
          <select value={shot.resolution} onChange={(e) => up({ resolution: e.target.value })}>
            {RESOLUTIONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Aspect">
          <select value={shot.aspect} onChange={(e) => up({ aspect: e.target.value })}>
            {ASPECTS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Field>
        {shot.resolution === "custom" && (
          <>
            <Field label="Width">
              <input type="number" value={shot.width} onChange={(e) => up({ width: Number(e.target.value) })} />
            </Field>
            <Field label="Height">
              <input type="number" value={shot.height} onChange={(e) => up({ height: Number(e.target.value) })} />
            </Field>
          </>
        )}
        {shot.kind === "r2v" && (
          <Field label="Ref image size">
            <select value={shot.refImageSize} onChange={(e) => up({ refImageSize: e.target.value })}>
              {REF_IMAGE_SIZES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
        )}
      </div>

      {/* sampling */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(170px,1fr))" }}>
        <Field label={`Steps: ${shot.steps}`}>
          <input type="range" min={4} max={40} step={1} value={shot.steps} onChange={(e) => up({ steps: Number(e.target.value) })} />
        </Field>
        <Field label="Sampler">
          <select value={shot.sampler} onChange={(e) => up({ sampler: e.target.value })}>
            {SAMPLERS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Scheduler">
          <select value={shot.scheduler} onChange={(e) => up({ scheduler: e.target.value })}>
            {SCHEDULERS.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Seed">
          <div className="row" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <select value={shot.seedMode} onChange={(e) => up({ seedMode: e.target.value as "random" | "fixed" })} style={{ width: 104, flex: "0 0 auto" }}>
              <option value="random">random</option>
              <option value="fixed">fixed</option>
            </select>
            <input type="number" value={shot.seed} disabled={shot.seedMode === "random"}
              onChange={(e) => up({ seed: Number(e.target.value) })} style={{ flex: "1 1 150px", minWidth: 120 }} />
          </div>
        </Field>
        <Field label="Realism LoRA strength (0 = off)">
          <input type="range" min={0} max={1.2} step={0.05} value={shot.loraStrength} onChange={(e) => up({ loraStrength: Number(e.target.value) })} />
        </Field>
        <Field label="Spectrum accelerator">
          <select value={shot.spectrum ? "on" : "off"} onChange={(e) => up({ spectrum: e.target.value === "on" })}>
            <option value="off">off (full quality)</option>
            <option value="on">on (faster)</option>
          </select>
        </Field>
        <Field label="Sigma shift video (blank = default)">
          <input type="number" step={0.1} value={shot.sigmaShiftVideo ?? ""}
            placeholder="off"
            onChange={(e) => up({ sigmaShiftVideo: e.target.value === "" ? null : Number(e.target.value) })} />
        </Field>
      </div>

      <Field label="Notes">
        <input value={shot.notes ?? ""} placeholder="Direction notes for yourself or the AI co-director…" onChange={(e) => up({ notes: e.target.value })} />
      </Field>

      {lastError && <div className="err small">Last render error: {lastError.error}</div>}

      {review && (
        <StructReview
          review={review}
          original={shot.prompt}
          onApply={(t) => applyReview(t)}
          onDiscard={() => setReview(null)}
        />
      )}
    </div>
  );
}

/** Modal shown after a structure call: the LLM's proposed prompt is displayed
 *  (and editable) and only written to the shot when the user hits Apply. */
function StructReview({ review, original, onApply, onDiscard }: {
  review: { proposed: string; source: string; model?: string };
  original: string;
  onApply: (t: string) => void;
  onDiscard: () => void;
}) {
  const [text, setText] = useState(review.proposed);
  return (
    <div className="modal-back" onClick={onDiscard}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(760px, 94vw)" }}>
        <div className="row" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", alignItems: "center" }}>
          <b>⧉ Restructured prompt — review before applying</b>
          <div className="grow" />
          {review.model && <span className="muted small">{review.source}{review.source ? " · " : ""}{review.model}</span>}
          <button className="small ghost" onClick={onDiscard} title="Discard this restructure">✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ marginBottom: 0 }}>Original prompt — untouched until you hit Apply</label>
            <textarea rows={4} readOnly value={original}
              style={{ width: "100%", background: "var(--bg)", opacity: 0.75, resize: "vertical", fontFamily: "inherit", marginTop: 5 }} />
          </div>
          <div>
            <label style={{ marginBottom: 0 }}>New prompt — the model&apos;s full response, editable</label>
            <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)}
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit", marginTop: 5 }} />
          </div>
        </div>
        <div className="row" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", justifyContent: "flex-end", gap: 8 }}>
          <button className="small" onClick={onDiscard}>Discard</button>
          <button className="small primary" onClick={() => onApply(text.trim() ? text : review.proposed)}>Apply to prompt</button>
        </div>
      </div>
    </div>
  );
}

function providerLabel(id?: string): string {
  if (!id) return "";
  return PROVIDER_CARDS.find((c) => c.id === id)?.label ?? id;
}

interface SADraftSlot {
  /** The text exactly as the model returned it (fallback if the field is cleared). */
  orig: string;
  /** Editable copy shown in the textarea — this is what gets applied. */
  current: string;
  /** Set when this round failed. */
  error?: string;
}

interface SARow {
  shotId: string;
  name: string;
  index: number;
  status: "queued" | "ok" | "unchanged" | "error";
  /** Draft slots in round order: 1 in single mode, 2 in A/B mode. */
  slots: SADraftSlot[];
  /** Index of the chosen "best" draft (A/B mode). */
  pick: number;
  apply: boolean;
}

/** Session-sticky preference so the setup screen remembers your last choice. */
let lastStructDouble = false;

/** Runs the four-section restructure across the prompt-bearing shots inside the
 *  timeline window [start, end) — globally numbered, so a right-click scoped pass
 *  on shot 3 shows 3., 4., 5. like the Script list does. Sequentially streaming,
 *  then lets the user review each result — edit, uncheck, Apply or Discard.
 *  Nothing is written until Apply. Optionally (rounds = 2) every shot is run twice
 *  so each one shows two alternative drafts; pick the better of A/B per shot. */
function StructureAllModal({ onClose, start, end }: { onClose: () => void; start: number; end: number }) {
  const ui = useUi();
  const project = ui.project!;
  const windowShots = project.shots.slice(start, end);
  const candidateIds = windowShots.map((s) => s.id);
  const candidates = windowShots
    .map((s, i) => ({ s, idx: start + i }))
    .filter(({ s }) => s.prompt.trim().length > 0);
  const [double, setDouble] = useState<boolean>(lastStructDouble);
  const rounds: 1 | 2 = double ? 2 : 1;
  const [phase, setPhase] = useState<"setup" | "run" | "done">("setup");
  const [rows, setRows] = useState<SARow[]>(() => makeSARows(candidates));
  const [done, setDone] = useState<StructureAllDone | null>(null);
  const [fatal, setFatal] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const runIdRef = useRef("");
  const finishedRef = useRef(false);

  const running = phase === "run";
  const rowDone = (r: SARow) => r.status === "unchanged" || r.slots.length >= rounds;
  const doneCount = rows.filter(rowDone).length;
  const inflight = rows.find((r) => !rowDone(r));
  const applyCount = rows.filter((r) => r.status === "ok" && r.apply).length;
  const model = ui.settings?.director?.model;

  useEffect(() => {
    if (phase !== "run") return;
    const ac = new AbortController();
    finishedRef.current = false;
    (async () => {
      try {
        const d = await api.streamStructureAll(
          project.id,
          (ev) => {
            setRows((prev) => {
              const at = prev.findIndex((r) => r.shotId === ev.shotId);
              const base: SARow =
                at >= 0
                  ? prev[at]
                  : { shotId: ev.shotId, name: ev.name, index: ev.index, status: "queued", slots: [], pick: 0, apply: true };
              const slotIdx = ev.round ?? 0;
              const slots = [...base.slots];
              while (slots.length <= slotIdx) slots.push({ orig: "", current: "" });
              if (ev.unchanged) {
                // no drafts — the server skips shots already in four-section form
              } else if (ev.error) {
                slots[slotIdx] = { ...slots[slotIdx], error: ev.error };
              } else {
                const text = ev.structured ?? "";
                slots[slotIdx] = { orig: text, current: text, error: undefined };
              }
              const anyOk = slots.some((s) => s.current.trim().length > 0 && !s.error);
              const status: SARow["status"] = ev.unchanged ? "unchanged" : anyOk ? "ok" : "error";
              // Never leave the pick on a failed / empty slot.
              let pick = base.pick;
              const firstGood = slots.findIndex((s) => s.current.trim().length > 0 && !s.error);
              if (firstGood >= 0 && (slots[pick]?.error || !slots[pick]?.current.trim())) pick = firstGood;
              const row: SARow = { ...base, slots, status, pick, apply: status === "ok" };
              const next = at >= 0 ? prev.map((r, k) => (k === at ? row : r)) : [...prev, row];
              return [...next].sort((a, b) => a.index - b.index);
            });
          },
          ac.signal,
          rounds,
          runIdRef.current,
          candidateIds,
        );
        setDone(d);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setFatal(e instanceof Error ? e.message : String(e));
        }
      } finally {
        finishedRef.current = true;
        setPhase("done");
      }
    })();
    return () => {
      ac.abort();
      // If the modal unmounts mid-run (e.g. project switched), tell the server to stop
      // issuing further LLM calls after the one in flight — never strand the run.
      if (!finishedRef.current) {
        void api.cancelStructureAll(project.id, runIdRef.current).catch(() => {});
      }
    };
  }, [project.id, phase, rounds, start, end]);

  const makeRunId = () =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const startRun = () => {
    lastStructDouble = double;
    runIdRef.current = makeRunId();
    setRows(makeSARows(candidates));
    setDone(null);
    setFatal("");
    setCancelling(false);
    setPhase("run");
  };

  /** Ask the backend to stop issuing further LLM calls; the current one finishes,
   *  then the server ends the stream (cancelled:true) with the drafts gathered so far. */
  const cancelRun = async () => {
    setCancelling(true);
    try {
      await api.cancelStructureAll(project.id, runIdRef.current);
    } catch (e) {
      ui.toast(`Could not cancel: ${(e as Error).message}`, "err");
      setCancelling(false);
    }
  };

  const toggleApply = (i: number) => setRows((prev) => prev.map((r, k) => (k === i ? { ...r, apply: !r.apply } : r)));
  const setDraftText = (i: number, slot: number, t: string) =>
    setRows((prev) => prev.map((r, k) => (k === i ? { ...r, slots: r.slots.map((s, j) => (j === slot ? { ...s, current: t } : s)) } : r)));
  const pickDraft = (i: number, slot: number) => setRows((prev) => prev.map((r, k) => (k === i ? { ...r, pick: slot } : r)));
  const onApply = () => {
    const sel = rows.filter((r) => r.status === "ok" && r.apply);
    const p0 = ui.project;
    if (!sel.length || !p0) return;
    // Apply ALL chosen prompts in a single atomic save — per-row mutateShot calls
    // would each patch the same stale project snapshot and overwrite each other.
    const prompts = new Map<string, string>();
    for (const r of sel) {
      const slot =
        r.slots[r.pick] && r.slots[r.pick].current.trim().length > 0
          ? r.slots[r.pick]
          : r.slots.find((s) => s.current.trim().length > 0);
      prompts.set(r.shotId, slot ? slot.current.trim() || slot.orig : "");
    }
    ui.saveProject({
      ...p0,
      shots: p0.shots.map((s) => (prompts.has(s.id) ? { ...s, prompt: prompts.get(s.id)! } : s)),
    });
    ui.toast(`Restructured ${sel.length} prompt${sel.length === 1 ? "" : "s"}${done?.model ? ` with ${done.model}` : ""}`);
    onClose();
  };

  const headerStatus = () => {
    if (phase === "setup") return `${candidates.length} shot${candidates.length === 1 ? "" : "s"} with a prompt`;
    if (running) {
      if (cancelling) return "Stopping after current draft…";
      if (!rows.length) return "Starting…";
      if (doneCount < rows.length) {
        const draftBit = rounds === 2 && inflight ? ` · draft ${Math.min(inflight.slots.length + 1, 2)} of 2` : "";
        return `Structuring shot ${doneCount + 1} of ${rows.length}${draftBit}`;
      }
      return "Finalizing…";
    }
    return done?.cancelled ? "Stopped" : fatal ? "Failed" : "Done";
  };

  return (
    <div className="modal-back" onClick={() => { if (!running) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(880px, 96vw)" }}>
        <div className="row" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", alignItems: "center" }}>
          <b>⧉ Structure all shots</b>
          <div className="grow" />
          <span className="muted small">
            {headerStatus()}
            {model ? ` · ${providerLabel(ui.settings?.director?.provider)} ${model}` : ""}
          </span>
          <button className="small ghost" onClick={onClose} disabled={running}
            title={running ? "The run is using the model — press ■ Cancel run to stop after the current draft" : "Discard all changes"}>
            {running ? "…" : "✕"}
          </button>
        </div>

        {phase === "setup" ? (
          <>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="card" style={{ padding: "10px 12px" }}>
                <div className="small">
                  Rewrite <b>{candidates.length} shot prompt{candidates.length === 1 ? "" : "s"}</b> into the four H3
                  sections ({`[Subject + Action]`} / {`[Camera Movement]`} / {`[Environment & FX]`} / {`[Style & Technical]`})
                  with {providerLabel(ui.settings?.director?.provider) || "the configured model"}{model ? ` · ${model}` : ""}.
                  Nothing is saved until you review each result.
                </div>
                {candidates.length > 0 && (
                  <div className="row small muted" style={{ flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {candidates.slice(0, 8).map(({ s, idx }) => (
                      <span key={s.id} className="chip">{idx + 1}. {s.name || "Untitled"}</span>
                    ))}
                    {candidates.length > 8 && <span className="chip">+{candidates.length - 8} more</span>}
                  </div>
                )}
              </div>
              <label className="row" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={double} onChange={(e) => setDouble(e.target.checked)} />
                <span>
                  Generate <b>two alternative drafts (A/B)</b> per shot and let me pick the best — roughly twice the
                  time &amp; tokens.
                </span>
              </label>
              <div className="muted small">
                Draft A is a faithful rewrite; Draft B is an alternative wording of the same facts, so you can compare
                the two before applying. Shots already in the four-section format are skipped either way.
              </div>
              {fatal && <div className="err small">{fatal}</div>}
            </div>
            <div className="row" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
              <span className="muted small grow">{double ? `≈ ${candidates.length * 2} model calls` : ""}</span>
              <button className="small" onClick={onClose}>Cancel</button>
              <button className="small primary" disabled={candidates.length === 0 || !model} onClick={startRun}
                title={model ? "" : "No model chosen yet — open ⚙ Settings → Provider routing first."}>
                ⧉ Structure {candidates.length} prompt{candidates.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {done &&
                (done.cancelled ? (
                  <div className="small">
                    <span className="err">⏹ Stopped by you</span>{" "}
                    <span className="muted">
                      {done.changed} restructured · {done.skipped} already structured · {done.failed} failed — shots
                      you hadn&apos;t started were skipped and no further model calls were made. Drafts already shown
                      below are ready to review and apply.
                    </span>
                  </div>
                ) : (
                  <div className="small muted">
                    {done.rounds === 2
                      ? `${done.changed} restructured with 2 drafts each · ${done.skipped} already structured · ${done.failed} failed`
                      : `${done.changed} restructured · ${done.skipped} already structured · ${done.failed} failed`}
                  </div>
                ))}
              {fatal && <div className="err small">{fatal}</div>}
              {!rows.length && !fatal && <div className="muted small">No shots with a prompt to structure.</div>}
              {rows.map((r, i) => (
                <div key={r.shotId} className="card" style={{ padding: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center" }}>
                    {r.status === "ok" ? (
                      <span className="ok" title="restructured">✓</span>
                    ) : r.status === "error" ? (
                      <span className="err" title="failed">✗</span>
                    ) : r.status === "unchanged" ? (
                      <span className="muted" title="already structured">–</span>
                    ) : (
                      <span className="muted" title="waiting">…</span>
                    )}
                    <b style={{ fontSize: 12 }}>{r.index + 1}. {r.name || "Untitled"}</b>
                    <div className="grow" />
                    {r.status === "ok" && (
                      <label className="small muted" style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input type="checkbox" checked={r.apply} onChange={() => toggleApply(i)} disabled={running} /> include
                      </label>
                    )}
                    {r.status === "unchanged" && <span className="muted small">already structured — skipped</span>}
                    {r.status === "queued" && (
                      <span className="muted small">{running ? "waiting…" : done?.cancelled ? "not run — stopped" : "queued"}</span>
                    )}
                    {r.status === "error" && <span className="err small">failed</span>}
                  </div>
                  {r.status === "ok" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                      {Array.from({ length: rounds }, (_, slot) => {
                        const s = r.slots[slot];
                        if (!s) {
                          return <div key={slot} className="muted small">Draft {slot + 1} {running ? "being written…" : "not generated"}</div>;
                        }
                        if (s.error) {
                          return <div key={slot} className="err small">Draft {slot + 1}: {s.error}</div>;
                        }
                        return (
                          <div key={slot}>
                            <div className="row small" style={{ gap: 8, alignItems: "center", marginBottom: 4 }}>
                              {rounds === 2 && (
                                <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", margin: 0 }}>
                                  <input type="radio" name={`sa-pick-${r.shotId}`} checked={r.pick === slot}
                                    onChange={() => pickDraft(i, slot)} disabled={running} />
                                  <b>{slot === 0 ? "Draft A" : "Draft B"}</b>
                                </label>
                              )}
                              {rounds === 2 && r.pick === slot && <span className="ok small">← this one</span>}
                              <div className="grow" />
                              <span className="muted small">
                                {rounds === 2
                                  ? slot === 0 ? "faithful rewrite" : "alternative wording"
                                  : "editable before applying"}
                              </span>
                            </div>
                            <textarea rows={4} value={s.current} onChange={(e) => setDraftText(i, slot, e.target.value)}
                              style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {r.status === "error" && r.slots.length > 0 && (
                    <div className="err small" style={{ marginTop: 4 }}>
                      {r.slots.map((s) => s.error).filter((x): x is string => !!x).join(" ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="row" style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
              <span className="muted small grow">
                {running
                  ? cancelling
                    ? "Finishing the current LLM call, then stopping — no further calls will be made…"
                    : "Nothing is saved until you hit Apply."
                  : "Nothing is saved until you hit Apply."}
              </span>
              {running ? (
                <button className="small danger" onClick={() => void cancelRun()} disabled={cancelling}
                  title="Stops after the LLM call currently running — shots not yet started are skipped.">
                  {cancelling ? "Stopping…" : "■ Cancel run"}
                </button>
              ) : (
                <>
                  <button className="small" onClick={onClose}>Discard</button>
                  <button className="small primary" disabled={applyCount === 0} onClick={onApply}>
                    Apply {applyCount} {applyCount === 1 ? "prompt" : "prompts"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function makeSARows(candidates: Array<{ s: Shot; idx: number }>): SARow[] {
  return candidates.map(({ s, idx }) => ({ shotId: s.id, name: s.name, index: idx, status: "queued", slots: [], pick: 0, apply: true }));
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function KeyframePicker({ title, assetId, assets, onChange, hint }: { title: string; assetId: string | null; assets: LibraryAsset[]; onChange: (id: string | null) => void; hint?: string }) {
  const asset = assetId ? assets.find((a) => a.id === assetId) : undefined;
  return (
    <Field label={title}>
      <select value={assetId ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">— none —</option>
        {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {hint && <div className="muted small">{hint}</div>}
      {asset && (
        <div style={{ marginTop: 4 }}>
          {asset.kind === "audio" ? (
            <div className="muted small">🎙 audio reference — no preview</div>
          ) : (
            <MediaThumb kind={asset.kind} src={assetUrl(asset)} name={asset.name} className="mp-thumb" />
          )}
        </div>
      )}
    </Field>
  );
}

function MultiPicker({ title, kind, ids, assets, onToggle, onAttach, max, tagOf }: {
  title: string;
  kind: LibraryAsset["kind"];
  ids: string[];
  assets: LibraryAsset[];
  /** Toggle a reference off (the ✕ on an attached row). */
  onToggle: (id: string) => void;
  /** Add new references: either an option picked in the dropdown, or files just uploaded. */
  onAttach: (ids: string[]) => void;
  /** Cap for this slot; the label and the button both honour it. */
  max: number;
  tagOf: (index: number) => string;
}) {
  const ui = useUi();
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const opts = assets.filter((a) => !ids.includes(a.id));
  // Keep a row even when the asset is gone, so a deleted-then-attached id stays
  // visible and removable instead of silently vanishing from the list.
  const used = ids.map((id) => ({ id, a: assets.find((x) => x.id === id) }));
  const full = used.length >= max;
  const accept = kind === "image" ? "image/*" : kind === "video" ? "video/*" : "audio/*";

  /** The + button: attach the dropdown pick if there is one, otherwise choose files. */
  const add = async () => {
    if (busy || full) return;
    if (pending) {
      onAttach([pending]);
      setPending("");
      return;
    }
    fileRef.current?.click();
  };

  /** Upload freshly chosen files, then attach them in a single call so a multi-file
   *  selection isn't merged through repeated onToggle calls over a stale list. */
  const takeFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    const room = max - used.length;
    const files = Array.from(list);
    if (files.length > room) {
      ui.toast(`"${title}" holds ${max} — only the first ${room} will be attached.`, "err");
    }
    setBusy(true);
    try {
      const added: string[] = [];
      for (const f of files.slice(0, room)) {
        try {
          const a = await api.uploadAsset(f);
          added.push(a.id);
        } catch (e) {
          ui.toast(`Upload of ${f.name} failed: ${(e as Error).message}`, "err");
        }
      }
      if (added.length) {
        await ui.refreshAll();
        onAttach(added);
        ui.toast(`Added ${added.length} ${kind}${added.length === 1 ? "" : "s"}`);
      }
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="panel" style={{ background: "var(--bg)", padding: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <label style={{ margin: 0 }}>{title}</label>
        <span className="muted small">{used.length} / {max}</span>
      </div>
      {used.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "6px 0" }}>
          {used.map(({ id, a }, i) => (
            <div key={id} className="mp-item">
              {a && a.kind !== "audio" ? (
                <MediaThumb className="mp-thumb" kind={a.kind} src={assetUrl(a)} name={a.name} />
              ) : (
                <div className="mp-thumb">
                  {!a ? <span className="muted" style={{ fontSize: 10 }}>?</span> : <span style={{ fontSize: 22 }}>🎙</span>}
                </div>
              )}
              <span className="muted monoline" style={{ marginRight: 6 }}>{tagOf(i)}</span>
              <span className="grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a ? a.name : "missing asset"}</span>
              <button className="small ghost" title={a ? `Remove ${a.name}` : "Remove missing reference"} onClick={() => onToggle(id)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <select className="grow" value={pending} disabled={full}
          onChange={(e) => setPending(e.target.value)}>
          <option value="">{full ? `— ${max} attached (remove one first) —` : `— add ${kind} from Library —`}</option>
          {opts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button
          className="small"
          disabled={busy || full}
          title={full
            ? `This slot is full (${max}/${max}) — remove one to add another`
            : pending
              ? `Attach "${assets.find((a) => a.id === pending)?.name ?? ""}" to this shot`
              : `Choose ${kind} file(s) from your computer to add as reference (${used.length}/${max} attached)`}
          onClick={() => void add()}
        >
          {busy ? "…" : "＋"}
        </button>
        <input ref={fileRef} type="file" accept={accept} multiple hidden
          onChange={(e) => { void takeFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {pending && opts.filter((a) => a.id === pending).map((a) => (
        <div key={a.id} className="row" style={{ marginTop: 6, gap: 8 }}>
          {a.kind === "audio" ? (
            <div className="mp-thumb"><span style={{ fontSize: 22 }}>🎙</span></div>
          ) : (
            <MediaThumb className="mp-thumb" kind={a.kind} src={assetUrl(a)} name={a.name} />
          )}
          <span className="muted small grow">About to attach: {a.name}</span>
        </div>
      ))}
      {ids.length === 0 && <div className="muted small" style={{ marginTop: 6 }}>None attached. Press ＋ to pick from the Library or choose a file.</div>}
    </div>
  );
}

// ----------------------------------------------------------------------
// Library
// ----------------------------------------------------------------------

export function LibraryView() {
  const ui = useUi();
  const uploadFiles = useUploadFiles();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, overflow: "hidden", minHeight: 0 }}>
      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <label style={{ margin: 0 }}>Library — one asset can be a character, a location, a prop, a voice…</label>
        {ui.project && (
          <Field label="Project character" hint="Inherited by new shots and still boards. Set a role of “character” to sort it to the top.">
            <div className="row" style={{ gap: 6 }}>
              <select
                className="grow"
                value={ui.project.defaultCharacterId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  void api.setProjectCharacter(ui.project!.id, id, false).then(() => {
                    void ui.refreshAll();
                    ui.toast(id ? "Project character set" : "Project character cleared");
                  }).catch((err: unknown) => ui.toast((err as Error).message, "err"));
                }}
              >
                <option value="">None</option>
                {ui.assets.filter((a) => a.kind === "image")
                  .sort((a, b) => Number(b.role === "character") - Number(a.role === "character"))
                  .map((a) => <option key={a.id} value={a.id}>{a.role === "character" ? "★ " : ""}{a.name}</option>)}
              </select>
              <button
                className="small"
                title="Bind this character to every existing shot and still board"
                disabled={!ui.project.defaultCharacterId}
                onClick={() => {
                  void api.setProjectCharacter(ui.project!.id, ui.project!.defaultCharacterId ?? null, true).then((r) => {
                    void ui.refreshAll();
                    ui.toast(`Identity locked on ${r.touched.length} shot(s)`);
                  }).catch((err: unknown) => ui.toast((err as Error).message, "err"));
                }}
              >
                Apply to all
              </button>
            </div>
          </Field>
        )}
        <div className="grow" />
        <Field label="Import from a server path">
          <ServerPathImport />
        </Field>
        <DropZone onFiles={uploadFiles} />
      </div>
      {ui.assets.length === 0 ? (
        <div className="empty">Drop in character sheets, location stills, motion clips and voice recordings.</div>
      ) : (
        <div className="list-scroll" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10, alignContent: "start" }}>
          {ui.assets.map((a) => (
            <AssetCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerPathImport() {
  const ui = useUi();
  const [path, setPath] = useState("");
  return (
    <div className="row">
      <input placeholder="C:\\path\\to\\file.png" value={path} onChange={(e) => setPath(e.target.value)} style={{ width: 260 }} />
      <button className="small" disabled={!path} onClick={async () => {
        try {
          await api.importAsset(path);
          ui.toast("Imported");
          setPath("");
          void ui.refreshAll();
        } catch (e) {
          ui.toast((e as Error).message, "err");
        }
      }}>Import</button>
    </div>
  );
}

function AssetCard({ a }: { a: LibraryAsset }) {
  const ui = useUi();
  return (
    <div className="asset-card">
      <div className="media">
        {a.kind === "image" && <MediaThumb className="media" kind="image" src={assetUrl(a)} name={a.name} />}
        {a.kind === "video" && <MediaThumb className="media" kind="video" src={assetUrl(a)} name={a.name} />}
        {a.kind === "audio" && (
          <div style={{ padding: 12, textAlign: "center", color: "var(--muted)", fontSize: 30 }}>🎙</div>
        )}
      </div>
      <div className="body">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="chip kind">{a.kind}</span>
          <button className="small ghost" onClick={() => { if (confirm(`Remove “${a.name}”?`)) api.deleteAsset(a.id).then(() => ui.refreshAll()); }}>✕</button>
        </div>
        <div className="name" title={a.name}>{a.name}</div>
        <div className="row" style={{ marginTop: 6 }}>
          <select value={a.role ?? ""} className="grow" style={{ fontSize: 12, padding: "4px 6px" }}
            onChange={(e) => api.patchAsset(a.id, { role: e.target.value }).then(() => ui.refreshAll()).catch(() => {})}>
            <option value="">no role</option>
            <option value="character">character</option>
            <option value="voice">voice</option>
            <option value="location">location</option>
            <option value="style">style</option>
            <option value="motion">motion</option>
            <option value="prop">prop</option>
          </select>
        </div>
        {a.kind === "audio" && <audio src={assetUrl(a)} controls style={{ width: "100%", marginTop: 4, height: 28 }} />}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Gallery
// ----------------------------------------------------------------------

export function GalleryView() {
  const ui = useUi();
  const p = ui.project;
  if (!p) return null;
  return (
    <div className="list-scroll" style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
      <div className="row">
        <b>Gallery — review takes, accept your favourites</b>
        <div className="grow" />
        <button className="small" disabled={!!ui.activeJob || !!ui.renderBlocked} title={ui.renderBlocked || "Render every shot"} onClick={() => ui.renderShots(p.shots.map((s) => s.id))}>Render all</button>
        <button className="small primary" disabled={!!ui.activeJob || !!ui.renderBlocked} title={ui.renderBlocked || "Render with seamless chaining"} onClick={() => ui.renderShots(p.shots.map((s) => s.id), true)}>Render seamless chain</button>
      </div>
      {p.shots.map((s, i) => (
        <div key={s.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>{i + 1}. {s.name}</b>
            <span className="muted small">{s.kind.toUpperCase()} · {s.takes.length} take(s)</span>
          </div>
          {s.takes.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>Not rendered yet.</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(360px,1fr))", gap: 10, marginTop: 8 }}>
            {s.takes.map((t) => (
              <div key={t.id} className={`panel ${t.accepted ? "sel" : ""}`} style={{ background: "var(--bg)" }}>
                {t.status === "ok" && t.videoFile ? (
                  <>
                    <video src={outputUrl(t.videoFile)} controls preload="metadata" style={{ width: "100%", maxHeight: 220 }} />
                    <div className="row small" style={{ marginTop: 6, justifyContent: "space-between" }}>
                      <span className="muted">seed {t.seed}{t.meta?.durationS ? ` · ${t.meta.durationS.toFixed(1)}s` : ""}</span>
                      <button className={`small ${t.accepted ? "ok" : ""}`}
                        onClick={() => setAccept(p, s, t.id, !t.accepted, ui)}>
                        {t.accepted ? "✓ Accepted" : "Accept"}
                      </button>
                    </div>
                    {t.meta?.warnings && t.meta.warnings.length > 0 && (
                      <div className="err small" style={{ marginTop: 4 }}>⚠ {t.meta.warnings.join(" ")}</div>
                    )}
                    {t.meta?.compiledPrompt && (
                      <details className="small">
                        <summary className="muted" style={{ cursor: "pointer" }}>compiled prompt</summary>
                        <pre className="monoline" style={{ marginTop: 4 }}>{t.meta.compiledPrompt}</pre>
                      </details>
                    )}
                  </>
                ) : (
                  <div className="err small" style={{ padding: 8 }}>✗ {t.error}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {p.shots.length === 0 && <div className="empty">Add shots in the Script tab first.</div>}
    </div>
  );
}

function setAccept(p: Project, s: Shot, takeId: string, accepted: boolean, ui: ReturnType<typeof useUi>) {
  const next: Project = {
    ...p,
    shots: p.shots.map((x) =>
      x.id === s.id ? { ...x, takes: x.takes.map((t) => (t.id === takeId ? { ...t, accepted } : t)) } : x,
    ),
  };
  // only one accepted take per shot
  if (accepted) {
    next.shots = next.shots.map((x) =>
      x.id === s.id ? { ...x, takes: x.takes.map((t) => ({ ...t, accepted: t.id === takeId })) } : x,
    );
  }
  ui.saveProject(next);
}

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------

export function ExportView() {
  const ui = useUi();
  const p = ui.project;
  if (!p) return null;
  const exports = ui.jobs.export;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
      <div className="card">
        <div className="row">
          <div>
            <b>Assemble &amp; export</b>
            <div className="muted small">Concatenates the accepted take of each shot in order (rendered with “seamless chain” for frame-perfect cuts).</div>
          </div>
          <div className="grow" />
          <button className="small" disabled={!!ui.activeJob || exports.some((e) => e.status === "running" || e.status === "queued")}
            onClick={() => api.export(p.id).then(() => ui.toast("Export queued")).catch((e) => ui.toast(e.message, "err")).finally(() => ui.refreshAll())}>
            Export accepted takes
          </button>
        </div>
        {p.shots.map((s, i) => {
          const acc = s.takes.find((t) => t.accepted && t.status === "ok");
          return (
            <div key={s.id} className="row small" style={{ marginTop: 6, gap: 8 }}>
              <span className="muted">{i + 1}.</span>
              <span className="grow">{s.name}</span>
              {acc ? <span className="ok">✓ take {acc.seed}</span> : <span className="muted">no accepted take (uses last ok)</span>}
            </div>
          );
        })}
      </div>
      <div className="list-scroll" style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
        {exports.length === 0 && <div className="empty">No exports yet.</div>}
        {exports.map((e) => (
          <div key={e.id} className="card row" style={{ gap: 12 }}>
            <div style={{ width: 220 }}>
              {e.status === "done" && e.file ? (
                <video src={exportUrl(e.file)} controls preload="metadata" style={{ width: "100%", maxHeight: 130 }} />
              ) : (
                <div style={{ height: 90, display: "flex", alignItems: "center", justifyContent: "center" }} className="muted">
                  {e.status === "error" ? "✗ failed" : e.status === "done" ? "done" : "…"}
                </div>
              )}
            </div>
            <div className="grow">
              <div className="small">export {e.id} — {new Date(e.createdAt).toLocaleTimeString()}</div>
              {e.status === "running" || e.status === "queued" ? (
                <>
                  <div className="progressbar" style={{ marginTop: 8 }}><div style={{ width: e.status === "running" ? "40%" : "8%", transition: "width 2s" }} /></div>
                  <div className="muted small">stitching clips…</div>
                </>
              ) : e.status === "done" ? (
                <a className="small" href={e.file ? exportUrl(e.file) : "#"} download>⬇ download</a>
              ) : (
                <div className="err small">{e.error}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// AI co-director
// ----------------------------------------------------------------------

export function AiPane({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const p = ui.project;
  const [brief, setBrief] = useState("");
  const [extra, setExtra] = useState("");
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Shot[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [lastUsed, setLastUsed] = useState("");
  if (!p) return null;

  const cfg = ui.settings?.director;
  const cfgCard = PROVIDER_CARDS.find((c) => c.id === cfg?.provider);
  const routeLabel = cfgCard?.label ?? cfg?.provider;
  const llmReady = !!ui.status?.llmUp;

  const run = async () => {
    setErr("");
    setLoading(true);
    try {
      const r = await api.direct(p.id, brief, extra);
      setDrafts(r.shots);
      setWarnings(r.warnings);
      if (r.model) {
        const c = PROVIDER_CARDS.find((x) => x.id === r.provider);
        setLastUsed(`${c?.label ?? r.provider} · ${r.model}`);
      }
      ui.toast(`AI drafted ${r.shots.length} shot(s)`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const addAll = () => {
    const next = { ...p, shots: [...p.shots, ...drafts] };
    ui.saveProject(next);
    setDrafts([]);
    ui.toast(`Added ${drafts.length} shot(s) to the timeline`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>✦ AI co-director</b>
        <button className="small ghost" onClick={onClose}>✕</button>
      </div>
      <div className="muted small">Turn a logline into a full shot list.</div>
      <div className="panel" style={{ background: "var(--bg)", padding: "8px 10px" }}>
        <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className={`dot ${llmReady && cfg?.model ? "ok" : "bad"}`} />
          {cfg?.provider && cfg?.model ? (
            <span>
              {llmReady ? "AI co-director ready" : "AI co-director not reachable"} — <b>{routeLabel} · {cfg.model}</b>
            </span>
          ) : (
            <span className="err">No model chosen yet — open ⚙ Settings → Provider routing and pick one.</span>
          )}
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>
          Switch provider/model in <b>Settings → Provider routing</b>.
        </div>
      </div>
      <Field label="Brief — what is the video about?">
        <textarea rows={5} value={brief} style={{ width: "100%" }}
          placeholder="A 20-second teaser for a short film: Maria returns to her childhood home… (mention tone, locations, cast from your library, whether shots should chain seamlessly)"
          onChange={(e) => setBrief(e.target.value)} />
      </Field>
      <Field label="Extra constraints (optional)">
        <textarea rows={2} value={extra} style={{ width: "100%" }}
          placeholder="e.g. no dialogue in shot 2; end on a close-up; aspect 16:9…" onChange={(e) => setExtra(e.target.value)} />
      </Field>
      <button className="primary" disabled={loading || !brief.trim()} onClick={run}>
        {loading ? `Directing with ${cfg?.model ?? "…"}…` : "✦ Generate shot list"}
      </button>
      {lastUsed && <div className="ok small">✓ Last run drafted with {lastUsed}</div>}
      {err && <div className="err">{err}</div>}
      {warnings.map((w, i) => <div key={i} className="err small">{w}</div>)}
      {drafts.length > 0 && (
        <>
          <div className="list-scroll" style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 420 }}>
            {drafts.map((d, i) => (
              <div key={d.id} className="card">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b className="small">{i + 1}. {d.name}</b>
                  <span className={`kind-badge ${d.kind}`}>{d.kind.toUpperCase()}</span>
                </div>
                <div className="small muted" style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{d.prompt.slice(0, 220)}{d.prompt.length > 220 ? "…" : ""}</div>
                <div className="small muted" style={{ marginTop: 4 }}>{d.seconds}s</div>
              </div>
            ))}
          </div>
          <button className="primary small" onClick={addAll}>Add all {drafts.length} to timeline</button>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------

export function SettingsView({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const [s, setS] = useState<AppSettings | null>(ui.settings);
  const [saving, setSaving] = useState(false);
  if (!s) return null;

  const apply = async (patch: Partial<AppSettings>) => {
    try {
      const up = await api.putSettings(patch);
      setS(up);
      await ui.refreshStatus();
      void ui.refreshAll();
      return up;
    } catch (e) {
      ui.toast((e as Error).message, "err");
      return null;
    }
  };

  const save = async () => {
    setSaving(true);
    await apply({
      comfyUrl: s.comfyUrl,
      comfyRoot: s.comfyRoot,
      purgeBetweenShots: s.purgeBetweenShots,
      port: s.port,
      ollamaUrl: s.ollamaUrl,
      director: s.director,
    });
    ui.toast("Settings saved");
    setSaving(false);
  };

  const st = ui.status;
  const cloudCards = PROVIDER_CARDS.filter((c) => c.id !== "ollama");
  const selectedCard = PROVIDER_CARDS.find((c) => c.id === s.director.provider);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)" }}>
          <b>Settings</b>
          <div className="grow" />
          <button className="small ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body list-scroll">
          {/* ---------- engine ---------- */}
          <b className="small">Render engine</b>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
            <Field label="ComfyUI address">
              <input value={s.comfyUrl} onChange={(e) => setS({ ...s, comfyUrl: e.target.value })} />
            </Field>
            <Field label="ComfyUI folder (auto-discovered if empty)">
              <input value={s.comfyRoot} placeholder="e.g. C:\\ComfyUI_windows_portable\\ComfyUI" onChange={(e) => setS({ ...s, comfyRoot: e.target.value })} />
            </Field>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
            <Field label="Video render timeout (min)" hint="A shot still running after this is abandoned. Raise it for slow 2K / long shots.">
              <input type="number" min={1} max={600} value={s.renderTimeoutMin ?? 25}
                onChange={(e) => setS({ ...s, renderTimeoutMin: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Image render timeout (min)" hint="Same, for a still or board image.">
              <input type="number" min={1} max={600} value={s.imageTimeoutMin ?? 20}
                onChange={(e) => setS({ ...s, imageTimeoutMin: Number(e.target.value) || 1 })} />
            </Field>
          </div>
          <div className="row small muted" style={{ marginTop: 8 }}>
            Status: {st ? (st.comfyUp ? <span className="ok">ComfyUI {st.comfyVersion} {st.gpuName ? `· ${st.gpuName}` : ""} online</span> : <span className="err">ComfyUI offline — {st.error}</span>) : "probing…"}
            {st?.comfyRoot && <span> · folder: {st.comfyRoot}</span>}
          </div>
          {st && (
            <div className="card" style={{ marginTop: 10 }}>
              <b className="small">Engine sees</b>
              <div className="small muted" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>
                FL2VA: {st.models.fl2va.join(", ") || "none"}
                {"\n"}REF2VA: {st.models.ref2va.join(", ") || "none"}
                {"\n"}Text encoder: {st.models.textEncoder.join(", ") || "none"}
              </div>
              <button className="small ghost" style={{ marginTop: 8 }} onClick={() => ui.refreshStatus()}>Refresh probe</button>
            </div>
          )}

          {/* ---------- provider routing ---------- */}
          <div style={{ height: 18 }} />
          <b className="small">Provider routing — AI co-director</b>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
            <Field label="Provider">
              <select
                value={s.director.provider}
                onChange={(e) => apply({ director: { provider: e.target.value, model: e.target.value === s.director.provider ? s.director.model : "" } })}
              >
                {PROVIDER_CARDS.map((c) => {
                  const meta = s.keys[c.id];
                  return (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {!c.local && meta?.configured ? "  · key saved" : c.local ? "" : "  · no key"}
                    </option>
                  );
                })}
              </select>
            </Field>
            {s.director.provider === "ollama" ? (
              <OllamaModelPicker
                url={s.ollamaUrl}
                model={s.director.model}
                onUrlChange={(u) => setS({ ...s, ollamaUrl: u })}
                onPick={(model) => apply({ director: { provider: "ollama", model } })}
              />
            ) : (
              <RemoteModelPicker
                key={s.director.provider}
                providerId={s.director.provider}
                model={s.director.model}
                meta={s.keys[s.director.provider]}
                onPick={(model) => apply({ director: { provider: s.director.provider, model } })}
              />
            )}
          </div>
          <div className="row small muted" style={{ marginTop: 6 }}>
            Route status: {st ? (st.llmUp ? <span className="ok">{selectedCard?.label} reachable {st.llmModel ? `· ${st.llmModel}` : ""}</span> : <span className="err">{selectedCard?.label} not reachable yet — add a key or start your local server</span>) : ""}
          </div>

          {/* ---------- API keys ---------- */}
          <div style={{ height: 18 }} />
          <b className="small">Providers &amp; API keys</b>
          <div className="muted small" style={{ marginTop: 4 }}>
            Keys stay on this computer, are never shown in full, and are only read by the server. Environment variables
            (e.g. <span className="monoline" style={{ display: "inline" }}>GROK_API_KEY</span>) are read as a fallback. Test saves the key first, then tries it.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {cloudCards.map((c) => (
              <KeyRow key={c.id} card={c} meta={s.keys[c.id]} onChanged={() => { setS(ui.settings); void ui.refreshAll(); }} />
            ))}
          </div>

          {/* ---------- misc ---------- */}
          <div style={{ height: 18 }} />
          <div className="row">
            <input type="checkbox" id="purge" checked={s.purgeBetweenShots} onChange={(e) => setS({ ...s, purgeBetweenShots: e.target.checked })} />
            <label htmlFor="purge" style={{ margin: 0 }}>Free VRAM between shots (slower, safer on small cards)</label>
            <div className="grow" />
            <button className="small" onClick={() => api.freeComfy().then(() => ui.toast("VRAM freed")).catch((e) => ui.toast(e.message, "err"))}>Free VRAM now</button>
          </div>
          <div style={{ height: 14 }} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button disabled={saving} onClick={save} className="primary">{saving ? "Saving…" : "Save engine settings"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function OllamaModelPicker({
  url, model, onUrlChange, onPick,
}: {
  url: string;
  model: string;
  onUrlChange: (u: string) => void;
  onPick: (m: string) => void;
}) {
  const [models, setModels] = useState<OllamaModelInfo[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    setErr("");
    const r = await api.testOllama(url); // saves url + lists models
    setBusy(false);
    if (r.ok && r.models) setModels(r.models);
    else setErr(r.error ?? "Ollama unreachable");
  };
  return (
    <Field label="Ollama model (local)">
      <div className="row">
        <input className="grow" value={url} placeholder="http://localhost:11434" onChange={(e) => onUrlChange(e.target.value)} />
        <button className="small" disabled={busy} onClick={refresh}>{busy ? "…" : "⇄ Test & list"}</button>
      </div>
      {err && <div className="err small" style={{ marginTop: 4 }}>{err} — start it with `ollama serve`</div>}
      <select value={model} style={{ marginTop: 6, width: "100%" }} onChange={(e) => onPick(e.target.value)}>
        {models.length === 0 && <option value="">pull a model (ollama pull qwen3:8b)…</option>}
        {models.map((m) => (
          <option key={m.name} value={m.name}>{m.name}{m.sizeGB ? ` · ${m.sizeGB}` : ""}{m.details ? ` · ${m.details}` : ""}</option>
        ))}
      </select>
    </Field>
  );
}

/** Order for the Cline model dropdown: `cline-free/*` promos first (truly free —
 *  these are the FREE models Cline's own selector shows), then `cline-pass/*`
 *  (flat subscription — free at point of use), then `:free` API promos, then
 *  everything else in the provider's own order. Harmless no-op for providers
 *  that have none of these. */
function freeFirst(models: string[]): string[] {
  const isFreeNs = (m: string) => m.startsWith("cline-free/");
  const isPass = (m: string) => m.startsWith("cline-pass/");
  const isFree = (m: string) => /:free$/i.test(m.split("/").pop() ?? "");
  return [
    ...new Set([
      ...models.filter(isFreeNs),
      ...models.filter((m) => !isFreeNs(m) && isPass(m)),
      ...models.filter((m) => !isFreeNs(m) && !isPass(m) && isFree(m)),
      ...models.filter((m) => !isFreeNs(m) && !isPass(m) && !isFree(m)),
    ]),
  ];
}

function RemoteModelPicker({
  providerId, model, meta, onPick,
}: {
  providerId: string;
  model: string;
  meta?: ProviderKeyMeta;
  onPick: (m: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const fetchModels = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.providerModels(providerId);
      setModels(freeFirst([...extra, ...r.models]));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Auto-load the model list whenever the provider changes (component is keyed by
  // providerId) or its key becomes configured — so the dropdown is always ready.
  // Providers with open /models (e.g. Cline) list fine before a key is saved; the
  // rest just show the "save a key" hint instead of a raw error.
  const configured = !!meta?.configured;
  // Ids the provider offers but its /models endpoint omits (e.g. Cline's
  // cline-free/* and cline-pass/* namespaces) — merged, deduped, free on top.
  const extra = PROVIDER_CARDS.find((c) => c.id === providerId)?.extraModels ?? [];
  useEffect(() => {
    setModels([]);
    let dead = false;
    setBusy(true);
    setErr("");
    api
      .providerModels(providerId)
      .then((r) => { if (!dead) setModels(freeFirst([...extra, ...r.models])); })
      .catch((e) => { if (!dead && configured) setErr((e as Error).message); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, configured]);

  // Always a dropdown: keep the saved model selectable even if it's missing from
  // the fetched list (stale id, custom provider, or the list failed to load).
  const options = models.length ? [...models] : [];
  if (model && !options.includes(model)) options.unshift(model);

  return (
    <Field label="Model">
      <div className="row">
        <select
          className="grow"
          value={model}
          disabled={busy && models.length === 0}
          onChange={(e) => onPick(e.target.value)}
        >
          {!model && <option value="">— pick a model —</option>}
          {options.length === 0 && (
            <option value="" disabled>
              {busy ? "loading models…" : "no models — save a key, then ⇄"}
            </option>
          )}
          {options.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button className="small" disabled={busy} onClick={fetchModels} title="Refresh model list from the provider">{busy ? "…" : "⇄"}</button>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {`${models.length} model${models.length === 1 ? "" : "s"} from the provider`}
        {!meta?.configured && " · save a key below to load them"}
      </div>
      {err && <div className="err small" style={{ marginTop: 4 }}>{err}</div>}
    </Field>
  );
}

function KeyRow({ card, meta, onChanged }: { card: ProviderCard; meta?: ProviderKeyMeta; onChanged: () => void }) {
  const ui = useUi();
  const [base, setBase] = useState(meta?.baseUrl ?? card.baseUrl);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ ok?: boolean; text?: string }>({});
  const m = meta ?? { configured: false, last4: "", envVar: card.envVar, model: "", baseUrl: card.baseUrl, id: card.id, label: card.label } as ProviderKeyMeta;

  const save = async (withKey?: string) => {
    setBusy("save");
    try {
      await api.putKey(card.id, {
        baseUrl: base,
        ...(withKey !== undefined ? { key: withKey } : {}),
      });
      setKey("");
      setResult({ ok: true, text: "saved" });
      onChanged();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
    }
  };
  const test = async () => {
    setBusy("test");
    const r = await api.testKey(card.id, { baseUrl: base, ...(key ? { key } : {}) });
    setBusy("");
    if (r.ok) {
      setResult({ ok: true, text: `OK — ${r.models?.length ?? 0} models` });
      setKey("");
      onChanged();
    } else {
      setResult({ ok: false, text: r.error ?? "test failed" });
    }
  };
  const clear = async () => {
    await api.clearKey(card.id);
    setKey("");
    setResult({});
    onChanged();
  };
  return (
    <div className="card" style={{ background: "var(--bg)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b className="small">{card.label}</b>
        <span>
          {m.configured ? <span className="ok small">saved{m.last4 ? ` · ${m.last4}` : " · from .env"}</span> : <span className="muted small">not configured</span>}
          {result.ok && result.text !== "saved" && <span className="ok small"> · {result.text}</span>}
        </span>
      </div>
      {m.envVar && <div className="muted small">{m.envVar} read as a fallback</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <input className="grow" style={{ width: "40%" }} value={base} placeholder={card.baseUrl} onChange={(e) => setBase(e.target.value)} />
        {!card.local && (
          <input
            className="grow"
            type="password"
            value={key}
            placeholder={m.configured ? `saved · ••••${m.last4} — type a new key to replace` : "Paste API key…"}
            onChange={(e) => setKey(e.target.value)}
          />
        )}
        <button className="small" disabled={busy !== ""} onClick={test}>{busy === "test" ? "…" : "Test"}</button>
        <button className="small primary" disabled={busy !== "" || (!key && base === m.baseUrl)} onClick={() => save(key)}>{busy === "save" ? "…" : "Save"}</button>
        {m.configured && <button className="small danger" onClick={clear}>Clear</button>}
      </div>
      {result.text && result.ok !== undefined && result.ok === false && <div className="err small" style={{ marginTop: 4 }}>{result.text}</div>}
    </div>
  );
}
