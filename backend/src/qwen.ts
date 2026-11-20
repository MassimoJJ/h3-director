// Qwen Image 2.1 still-image engine (t2i + image-edit), flattened from the stock
// ComfyUI templates image_qwen_image_2_1_t2i / image_qwen_image_2_1_image_edit into
// API-format graphs. The stock workflows wrap everything in a subgraph; subgraphs
// cannot be expressed in the /prompt API, so the inner nodes are rebuilt here with the
// exact wiring the templates use.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collectOutputFiles, ComfyClient } from "./comfy";
import { absData, stageFiles, uploadImage } from "./media";
import { getAsset } from "./store";
import { identityRuleForQwen } from "./types";
import type { ImageBoard, ImageMode, Project, ShotStill } from "./types";

export interface QwenModels {
  unet: string;
  clip: string;
  vae: string;
  /** Optional second text encoder used by the stock prompt-enhancer path. */
  clipEnhancer: string | null;
}

export interface QwenProbe {
  ready: boolean;
  models: QwenModels | null;
  nodes: Record<string, boolean>;
  error?: string;
}

export interface ImagePlan {
  apiPrompt: Record<string, unknown>;
  compiledPrompt: string;
  warnings: string[];
}

export interface RenderImageInputs {
  project: Project;
  /** Either a board or a shot's still stage — both carry the same rendering fields. */
  board: ImageBoard | ShotStill;
  /** Fallback prompt when the still's own prompt is empty (a shot passes its own). */
  fallbackPrompt?: string;
  seed: number;
  comfy: ComfyClient;
  comfyInputDir: string;
  /** Sub-folder under images/<projectId>/ the PNG is written to. */
  destId: string;
  /** How long to wait for this image before giving up (ms). Default 20 minutes. */
  timeoutMs?: number;
  /** Identity lock from the owning shot; boards carry their own characterId. */
  characterId?: string | null;
}

export interface ImageRenderResult {
  imageFile: string; // data-relative
  promptId: string;
  seed: number;
  compiledPrompt: string;
  warnings: string[];
  width?: number;
  height?: number;
}

const REQUIRED_NODES = [
  "UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21",
  "KSampler", "VAEDecode", "SaveImage", "EmptyLatentImage",
];

const PREFERRED_UNET = ["qwen_image_2.1", "qwen_image_2_1", "qwen_image"];
const PREFERRED_CLIP = ["qwen3vl_8b", "qwen3-vl_8b", "qwen_image"];
const PREFERRED_VAE = ["qwen_image_2.1", "qwen_image_2_1", "qwen_image"];

/** Pick the first candidate matching one of the preference needles, else the first entry. */
function pick(choices: string[], needles: string[]): string | null {
  if (!choices.length) return null;
  for (const needle of needles) {
    const hit = choices.find((c) => c.toLowerCase().includes(needle.toLowerCase()));
    if (hit) return hit;
  }
  return choices[0];
}

