// Headless H3 engine: turns a Shot into an API-format ComfyUI prompt built on the
// MiniMaxH3-Easy node chain (the same pipeline the user's MiniMax_H3_Easy.json uses),
// executes it, and imports the resulting video + audio.

import fs from "node:fs";
import path from "node:path";
import { collectOutputFiles, ComfyClient } from "./comfy";
import { absData, stageFiles, uploadImage } from "./media";
import { conformFrame, extractFirstFrame } from "./ffmpeg";
import { ensureOutputDirs, getAsset } from "./store";
import type { AppSettings, EngineProbe, Project, Shot } from "./types";
import { clampShotSeconds, identityRuleForH3, shiftPictureTags } from "./types";

export interface EngineModels {
  fl2va: string;
  ref2va: string;
  textEncoder: string;
  videoVae: string;
  audioVae: string;
}

export interface NodePresence {
  nodes: Record<string, boolean>;
  realismLora: string | null;
}

export interface RenderPlan {
  kind: Shot["kind"];
  apiPrompt: Record<string, unknown>;
  compiledPrompt: string;
  mediaCounts: { images: number; videos: number; audios: number };
  warnings: string[];
  /** Absolute paths of the keyframe images that were fed to the graph (first/last). */
  keyframes: { first?: string; last?: string };
}

export interface RenderInputs {
  project: Project;
  shot: Shot;
  models: EngineModels;
  seed: number;
  comfyInputDir: string; // ComfyUI/input; when empty, images fall back to /upload/image
  comfy: ComfyClient;
  /** How long to wait for this render before giving up (ms). Default 25 minutes. */
  timeoutMs?: number;
  firstFrameOverride?: string | null; // abs path to a PNG (chaining) staged into input
  lastFrameOverride?: string | null;
  extraRefImageOverride?: string | null; // abs path (r2v continuity reference)
  refVideoOverride?: string | null; // abs path to previous shot's video (r2v motion/location reference)
  extraWarnings?: string[];
  r2vContinuationText?: string;
}

const PICTURE_MAX = 9;
const VIDEO_MAX = 3;
const AUDIO_MAX = 3;

function hasTag(text: string, tag: string): boolean {
  return text.includes(tag);
}

/** Compose the exact prompt text handed to H3 (user prompt + engine helpers). */
export function compilePrompt(
  kind: Shot["kind"],
  prompt: string,
  audioCount: number,
  r2vContinuationText: string | undefined,
  identity?: { name: string; picture: number; pictureShift: number; startPicture?: number; startIsChain?: boolean; video?: number },
): string {
  // Identity images are PREPENDED, so every <Picture N> the director wrote has
  // to be renumbered before it reaches H3. The stored prompt is never mutated.
  let out = (identity ? shiftPictureTags(prompt, identity.pictureShift) : prompt).trim();
  const parts: string[] = [];
  if (audioCount > 0 && !hasTag(out, "<Audio")) {
    parts.push(`All speech in this shot is spoken in the voice of the person in <Audio ${audioCount}>.`);
  }
  if (identity) {
    parts.push(identityRuleForH3(identity.picture, identity.name));
    if (identity.startPicture) {
      // H3 builds frame 0 from the FIRST picture in reference mode. The portrait
      // is deliberately second, and this line stops the model from treating it
      // as the shot's opening image.
      parts.push(
        `Use <Picture ${identity.picture}> for the person's identity only. ` +
        "Do not copy its pose, framing, background or expression into the first frame of the video.",
      );
      parts.push(identity.startIsChain
        ? `<Picture ${identity.startPicture}> is the exact final frame of the previous shot. Begin this shot from that image — same person, pose, wardrobe, framing and location.`
        : `<Picture ${identity.startPicture}> is this shot's starting image. Begin the shot from it — same person, pose, wardrobe, framing and location.`);
      // Reference mode conditions on images but does not hold frame 0's environment
      // for the rest of the clip. Without this, a camera-direction in the director's
      // prompt lets H3 invent a new room/angle while keeping the locked face.
      const motionRef = identity.video
        ? ` Match the camera motion, speed and environment from <Video ${identity.video}> as well.`
        : "";
      parts.push(
        `Keep the environment from <Picture ${identity.startPicture}> for the ENTIRE shot: ` +
        "same location, same background geometry, same lighting and same camera position. " +
        "This is one continuous take in one place — no cut, no new camera angle, no different room. " +
        `Do not use the background from <Picture ${identity.picture}>.${motionRef}`,
      );
    }
  } else if (kind === "r2v" && r2vContinuationText) {
    parts.push(r2vContinuationText);
  }
  if (parts.length) out = `${out}\n\n${parts.join(" ")}`;
  return out;
}

