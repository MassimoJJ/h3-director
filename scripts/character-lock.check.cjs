// Regression checks for the character-identity lock.
//
// Two failures this guards against:
//   1. Prepending an identity image shifts H3's <Picture N> tags. Without a
//      rewrite the director's prompt starts pointing at the wrong attachment.
//   2. Qwen's still encoder accepts references in both t2i and edit mode, but
//      only edit mode may sample from the encoder's latent — t2i must keep an
//      empty latent or an identity portrait would become the canvas.
//
//   npm run verify:character
//
// Pure functions only; no ComfyUI or GPU needed.
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const TMP = path.join(REPO, ".tmp", "character-lock-check");
process.env.H3_DATA_DIR = TMP;
process.env.H3_DATA = TMP;

const failures = [];
const pass = (m) => console.log("  ok   " + m);
const fail = (m) => { failures.push(m); console.log("  FAIL " + m); };
const check = (cond, m) => (cond ? pass(m) : fail(m));

(async () => {
  try {
    require(path.join(REPO, "node_modules", "tsx", "cjs", "api")).register();
  } catch { /* older tsx layout; the CLI shim handles it */ }
  fs.mkdirSync(TMP, { recursive: true });

  let types, engine, qwen, store;
  try {
    types = require(path.join(REPO, "backend", "src", "types.ts"));
    engine = require(path.join(REPO, "backend", "src", "engine.ts"));
    qwen = require(path.join(REPO, "backend", "src", "qwen.ts"));
    store = require(path.join(REPO, "backend", "src", "store.ts"));
  } catch (e) {
    console.error("Could not load backend TypeScript: " + e.message);
    console.error("Run this through tsx:  npx tsx scripts/character-lock.check.cjs");
    process.exit(2);
  }

  console.log("character identity lock\n");

  check(
    types.shiftPictureTags("Maria holds <Picture 1> beside <Picture 2>.", 2)
      === "Maria holds <Picture 3> beside <Picture 4>.",
    "prepended references renumber existing <Picture N> tags",
  );
  check(
    types.shiftPictureTags("<Audio 1> stays <Video 1> stays <Picture 1>", 1)
      === "<Audio 1> stays <Video 1> stays <Picture 2>",
    "audio/video tags are untouched by an image prepend",
  );

  const identity = { name: "Maria", picture: 2, pictureShift: 2, startPicture: 1, startIsChain: true };
  const compiled = engine.compilePrompt(
    "r2v",
    "Maria turns. <Picture 1> follows her.",
    0,
    "OLD GENERIC CONTINUATION",
    identity,
  );
  check(compiled.includes("<Picture 3> follows her."), "director's picture tag follows the two prepended references");
  check(compiled.includes("<Picture 2> is Maria."), "identity reference is named in the compiled prompt");
  check(compiled.includes("<Picture 1> is the exact final frame"), "continuity reference is the FIRST picture");
  check(compiled.includes("Do not copy its pose, framing, background or expression into the first frame"), "portrait is explicitly forbidden from becoming frame 0");
  check(!compiled.includes("OLD GENERIC CONTINUATION"), "generic continuation text is not stacked on an identity lock");
  const pinned = engine.compilePrompt("r2v", "Maria at the door.", 0, undefined, {
    ...identity, startIsChain: false,
  });
  check(pinned.includes("this shot's starting image"), "a pinned first frame is not misreported as a previous shot");

  const shot = {
    id: "locktest", name: "Shot", kind: "r2v", prompt: compiled,
    imageIds: [], videoIds: [], audioIds: [], firstFrameId: null, lastFrameId: null,
    continueFromPrev: false, seconds: 5, fps: 24, resolution: "480P", aspect: "16:9",
    width: 1344, height: 768, steps: 20, sampler: "euler", scheduler: "simple",
    refImageSize: "match", loraStrength: 0, sigmaShiftVideo: null, sigmaShiftAudio: null,
    spectrum: false, takes: [],
  };
  const models = { fl2va: "none", ref2va: "ref.safetensors", textEncoder: "clip.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };
  const presence = { nodes: { LoadImage: true, MiniMaxH3EasyLoader: true, MiniMaxH3Easy: true, MiniMaxH3EasyOutput: true }, realismLora: null };
  const graph = engine.buildGraph(shot, models, {
    imageRefs: [], refImages: ["seam.png", "identity.png"], refVideos: [], refAudios: [], keyframeRole: "first",
  }, 1, presence, compiled);
  const p = graph.apiPrompt;
  check(p.ref_img_0?.inputs?.image === "seam.png", "continuity frame is wired as the FIRST picture reference");
  check(p.ref_img_1?.inputs?.image === "identity.png", "identity portrait is wired as the second picture reference");
  check(p.easy?.inputs?.media_1?.[0] === "ref_img_0" && p.easy?.inputs?.media_2?.[0] === "ref_img_1", "reference order reaches the H3 node");
  check(p.easy?.inputs?.mode === "reference", "identity-locked shot uses H3 reference mode");

  // The real ordering bug lived in planShot, not in buildGraph: the portrait used
  // to be prepended before the seam frame, so H3 built frame 0 from the portrait.
  const inputDir = path.join(TMP, "input");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(path.join(TMP, "library"), { recursive: true });
  const portraitFile = path.join(TMP, "portrait-source.png");
  const seamFile = path.join(TMP, "previous-last-frame.png");
  fs.writeFileSync(portraitFile, "portrait bytes");
  fs.writeFileSync(seamFile, "seam bytes");
  const portrait = store.addAsset({ name: path.basename(portraitFile), absSrc: portraitFile, kind: "image", role: "character" });
  const planned = await engine.planShot({
    project: { id: "lockplan", shots: [] },
    shot: { ...shot, id: "lockplan-shot", characterId: portrait.id, kind: "r2v", firstFrameId: null, continueFromPrev: true, prompt: "She looks around." },
    models,
    seed: 2,
    comfyInputDir: inputDir,
    comfy: {},
    extraRefImageOverride: seamFile,
    r2vContinuationText: undefined,
  }, presence);
  const q0 = planned.plan.apiPrompt.ref_img_0?.inputs?.image || "";
  const q1 = planned.plan.apiPrompt.ref_img_1?.inputs?.image || "";
  check(q0.includes("previous-last-frame"), "planShot puts the seam frame in <Picture 1>");
  const portraitStem = path.basename(portrait.file, path.extname(portrait.file));
  check(q1.includes(portraitStem) && q1 !== q0, "planShot puts the identity portrait in <Picture 2>");
  check(planned.plan.compiledPrompt.includes("<Picture 2> is portrait-source."), "compiled prompt points identity at the second picture");
  check(planned.plan.compiledPrompt.includes("<Picture 1> is the exact final frame"), "compiled prompt points the start at the first picture");
  check(planned.plan.keyframes.first === seamFile, "seam frame is also a conformance keyframe, so frame 0 is overwritten exactly");

  const baseImage = {
    prompt: "Maria at the gallery", negativePrompt: "", width: 1024, height: 1024,
    steps: 20, cfg: 4, sampler: "euler", scheduler: "simple", seed: 1,
    enhancePrompt: false, cacheDevice: "auto", cacheDtype: "default",
    models: { unet: "u.safetensors", clip: "c.safetensors", vae: "v.safetensors", clipEnhancer: null },
    nodes: { TextEncodeQwenImage21: true },
  };
  const t2i = qwen.buildImageGraph({ ...baseImage, mode: "t2i", references: ["identity.png"] });
  check(!!t2i.apiPrompt.ref_0 && t2i.apiPrompt.ref_0.class_type === "LoadImage", "t2i still receives the identity image");
  check(!!t2i.apiPrompt.emptyLatent, "t2i still keeps an empty latent, not the portrait's canvas");
  check(t2i.apiPrompt.sampler.inputs.latent_image?.[0] === "emptyLatent", "t2i samples from the requested canvas");

  const edit = qwen.buildImageGraph({ ...baseImage, mode: "edit", references: ["source.png", "identity.png"] });
  check(!edit.apiPrompt.emptyLatent, "edit still does not add a second empty latent");
  check(edit.apiPrompt.sampler.inputs.latent_image?.[0] === "encode" && edit.apiPrompt.sampler.inputs.latent_image?.[1] === 2, "edit samples from the encoder latent built on the source image");
  check(types.identityRuleForQwen(2, "Maria").includes("Reference image 2 shows Maria."), "still identity instruction names the correct reference");

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n" + (failures.length ? `${failures.length} check(s) failed` : "all character-lock checks passed"));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