/** Resolve the Qwen Image 2.1 model files from the running ComfyUI. */
export async function resolveQwenModels(comfy: ComfyClient): Promise<QwenProbe> {
  let nodes: Record<string, boolean> = {};
  try {
    const oi = await comfy.objectInfo(true);
    for (const k of [...REQUIRED_NODES, "QwenImage21Cache", "TextGenerate", "LoadImage"]) nodes[k] = k in oi;
  } catch (e) {
    return { ready: false, models: null, nodes, error: e instanceof Error ? e.message : String(e) };
  }
  const missing = REQUIRED_NODES.filter((k) => !nodes[k]);
  if (missing.length) {
    return { ready: false, models: null, nodes, error: `ComfyUI is missing nodes: ${missing.join(", ")}` };
  }
  try {
    const [unets, clips, vaes] = await Promise.all([
      comfy.comboChoices("UNETLoader", "unet_name"),
      comfy.comboChoices("CLIPLoader", "clip_name"),
      comfy.comboChoices("VAELoader", "vae_name"),
    ]);
    const unet = pick(unets, PREFERRED_UNET);
    const clip = pick(clips, PREFERRED_CLIP);
    const vae = pick(vaes, PREFERRED_VAE);
    if (!unet || !clip || !vae) {
      const have = [
        !unet && "diffusion model (qwen_image_2.1)",
        !clip && "text encoder (qwen3vl_8b)",
        !vae && "VAE (qwen_image_2.1_vae)",
      ].filter(Boolean).join(", ");
      return { ready: false, models: null, nodes, error: `Missing Qwen Image model file(s): ${have}` };
    }
    return { ready: true, models: { unet, clip, vae, clipEnhancer: null }, nodes };
  } catch (e) {
    return { ready: false, models: null, nodes, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Snap a dimension to the multiple of 16 the Qwen VAE requires. */
function snap(v: number): number {
  return Math.max(64, Math.min(4096, Math.round(v / 16) * 16));
}



export interface BuildImageOpts {
  mode: ImageMode;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  enhancePrompt: boolean;
  cacheDevice: ImageBoard["cacheDevice"];
  cacheDtype: ImageBoard["cacheDtype"];
  /** Staged, input-relative reference image paths (edit mode). */
  references: string[];
  models: QwenModels;
  nodes: Record<string, boolean>;
}

/**
 * Build the API-format graph for one Qwen Image 2.1 render.
 *
 * edit mode: reference images are attached through the autogrow input
 * `images.image_1..N` (min 0, so t2i simply omits them) and the KSampler is fed the
 * TextEncodeQwenImage21 `latent` output, which the node builds at the first reference's
 * size. That is what keeps an edit aligned with the source framing instead of resampling
 * it to width/height.
 */
export function buildImageGraph(o: BuildImageOpts): ImagePlan {
  const warnings: string[] = [];
  const g: Record<string, unknown> = {};
  const n = (id: string, classType: string, inputs: Record<string, unknown>) => {
    g[id] = { class_type: classType, inputs };
  };
  const link = (id: string, outIdx = 0) => [id, outIdx];

  const w = snap(o.width);
  const h = snap(o.height);
  if (w !== o.width || h !== o.height) {
    warnings.push(`Canvas snapped to ${w}x${h} (Qwen requires multiples of 16).`);
  }

  n("unet", "UNETLoader", { unet_name: o.models.unet, weight_dtype: "default" });
  if (o.nodes["QwenImage21Cache"]) {
    n("cache", "QwenImage21Cache", { model: link("unet"), device: o.cacheDevice, dtype: o.cacheDtype });
  }
  const modelRef = o.nodes["QwenImage21Cache"] ? link("cache") : link("unet");

  n("clip", "CLIPLoader", { clip_name: o.models.clip, type: "qwen_image", device: "default" });
  n("vae", "VAELoader", { vae_name: o.models.vae });

  // Reference images -> the autogrow inputs, in order.
  const encodeInputs: Record<string, unknown> = {
    clip: link("clip"),
    prompt: o.prompt,
    negative_prompt: o.negativePrompt,
    resolution: 1024,
    vae: link("vae"),
  };
  o.references.forEach((rel, i) => {
    const id = `ref_${i}`;
    n(id, "LoadImage", { image: rel });
    encodeInputs[`images.image_${i + 1}`] = link(id);
  });

  if (o.enhancePrompt) {
    if (o.nodes["TextGenerate"] && o.models.clipEnhancer) {
      n("enhClip", "CLIPLoader", { clip_name: o.models.clipEnhancer, type: "qwen_image", device: "default" });
      n("enhance", "TextGenerate", {
        clip: link("enhClip"),
        prompt: o.prompt,
        max_length: 1024,
        use_default_template: true,
      });
      n("enhOut", "PreviewAny", { source: link("enhance") });
      encodeInputs.prompt = link("enhOut");
    } else {
      warnings.push("Prompt enhancement is not available in this ComfyUI install; used the prompt as written.");
    }
  }

  n("encode", "TextEncodeQwenImage21", encodeInputs);

  // t2i: an explicit empty latent at the requested size. edit: the encoder's latent,
  // already sized to the first reference image.
  let latentRef: unknown;
  if (o.mode === "edit" && o.references.length > 0) {
    latentRef = link("encode", 2);
  } else {
    n("emptyLatent", "EmptyLatentImage", { width: w, height: h, batch_size: 1 });
    latentRef = link("emptyLatent");
  }

  n("sampler", "KSampler", {
    model: modelRef,
    seed: optsSeed(o.seed),
    steps: Math.max(1, Math.min(100, Math.round(o.steps))),
    cfg: o.cfg,
    sampler_name: o.sampler,
    scheduler: o.scheduler,
    positive: link("encode", 0),
    negative: link("encode", 1),
    latent_image: latentRef,
    denoise: 1,
  });
  n("decode", "VAEDecode", { samples: link("sampler"), vae: link("vae") });
  n("save", "SaveImage", { images: link("decode"), filename_prefix: "h3director/qwen" });

  if (o.mode === "edit" && o.references.length === 0) {
    warnings.push("Edit mode with no reference image selected - rendered a text-to-image instead.");
  }

  return { apiPrompt: g, compiledPrompt: o.prompt, warnings };
}

/** KSampler wants a non-negative integer seed. */
function optsSeed(seed: number): number {
  return Math.max(0, Math.floor(seed));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Queue one image render in ComfyUI, wait for completion, download and store the PNG. */
export async function renderImage(opts: RenderImageInputs): Promise<ImageRenderResult> {
  const { project, board, comfy, comfyInputDir } = opts;
  const limitMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 20 * 60_000;
  const probe = await resolveQwenModels(comfy);
  if (!probe.ready || !probe.models) throw new Error(probe.error ?? "Qwen Image 2.1 is not available in ComfyUI.");

  // A shot's still may leave its prompt empty to inherit the shot's own prompt.
  const isEdit = (board as ShotStill).mode === "i2i" || board.mode === "edit";

  // Identity lock. In text-to-image the character leads, because there is no
  // source frame to preserve; in edit mode the image being edited must lead so
  // the encoder's latent keeps its framing, and the character follows.
  const userRefAbs: string[] = [];
  for (const id of board.imageIds) {
    const a = getAsset(id);
    if (!a) continue;
    if (a.kind !== "image") throw new Error(`Reference "${a.name}" is not an image.`);
    userRefAbs.push(absData(a.file));
  }
  const characterId = opts.characterId ?? board.characterId ?? null;
  const character = characterId ? getAsset(characterId) : undefined;
  if (characterId && !character) throw new Error(`Character asset not found: ${characterId}`);
  if (character && character.kind !== "image") throw new Error(`Character "${character.name}" is not an image.`);
  const characterAbs = character ? absData(character.file) : null;

  const seen = new Set<string>();
  const refAbs: string[] = [];
  const addRef = (abs: string | null) => {
    if (abs && !seen.has(abs)) { seen.add(abs); refAbs.push(abs); }
  };
  if (!isEdit) addRef(characterAbs);
  userRefAbs.forEach(addRef);
  if (isEdit) addRef(characterAbs);
  const identityRef = characterAbs ? refAbs.indexOf(characterAbs) + 1 : 0;

  // Stage reference images so LoadImage can reference them by filename.
  const staged: string[] = [];
  if (refAbs.length) {
    if (comfyInputDir) {
      const map = await stageFiles(
        comfyInputDir,
        project.id,
        refAbs.map((abs) => ({ abs, kind: "image" as const })),
      );
      for (const abs of refAbs) {
        const rel = map.get(abs)?.inputRel;
        if (rel) staged.push(rel);
      }
    } else {
      for (const abs of refAbs) {
        const up = await uploadImage(comfy, abs);
        if (up.inputRel) staged.push(up.inputRel);
      }
    }
  }

  let prompt = board.prompt.trim() || (opts.fallbackPrompt ?? "").trim()
    || (isEdit ? "Refine this image." : "A cinematic film still.");
  if (identityRef && character) {
    const name = path.basename(character.name, path.extname(character.name));
    prompt = `${prompt}\n\n${identityRuleForQwen(identityRef, name)}`;
  }

  const plan = buildImageGraph({
    mode: isEdit ? "edit" : "t2i",
    prompt,
    negativePrompt: board.negativePrompt,
    width: board.width,
    height: board.height,
    steps: board.steps,
    cfg: board.cfg,
    sampler: board.sampler,
    scheduler: board.scheduler,
    seed: opts.seed,
    enhancePrompt: board.enhancePrompt,
    cacheDevice: board.cacheDevice,
    cacheDtype: board.cacheDtype,
    references: staged,
    models: probe.models,
    nodes: probe.nodes,
  });

  const clientId = `h3d-img-${opts.destId}-${Date.now()}`;
  const res = await comfy.queuePrompt(plan.apiPrompt, clientId);

  let hist: Record<string, unknown> | undefined;
  const started = Date.now();
  for (;;) {
    hist = await comfy.history(res.prompt_id);
    const st = (hist as { status?: { status_str?: string } } | undefined)?.status?.status_str;
    if (hist && st) break;
    if (Date.now() - started > limitMs) throw new Error(`Image render timed out after ${Math.round(limitMs / 60_000)} minutes.`);
    await sleep(3000);
  }
  const status = (hist as { status?: { status_str?: string } }).status;
  if (status?.status_str !== "success") {
    throw new Error(extractHistoryError(hist) || "ComfyUI image render failed (see ComfyUI console).");
  }

  const files = collectOutputFiles((hist as { outputs?: unknown }).outputs);
  const image = files.find((f) => !f.isVideo);
  if (!image) throw new Error("Image render finished but no image file was produced.");

  const buf = await comfy.viewFile(image.filename, image.subfolder, image.type);
  const dir = imagesDir(project.id, opts.destId);
  const name = `img_${Date.now()}_s${opts.seed}.png`;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, buf);
  const dims = imageSize(abs);

  return {
    imageFile: `images/${project.id}/${opts.destId}/${name}`,
    promptId: res.prompt_id,
    seed: opts.seed,
    compiledPrompt: plan.compiledPrompt,
    warnings: plan.warnings,
    width: dims.width,
    height: dims.height,
  };
}

export function imagesDir(projectId: string, boardId: string): string {
  const d = path.join(absData("images"), projectId, boardId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function newBoardId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Read PNG/JPEG dimensions straight from the header (no image library needed). */
export function imageSize(abs: string): { width?: number; height?: number } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, "r");
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (head.toString("ascii", 1, 4) === "PNG") {
      const dims = Buffer.alloc(8);
      fs.readSync(fd, dims, 0, 8, 16);
      return { width: dims.readUInt32BE(0), height: dims.readUInt32BE(4) };
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      // JPEG: walk segment markers to the first SOFn frame header.
      let off = 2;
      const seg = Buffer.alloc(4);
      for (let guard = 0; guard < 512; guard++) {
        if (fs.readSync(fd, seg, 0, 4, off) < 4) break;
        const marker = seg[0];
        const size = seg.readUInt16BE(2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const dims = Buffer.alloc(5);
          fs.readSync(fd, dims, 0, 5, off + 4);
          return { height: dims.readUInt16BE(1), width: dims.readUInt16BE(3) };
        }
        off += 2 + size;
      }
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return {};
}

function extractHistoryError(hist: Record<string, unknown> | undefined): string {
  const candidates: string[] = [];
  try {
    const outputs = (hist as { outputs?: Record<string, { messages?: Array<[string, { exception_message?: string; exception_type?: string }]> }> }).outputs;
    for (const node of Object.values(outputs ?? {})) {
      for (const msg of node.messages ?? []) {
        const d = msg[1] ?? {};
        if (typeof d.exception_message === "string" && d.exception_message.trim()) {
          candidates.push(`${d.exception_type ?? "error"}: ${d.exception_message}`);
        }
      }
    }
  } catch {
    /* ignore */
  }
  if (candidates.length) return candidates.slice(0, 2).join("\n").slice(0, 800);
  return "";
}
