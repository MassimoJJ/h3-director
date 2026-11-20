# Architecture

This document explains what actually happens between pressing **Render** and getting an
MP4. It is meant for contributors and for anyone integrating with the app.

---

## Components

| File | Responsibility |
| --- | --- |
| `web/src/App.tsx`, `web/src/views.tsx` | React UI: timeline, Library, Gallery, Settings, Stills board |
| `web/src/api.ts` | Typed REST client and WebSocket listener |
| `backend/src/app.ts` | Express routes, status probe, settings/keys API, project/asset CRUD |
| `backend/src/main.ts` | HTTP server, `/ws` hub, heartbeat, orphan-job recovery |
| `backend/src/comfy.ts` | Small REST client for `/object_info`, `/prompt`, `/history`, `/view`, `/free`, `/interrupt` |
| `backend/src/engine.ts` | Compiles one shot into an API-format H3 prompt |
| `backend/src/qwen.ts` | Compiles a Qwen Image 2.1 still into an API-format prompt |
| `backend/src/queue.ts` | Serial render/image queues, chaining, take promotion, export |
| `backend/src/ffmpeg.ts` | Frame extraction, exact keyframe conforming, concat |
| `backend/src/media.ts` | ComfyUI root discovery, content-hashed media staging |
| `backend/src/store.ts` | Atomic JSON writes, backup recovery, job log upserts |
| `backend/src/settings.ts` | Data directories, settings normalization, public redaction |
| `backend/src/providers.ts`, `ai.ts`, `director.ts` | AI provider catalog, endpoint resolution, shot-list generation |

There is no database. Runtime state is JSON under `data/`.

---

## Request flow for one shot

```text
UI: POST /api/projects/:id/render
  -> Director.enqueueRender(projectId, shotIds, forceChain)
  -> RenderJob written to data/jobs.json, event "job" on /ws
  -> pumpRender() starts the job if no other render is active
       |
       +-- stage 1 (optional): renderShotStill()
       |     qwen.ts -> ComfyUI /prompt -> /history -> /view
       |     take saved under data/images/, chosen take promoted to Library
       |     and attached as the shot's first frame
       |
       +-- stage 2: buildH3Graph()
       |     engine.ts -> ComfyUI /prompt
       |     poll /history until done, with configurable timeout
       |     collect video + audio outputs via /view
       |     save take under data/outputs/<project>/<shot>/
       |
       +-- optional seam conform via ffmpeg.ts
       |
       +-- event "shotDone" + "jobDone"; UI shows the take in Gallery
```

Renders are **serial**. One active render at a time keeps VRAM predictable and makes
chaining deterministic. Image/still jobs have their own queue so a still render does
not block a video job incorrectly.

---

## The H3 graph

`buildH3Graph()` produces an API-format prompt (node ids -> `class_type` + `inputs`).
The shape is the same as the `MiniMax_H3_Easy.json` workflow:

```text
LoadImage / VHS_LoadVideo / LoadAudio     (staged reference media)
                 |
MiniMaxH3EasyLoader  ->  MiniMaxH3Easy  ->  MiniMaxH3EasyOutput
                              |
        optional MiniMaxH3SigmaShift
        optional LoraLoaderModelOnly
        optional SpectrumApplyMiniMaxH3
                              |
     RandomNoise + KSamplerSelect + BasicScheduler + BasicGuider
                              |
                  SamplerCustomAdvanced
                              |
        VAEDecode (video)  +  VAEDecodeAudio (audio)
                              |
                  CreateVideo  ->  SaveVideo (mp4, h264)
```

Key details:

- `t2v`, `i2v` and `fl2v` use the **FL2VA** transformer and image mode. `r2v` uses the
  **Ref2VA** transformer and reference mode.
- Text is passed through as written. Canonical reference tags are `<Picture N>`,
  `<Video N>` and `<Audio N>` in reference mode; a voice hint is appended when audio is
  attached. The prompt optimizer inside the node pack is disabled so prompts are
  reproducible.
- A **character lock** orders the H3 references deliberately: the seam/pinned start
  frame is `<Picture 1>` when one exists (H3 builds frame 0 from the first picture, and
  the engine also conforms frame 0 to the exact seam), the source portrait follows as
  `<Picture 2>` and is described in the prompt as identity-only, and an optional last
  frame comes next. The compiled prompt also locks the seam frame's environment, lighting
  and camera position for the **entire** shot and forbids the portrait's background, which
  stops H3 from generating a new room when the director's prompt mentions camera movement.
  A chained `r2v` shot also stages a short **tail clip** of the previous shot (ending on
  the seam frame) as an extra `<Video N>` reference. The full clip is never used: its
  opening frame may be the source portrait, which H3 would copy a fraction of a second
  into the new shot. One of the three video slots is reserved for the tail. Without a start frame, the portrait is `<Picture 1>` and also acts
  as the visual anchor. `shiftPictureTags()` renumbers any `<Picture N>` the director
  already wrote before the prompt is submitted; the stored prompt is never changed. The
  MiniMax H3 Easy node accepts only two images in image mode, so attaching a character
  forces `r2v` (which permits nine).
- Shot duration is clamped through one shared constant: `MIN_SHOT_SECONDS = 0.5`,
  `MAX_SHOT_SECONDS = 15`. The UI receives those limits from the backend so the drag
  handle cannot ask for a duration the engine will reject.
- Reference caps are enforced in the engine: **9 images, 3 videos, 3 audio** files per
  shot. Extra files are dropped with a warning recorded in the job log.
- The KJNodes SageAttention patch is deliberately **not** applied. It needs an optional
  pip package; auto-applying it would abort renders on installs that lack it.