export interface BuildOpts {
  imageRefs: string[]; // staged input-relative paths (keyframes, image modes)
  refImages: string[];
  refVideos: string[];
  refAudios: string[];
  keyframeRole: "first" | "last";
  keyframeFirst?: string; // absolute path of the first keyframe (post-conform source)
  keyframeLast?: string; // absolute path of the last keyframe (fl2v only)
}

/** Build the full API-format prompt graph for one shot. */
export function buildGraph(
  shot: Shot,
  models: EngineModels,
  opts: BuildOpts,
  seed: number,
  presence: NodePresence,
  compiledPrompt: string,
): RenderPlan {
  const warnings: string[] = [];
  const nodes = presence.nodes;
  const g: Record<string, unknown> = {};
  const n = (id: string, classType: string, inputs: Record<string, unknown>) => {
    g[id] = { class_type: classType, inputs };
  };
  const link = (id: string, outIdx: number) => [id, outIdx];

  const isImageMode = shot.kind !== "r2v";
  const mode = isImageMode ? "image" : "reference";

  // ----- media loader nodes + Easy media transport -----
  let slot = 0;
  const mediaInputs: Record<string, unknown> = {};
  const putMedia = (srcId: string, type: string) => {
    slot += 1;
    mediaInputs[`media_${slot}`] = link(srcId, 0);
    mediaInputs[`media_type_${slot}`] = type;
  };

  if (isImageMode) {
    opts.imageRefs.forEach((rel, i) => {
      const id = `img_kf_${i}`;
      n(id, "LoadImage", { image: rel });
      putMedia(id, "image");
    });
  } else {
    opts.refImages.forEach((rel, i) => {
      const id = `ref_img_${i}`;
      n(id, "LoadImage", { image: rel });
      putMedia(id, "image");
    });
    opts.refVideos.forEach((rel, i) => {
      const id = `ref_vid_${i}`;
      if (nodes["VHS_LoadVideo"]) {
        n(id, "VHS_LoadVideo", {
          video: rel, force_rate: 0, custom_width: 0, custom_height: 0,
          frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1,
        });
      } else if (nodes["LoadVideo"]) {
        n(id, "LoadVideo", { video: rel, force_rate: 0 });
      } else {
        warnings.push("No reference-video loader is available; dropping the reference video.");
        return;
      }
      putMedia(id, "video");
    });
    opts.refAudios.forEach((rel, i) => {
      const id = `ref_aud_${i}`;
      if (nodes["LoadAudio"]) n(id, "LoadAudio", { audio: rel });
      else if (nodes["LoadAudioUI"]) n(id, "LoadAudioUI", { audio: rel, start_time: 0, end_time: 0, duration: 0 });
      else {
        warnings.push("No audio loader node is available; dropping the reference audio.");
        return;
      }
      putMedia(id, "audio");
    });
  }

  n("loader", "MiniMaxH3EasyLoader", {
    fl2va_model: isImageMode ? models.fl2va : "none",
    ref2va_model: isImageMode ? "none" : models.ref2va,
    text_encoder: models.textEncoder,
    video_vae: models.videoVae,
    audio_vae: models.audioVae,
  });

  n("easy", "MiniMaxH3Easy", {
    h3_bundle: link("loader", 0),
    mode,
    prompt: compiledPrompt,
    resolution: shot.resolution === "custom" ? "custom" : shot.resolution,
    aspect_ratio: shot.aspect,
    width: shot.resolution === "custom" ? shot.width : 1344,
    height: shot.resolution === "custom" ? shot.height : 768,
    seconds: clampShotSeconds(shot.seconds),
    advanced: true,
    fps: Math.min(120, Math.max(1, shot.fps)),
    keyframe_role: opts.keyframeRole,
    ref_image_size: shot.refImageSize,
    reference_mention_mode: "index",
    prompt_optimizer_settings: false,
    prompt_optimizer_scene_guide: "none",
    ...mediaInputs,
  });
  n("easyOut", "MiniMaxH3EasyOutput", { h3_context: link("easy", 1) });

  // ----- model patch chain -----
  let cur = "easy";
  const patch = (id: string, classType: string, inputs: Record<string, unknown>) => {
    n(id, classType, { ...inputs, model: link(cur, 0) });
    cur = id;
  };
  if (shot.sigmaShiftVideo != null && nodes["MiniMaxH3SigmaShift"]) {
    patch("sigma", "MiniMaxH3SigmaShift", {
      shift_video: shot.sigmaShiftVideo,
      shift_audio: shot.sigmaShiftAudio ?? 3,
    });
  }
  if (shot.loraStrength > 0 && presence.realismLora && nodes["LoraLoaderModelOnly"]) {
    patch("lora", "LoraLoaderModelOnly", { lora_name: presence.realismLora, strength_model: Math.min(2, shot.loraStrength) });
  }
  if (shot.spectrum && nodes["SpectrumApplyMiniMaxH3"]) {
    patch("spectrum", "SpectrumApplyMiniMaxH3", {
      enabled: true, blend_weight: 0.5, degree: 1, ridge_lambda: 0.1, window_size: 2,
      flex_window: 0.75, warmup_steps: 1, tail_actual_steps: 1, max_history: 8, debug: false,
    });
  }
  // Note: MiniMaxH3MemoryEfficientSageAttentionPatch (KJNodes) is intentionally NOT
  // auto-applied: it requires the optional sageattention pip package, which is not
  // installed on this machine and would abort the whole render.
  const modelRef = link(cur, 0);

  // ----- sampler -----
  n("noise", "RandomNoise", { noise_seed: seed });
  n("ks", "KSamplerSelect", { sampler_name: shot.sampler });
  n("sched", "BasicScheduler", {
    model: modelRef, scheduler: shot.scheduler, steps: Math.max(1, Math.round(shot.steps)), denoise: 1,
  });
  n("guider", "BasicGuider", { model: modelRef, conditioning: link("easyOut", 0) });
  n("sampler", "SamplerCustomAdvanced", {
    noise: link("noise", 0),
    guider: link("guider", 0),
    sampler: link("ks", 0),
    sigmas: link("sched", 0),
    latent_image: link("easyOut", 1),
  });

  // ----- decode + save -----
  n("vd", "VAEDecode", { samples: link("sampler", 0), vae: link("easyOut", 2) });
  n("vda", "VAEDecodeAudio", { samples: link("sampler", 1), vae: link("easyOut", 3) });
  n("create", "CreateVideo", { images: link("vd", 0), fps: link("easyOut", 4), audio: link("vda", 0), bit_depth: 8 });
  n("save", "SaveVideo", {
    video: link("create", 0),
    filename_prefix: `h3director/${shot.id}_${seed}`,
    format: "mp4",
    codec: "h264",
    encoding: "auto",
  });

  return {
    kind: shot.kind,
    apiPrompt: g,
    compiledPrompt,
    mediaCounts: {
      images: opts.imageRefs.length + opts.refImages.length,
      videos: opts.refVideos.length,
      audios: opts.refAudios.length,
    },
    warnings,
    keyframes: { ...(opts.keyframeFirst ? { first: opts.keyframeFirst } : {}), ...(opts.keyframeLast ? { last: opts.keyframeLast } : {}) },
  };
}