- Every submitted graph is saved beside the take as
  `data/outputs/<project>/<shot>/graph_<promptId>.json`, which makes a failed or
  surprising render reproducible.

---

## The Qwen Image 2.1 still stage

`qwen.ts` flattens the stock ComfyUI templates `image_qwen_image_2_1_t2i` and
`image_qwen_image_2_1_image_edit` into the same API-format prompt style:

```text
UNETLoader (qwen_image_2.1)
CLIPLoader (qwen3vl_8b)
VAELoader  (qwen_image_2.1_vae)
        |
TextEncodeQwenImage21  <- prompt, plus reference images (identity + edit sources)
        |
optional QwenImage21Cache (device/dtype configurable per board or shot)
        |
 KSampler -> VAEDecode -> SaveImage (filename_prefix h3director/qwen)
```

- Canvas dimensions are snapped to multiples of 16, which the Qwen VAE requires.
- `t2i` writes a picture from the prompt; an empty still prompt falls back to the
  shot's own prompt. A character-locked portrait is added as reference 1, but the KSampler
  still uses `EmptyLatentImage` — identity follows the conditioning, the canvas stays the
  director's choice.
- `i2i` (called `edit` in the data model) uses Library images as references. With no
  references it degrades to text-to-image and records a warning. The image being edited
  stays first so the encoder's latent keeps its framing; a locked character is appended
  after it and named by its reference number in the compiled prompt.
- Boards created in the Stills tab carry their own `characterId`; shot still stages
  inherit the shot's lock.
- Variants 1-4 are supported. Seeds can be random per take or fixed for A/B testing.
- Rendering a still appends a take, promotes the chosen one to the Library and points
  the shot at it as its first frame. A `t2v` shot flips to `i2v` at that point.
- Rendering the whole shot runs stage 1 and stage 2 in one job. A still made in that
  run wins over "continue from previous", so the picture just generated is not
  silently overwritten.

Older projects without a `still` block load unchanged and behave as `none`.

---

## Media staging

ComfyUI loader nodes address files relative to `ComfyUI/input`. `media.ts` copies
every referenced file into:

```text
ComfyUI/input/h3director/<projectId>/<sha1>_<sanitized original name>
```

The SHA-1 prefix means the same bytes always map to the same staged name. Re-staging
is free and one project can never overwrite another project's media. If the ComfyUI
folder is unknown, the app falls back to `/upload/image`.

Results are pulled back with `/view` and stored under `data/outputs/`; nothing is left
only in ComfyUI's own output folder.

---

## Why seams need ffmpeg

MiniMax H3 does not hard-lock keyframes. The model packs keyframes as extra conditioning
tokens whose `img_update` is false, so the keyframe latent is context only. Measured
behaviour: frame 0 is regenerated from the keyframe at about 33 dB PSNR - the same
composition, but not the same pixels. That produces a visible jump between shots.

For a director tool the seam must be exact, so `conformFrame()`:

1. probes the rendered clip for width, height, fps and frame count;
2. resamples the keyframe exactly like the node does - cover-scale, centre crop,
   `yuv420p`;
3. holds that image for 6 frames, then dissolves into the generated motion over the
   next 12 frames (a one-frame swap alone still jumped at frame 1, measured 17.9 dB
   PSNR between frames 0 and 1);
4. keeps the frame count, fps and audio stream;
5. re-encodes with `libx264 -crf 16`, `aac 192k` and `+faststart`.

This is why **Seamless chain** produces frame-identical cuts instead of merely
similar-looking ones. It also means ffmpeg is a hard requirement, not a convenience.

---

## Persistence and data safety

| Path | Content |
| --- | --- |
| `data/projects/<id>.json` | Project, shots, takes, still stages, boards |
| `data/projects/<id>.json.bak` | One previous generation of each project |
| `data/library.json` | Asset index; media under `data/library/` |
| `data/jobs.json` | Render and image job records |
| `data/logs/<jobId>.jsonl` | Timestamped per-job events, warnings and errors |
| `data/outputs/` | Videos and saved compiled graphs |
| `data/images/` | Generated stills and board takes |
| `data/exports/` | Final concatenated MP4s |
| `data/settings.json` | ComfyUI URL/root, ports, timeouts, LLM providers and keys |

`writeJsonAtomic()` writes a sibling `.tmp`, copies the previous good file to `.bak`,
then `renameSync`s into place. A crash therefore leaves either the old or the new
complete file, never a truncated one. Corrupt reads are reported on stderr and counted
rather than silently returning an empty project.

Project saves are debounced by half a second in the UI. Anything that needs the saved
copy - rendering, exporting, switching project, closing the tab - flushes pending
edits first, so what you see is what renders.

The entire `data/` directory is git-ignored. `publicSettings()` strips key material
before settings reach the browser: only provider label, base URL, `last4` and a
`configured` boolean are exposed.

---

## Settings and provider resolution

`settings.ts` normalizes old settings formats into the current multi-provider shape.
The AI co-director resolves its endpoint in this order:

1. stored key for the selected provider;
2. matching environment variable (`OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.);
3. built-in default base URL and default model for that provider.

Ollama is special: it uses `ollamaUrl` with `/v1` appended and needs no key. Cline's
`/models` endpoint omits ClinePass subscription models, so `ai.ts` merges those ids
back into the list.

---

## Limits and known boundaries

- One shot is at most 15 seconds; long films are multiple shots.
- Renders are serial; there is no distributed or parallel queue.
- The app is Windows-oriented for the launcher/autostart scripts. The Node server and
  React UI themselves are not Windows-only.
- No model weights are bundled. Licences of the underlying models still apply.
- The app does not modify the ComfyUI install; it only adds files under
  `ComfyUI/input/h3director/`.