function assetAbs(id: string): string {
  const a = getAsset(id);
  if (!a) throw new Error(`Library asset not found: ${id}`);
  return absData(a.file);
}

/** Resolve a shot's media, stage files, and produce the render plan. */
export async function planShot(ctx: RenderInputs, presence: NodePresence): Promise<{ plan: RenderPlan; seed: number }> {
  const { project, shot, comfyInputDir, comfy } = ctx;
  const warnings: string[] = [...(ctx.extraWarnings ?? [])];

  const imageMode = shot.kind !== "r2v";
  const kfFiles: string[] = [];
  let keyframeFirst: string | undefined;
  let keyframeLast: string | undefined;
  if (shot.kind === "i2v" || shot.kind === "fl2v" || shot.kind === "t2v") {
    if (shot.kind === "t2v") {
      // A chained t2v shot still gets the previous shot's final frame and behaves
      // as an implicit i2v — without this the seamless link was silently dropped.
      if (ctx.firstFrameOverride) {
        kfFiles.push(ctx.firstFrameOverride);
        keyframeFirst = ctx.firstFrameOverride;
        warnings.push("Chained: using the previous shot's final frame as this shot's first frame.");
      }
    } else {
      if (ctx.firstFrameOverride) {
        kfFiles.push(ctx.firstFrameOverride);
        keyframeFirst = ctx.firstFrameOverride;
      } else if (shot.firstFrameId) {
        const abs = assetAbs(shot.firstFrameId);
        kfFiles.push(abs);
        keyframeFirst = abs;
      }
      if (shot.kind === "fl2v") {
        if (ctx.lastFrameOverride) {
          kfFiles.push(ctx.lastFrameOverride);
          keyframeLast = ctx.lastFrameOverride;
        } else if (shot.lastFrameId) {
          const abs = assetAbs(shot.lastFrameId);
          kfFiles.push(abs);
          keyframeLast = abs;
        }
      }
    }
  }

  const refImageAbs: string[] = [];
  const refVideoAbs: string[] = [];
  const refAudioAbs: string[] = [];
  let identity: { name: string; picture: number; pictureShift: number; startPicture?: number; startIsChain?: boolean; video?: number } | undefined;

  // Resolve the identity lock BEFORE the media caps: the character image is the
  // one attachment the room refuses to drop, even on a crowded reference shot.
  const character = shot.characterId ? getAsset(shot.characterId) : undefined;
  if (shot.characterId && !character) throw new Error(`Character asset not found: ${shot.characterId}`);
  if (character && character.kind !== "image") throw new Error(`Character "${character.name}" is not an image.`);

  if (!imageMode) {
    if (character) {
      const chain = ctx.firstFrameOverride ?? ctx.extraRefImageOverride ?? null;
      const start = chain ?? (shot.firstFrameId ? assetAbs(shot.firstFrameId) : null);
      // ORDER MATTERS. In H3 reference mode <Picture 1> is the visual anchor and
      // frame 0 is generated from it. The seam/start frame must lead; the source
      // character follows and is described as identity-only in the prompt.
      if (start) {
        refImageAbs.push(start);
        // Reference mode does not natively write keyframes back into the output.
        // Mark the seam as a conformance keyframe so renderShot overwrites frame 0
        // with the exact previous final frame, just as it does in image mode.
        keyframeFirst = start;
      }
      refImageAbs.push(assetAbs(character.id));
      const identityPicture = refImageAbs.length;
      if (shot.lastFrameId) refImageAbs.push(assetAbs(shot.lastFrameId)); // last frame after identity
      identity = {
        name: path.basename(character.name, path.extname(character.name)),
        picture: identityPicture,
        pictureShift: refImageAbs.length,
        ...(start ? { startPicture: 1, startIsChain: !!chain } : {}),
      };
      warnings.push(
        `Character lock: ${identity.name} is attached as <Picture ${identityPicture}> for identity only; ` +
        `${start ? "<Picture 1> is the continuity start frame." : "There is no continuity frame, so the portrait is also the visual anchor."}`,
      );
    }
    for (const id of shot.imageIds) refImageAbs.push(assetAbs(id));
    if (ctx.extraRefImageOverride && !refImageAbs.includes(ctx.extraRefImageOverride)) {
      refImageAbs.push(ctx.extraRefImageOverride);
    }
    // Reserve one video slot for the previous shot's clip, so H3 can condition on
    // the camera/location over time instead of only copying a single start frame.
    const maxUserVideos = ctx.refVideoOverride ? Math.max(0, VIDEO_MAX - 1) : VIDEO_MAX;
    if (shot.videoIds.length > maxUserVideos) {
      warnings.push(`Only ${maxUserVideos} of your ${shot.videoIds.length} reference videos fit alongside the continuity clip; extras dropped.`);
    }
    for (const id of shot.videoIds.slice(0, maxUserVideos)) refVideoAbs.push(assetAbs(id));
    if (ctx.refVideoOverride) {
      let videoIndex = refVideoAbs.indexOf(ctx.refVideoOverride);
      if (videoIndex < 0) {
        refVideoAbs.push(ctx.refVideoOverride);
        videoIndex = refVideoAbs.length - 1;
      }
      if (identity) identity.video = videoIndex + 1;
      warnings.push(`Continuity video attached as <Video ${videoIndex + 1}> so the camera and location carry across the cut.`);
    }
    for (const id of shot.audioIds) refAudioAbs.push(assetAbs(id));
  } else if (character) {
    warnings.push(
      "This shot is still in image mode, where H3 accepts only first/last frames and cannot carry a character reference. " +
      "Re-attach the character in the shot inspector to switch it to reference mode.",
    );
  }

  if (!imageMode && shot.audioIds.length && refImageAbs.length + refVideoAbs.length === 0) {
    throw new Error("Reference-mode shot needs at least one reference image or video (audio alone is not accepted by H3).");
  }
  if (refImageAbs.length > PICTURE_MAX) {
    warnings.push(`More than ${PICTURE_MAX} reference images provided; extras dropped.`);
    refImageAbs.length = PICTURE_MAX;
  }
  if (refVideoAbs.length > VIDEO_MAX) {
    warnings.push(`More than ${VIDEO_MAX} reference videos provided; extras dropped.`);
    refVideoAbs.length = VIDEO_MAX;
  }
  if (refAudioAbs.length > AUDIO_MAX) {
    warnings.push(`More than ${AUDIO_MAX} audio references provided; extras dropped.`);
    refAudioAbs.length = AUDIO_MAX;
  }

  const allFiles = [
    ...kfFiles.map((f) => ({ abs: f, kind: "image" as const })),
    ...refImageAbs.map((f) => ({ abs: f, kind: "image" as const })),
    ...refVideoAbs.map((f) => ({ abs: f, kind: "video" as const })),
    ...refAudioAbs.map((f) => ({ abs: f, kind: "audio" as const })),
  ];
  const staged = new Map<string, { inputRel: string }>();
  if (comfyInputDir) {
    const map = await stageFiles(comfyInputDir, project.id, allFiles);
    for (const [k, v] of map) staged.set(k, v);
  } else {
    for (const f of allFiles) {
      if (f.kind !== "image") {
        throw new Error("Audio/video references need the ComfyUI input folder path (set it in Settings, or let the app auto-discover it).");
      }
      const up = await uploadImage(comfy, f.abs);
      staged.set(f.abs, up);
    }
  }
  const rel = (abs: string) => staged.get(abs)?.inputRel ?? "";

  const wantsLastOnly =
    shot.kind === "fl2v" &&
    !shot.firstFrameId &&
    !!shot.lastFrameId &&
    !ctx.firstFrameOverride;
  const keyframeRole: "first" | "last" = wantsLastOnly ? "last" : "first";

  const compiledPrompt = compilePrompt(
    shot.kind,
    shot.prompt,
    refAudioAbs.length,
    ctx.r2vContinuationText,
    identity,
  );

  const plan = buildGraph(
    shot,
    ctx.models,
    {
      imageRefs: kfFiles.map(rel),
      refImages: refImageAbs.map(rel),
      refVideos: refVideoAbs.map(rel),
      refAudios: refAudioAbs.map(rel),
      keyframeRole,
      keyframeFirst,
      keyframeLast,
    },
    ctx.seed,
    presence,
    compiledPrompt,
  );
  plan.warnings.push(...warnings);
  return { plan, seed: ctx.seed };
}

export interface ShotRenderResult {
  videoFile: string; // data-relative path
  thumbFile: string;
  promptId: string;
  seed: number;
  compiledPrompt: string;
  warnings: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Queue one shot in ComfyUI, wait for completion, download and store the video. */
export async function renderShot(opts: RenderInputs): Promise<ShotRenderResult> {
  const { project, shot, models, seed, comfy, comfyInputDir } = opts;
  const presence = await nodePresence(comfy);
  const { plan } = await planShot(opts, presence);

  const clientId = `h3d-${shot.id}-${Date.now()}`;
  const res = await comfy.queuePrompt(plan.apiPrompt, clientId);

  // The exact graph that was submitted. A failed render was previously
  // undiagnosable: the take recorded no promptId on the error path and the graph
  // was thrown away, so /history/<id> could never be consulted and the only way
  // to reproduce a failure was to reconstruct it by hand. Persist it next to the
  // shot's media, on BOTH the success and failure paths.
  const graphAbs = dumpGraph(project.id, shot.id, res.prompt_id, plan.apiPrompt, shot, seed);

  let hist: Record<string, unknown> | undefined;
  const started = Date.now();
  const limitMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 25 * 60_000;
  for (;;) {
    hist = await comfy.history(res.prompt_id);
    const st = (hist as { status?: { status_str?: string } } | undefined)?.status?.status_str;
    if (hist && st) break;
    if (Date.now() - started > limitMs) {
      // A timeout must not leave the prompt running: the next shot would queue
      // behind a zombie render for the full timeout again. Interrupt first.
      await comfy.interrupt().catch(() => {});
      throw new Error(
        `Render timed out after ${Math.round(limitMs / 60_000)} minutes. ` +
          `The engine prompt was interrupted; the graph is saved at ${graphAbs}.`,
      );
    }
    await sleep(4000);
  }
  const status = (hist as { status?: { status_str?: string } }).status;
  if (status?.status_str !== "success") {
    // Keep ComfyUI's own error output next to the graph: "render failed" with no
    // node name is not something you can act on.
    const detail = extractHistoryError(hist) || "ComfyUI render failed (see ComfyUI console).";
    saveGraphError(graphAbs, hist);
    throw new Error(`${detail}\n(prompt ${res.prompt_id}; graph saved to ${graphAbs})`);
  }

  const files = collectOutputFiles((hist as { outputs?: unknown }).outputs);
  const video = files.find((f) => f.isVideo);
  if (!video) throw new Error("Render finished but no video file was produced.");

  const buf = await comfy.viewFile(video.filename, video.subfolder, video.type);
  const dir = ensureOutputDirs(project.id, shot.id);
  const videoName = `take_${Date.now()}_s${seed}.mp4`;
  const videoAbs = path.join(dir, videoName);
  fs.writeFileSync(videoAbs, buf);

  // Seam conform: H3 treats keyframes as conditioning rows only (never written back
  // into the output latent), so frame 0 comes back re-generated. Swap in the exact
  // keyframe so chained shots cut without a jump.
  for (const which of ["first", "last"] as const) {
    const kf = plan.keyframes[which];
    if (!kf) continue;
    const tmp = `${videoAbs}.conform.mp4`;
    const res = await conformFrame(videoAbs, kf, tmp, which);
    if (res.ok) {
      fs.renameSync(tmp, videoAbs);
      plan.warnings.push(
        `Conformed: ${which === "first" ? "frame 0 is the exact previous final frame, then dissolves into moving generated footage with no frozen hold" : "frame end replaced with the exact last-frame keyframe"} ` +
        "(H3 only conditions on keyframes, it does not copy them).",
      );
    } else {
      fs.rmSync(tmp, { force: true });
      plan.warnings.push(`Could not conform the ${which} keyframe (${res.reason ?? "unknown error"}).`);
    }
  }

  const thumbName = videoName.replace(/\.mp4$/, ".png");
  const thumbAbs = path.join(dir, thumbName);
  await extractFirstFrame(videoAbs, thumbAbs).catch(() => fs.copyFileSync(videoAbs, thumbAbs));

  return {
    videoFile: `outputs/${project.id}/${shot.id}/${videoName}`,
    thumbFile: `outputs/${project.id}/${shot.id}/${thumbName}`,
    promptId: res.prompt_id,
    seed,
    compiledPrompt: plan.compiledPrompt,
    warnings: plan.warnings,
  };
}

/**
 * Write the submitted graph next to the shot's media, so a render — especially
 * a failed one — can be reproduced or inspected later. Without this, a failure
 * was undiagnosable after the fact: the take had no promptId and the graph was
 * gone, leaving only an error string.
 */
function dumpGraph(
  projectId: string,
  shotId: string,
  promptId: string,
  apiPrompt: Record<string, unknown>,
  shot: Shot,
  seed: number,
): string {
  const dir = ensureOutputDirs(projectId, shotId);
  const file = path.join(dir, `graph_${promptId}.json`);
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          promptId,
          shotId,
          shotName: shot.name,
          kind: shot.kind,
          seed,
          seconds: shot.seconds,
          resolution: shot.resolution,
          aspect: shot.aspect,
          width: shot.width,
          height: shot.height,
          steps: shot.steps,
          sampler: shot.sampler,
          scheduler: shot.scheduler,
          prompt: shot.prompt,
          writtenAt: new Date().toISOString(),
          apiPrompt,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (e) {
    // Never fail a render because the diagnostic dump could not be written.
    console.error(`[engine] could not save the graph for shot ${shotId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return file;
}

/** Append ComfyUI's history entry to the saved graph file. */
function saveGraphError(graphAbs: string, hist: Record<string, unknown> | undefined) {
  try {
    fs.appendFileSync(
      graphAbs,
      `\n\n/* ---- ComfyUI history at failure ---- */\n${JSON.stringify(hist, null, 2)}\n`,
      "utf8",
    );
  } catch (e) {
    console.error(`[engine] could not append the failure detail: ${e instanceof Error ? e.message : String(e)}`);
  }
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
  if (candidates.length) return candidates.slice(0, 2).join("\n").slice(0, 1200);
  try {
    const s = JSON.stringify(hist).slice(0, 1500);
    if (s.includes("exception")) return s;
  } catch {
    /* ignore */
  }
  return "";
}

let presenceCache: { at: number; value: NodePresence } | null = null;

export async function nodePresence(comfy: ComfyClient, force = false): Promise<NodePresence> {
  if (!force && presenceCache && Date.now() - presenceCache.at < 60_000) return presenceCache.value;
  const info = await comfy.objectInfo(force);
  const keys = [
    "MiniMaxH3EasyLoader", "MiniMaxH3Easy", "MiniMaxH3EasyOutput",
    "BasicGuider", "BasicScheduler", "KSamplerSelect", "SamplerCustomAdvanced", "RandomNoise",
    "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo",
    "LoadImage", "LoadAudio", "LoadAudioUI", "VHS_LoadVideo", "LoadVideo",
    "LoraLoaderModelOnly", "MiniMaxH3SigmaShift", "SpectrumApplyMiniMaxH3",
    "MiniMaxH3MemoryEfficientSageAttentionPatch",
  ];
  const nodes: Record<string, boolean> = {};
  for (const k of keys) nodes[k] = k in info;
  const loraSpec = info["LoraLoaderModelOnly"]?.input?.required?.["lora_name"] as unknown[] | undefined;
  const loraOpts = Array.isArray(loraSpec) && Array.isArray(loraSpec[0]) ? (loraSpec[0] as string[]) : [];
  const realismLora = loraOpts.find((s) => s.toLowerCase().includes("realism")) ?? null;
  presenceCache = { at: Date.now(), value: { nodes, realismLora } };
  return presenceCache.value;
}

export async function resolveEngineModels(comfy: ComfyClient, project: Project): Promise<EngineModels> {
  const oi = await comfy.objectInfo(true);
  const combo = (cls: string, input: string): string[] => {
    const spec = oi[cls]?.input?.required?.[input] as unknown[] | undefined;
    if (!Array.isArray(spec) || !Array.isArray(spec[0])) return [];
    return (spec[0] as string[]).filter((s) => !["none", "None", "无", ""].includes(s));
  };
  const pick = (pref: string | null | undefined, list: string[]) => {
    if (pref && list.includes(pref)) return pref;
    if (list.length) return list[0];
    return "";
  };
  return {
    fl2va: pick(project.modelFl2va, combo("MiniMaxH3EasyLoader", "fl2va_model")),
    ref2va: pick(project.modelRef2va, combo("MiniMaxH3EasyLoader", "ref2va_model")),
    textEncoder: pick(project.modelTextEncoder, combo("MiniMaxH3EasyLoader", "text_encoder")),
    videoVae: pick(null, combo("MiniMaxH3EasyLoader", "video_vae")),
    audioVae: pick(null, combo("MiniMaxH3EasyLoader", "audio_vae")),
  };
}

export async function runProbe(comfy: ComfyClient, comfyRoot: string, settings: AppSettings): Promise<EngineProbe> {
  const out: EngineProbe = {
    comfyUp: false,
    models: { fl2va: [], ref2va: [], textEncoder: [], loras: [] },
    nodes: {},
    llmUp: false,
    ollamaUp: false,
  };
  try {
    const stats = await comfy.systemStats();
    out.comfyVersion = stats.system?.comfyui_version;
    out.gpuName = stats.system?.devices?.[0]?.name;
    out.comfyUp = true;
  } catch (e) {
    out.error = `ComfyUI is not reachable at ${comfy.baseUrl}. ${String(e)}`;
  }
  out.comfyRoot = comfyRoot;
  // Engine detail (model/loras/nodes) only makes sense when ComfyUI is up.
  if (out.comfyUp) {
    try {
      const presence = await nodePresence(comfy, true);
      out.nodes = { ...presence.nodes };
      if (presence.realismLora) out.nodes.hasRealismLora = true;
      const oi = await comfy.objectInfo(true);
      const combo = (cls: string, input: string): string[] => {
        const spec = oi[cls]?.input?.required?.[input] as unknown[] | undefined;
        if (!Array.isArray(spec) || !Array.isArray(spec[0])) return [];
        return (spec[0] as string[]).filter((s) => !["none", "None", "无", ""].includes(s));
      };
      out.models.fl2va = combo("MiniMaxH3EasyLoader", "fl2va_model");
      out.models.ref2va = combo("MiniMaxH3EasyLoader", "ref2va_model");
      out.models.textEncoder = combo("MiniMaxH3EasyLoader", "text_encoder");
      out.models.loras = combo("LoraLoaderModelOnly", "lora_name");
    } catch (e) {
      out.error = (out.error ? out.error + " " : "") + `Probe error: ${String(e)}`;
    }
  }

  // AI co-director provider reachability
  try {
    const { resolveAi, listProviderModels, ollamaUp } = await import("./ai");
    const resolved = resolveAi(settings);
    out.llmProvider = resolved.providerId;
    out.llmModel = resolved.model || undefined;
    if (resolved.isOllama) {
      out.ollamaUp = await ollamaUp(settings.ollamaUrl || "http://localhost:11434");
      out.llmUp = out.ollamaUp;
      if (out.ollamaUp) {
        const { listOllamaModels } = await import("./ai");
        const list = await listOllamaModels(settings.ollamaUrl || "http://localhost:11434");
        out.llmModels = list.map((m) => m.name);
        if (!out.llmModel || !out.llmModels.includes(out.llmModel)) {
          const pref = out.llmModels.find((m) => /qwen3(:|-)|qwen2|llama3|gemma3/i.test(m));
          out.llmModel = pref ?? out.llmModels[0];
        }
      }
    } else {
      if (resolved.baseUrl) {
        try {
          const ids = await listProviderModels(resolved.baseUrl, resolved.apiKey);
          out.llmUp = true;
          out.llmModels = ids;
          if (!out.llmModel || !ids.includes(out.llmModel)) out.llmModel = ids[0];
        } catch {
          out.llmUp = false;
        }
      }
    }
  } catch {
    out.llmUp = false;
  }
  return out;
}
