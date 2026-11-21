# Troubleshooting

Most failures are Discoverable from the **Settings -> Refresh probe** panel and the
logs in `logs/` and `data/logs/`. Work through this page before opening an issue.

---

## The app will not start

| Symptom | Check |
| --- | --- |
| `node is not recognized` | Install Node.js 20+, then open a **new** terminal so `PATH` refreshes |
| Port 8788 already in use | Another H3 Director backend is probably running; check Task Manager or use Settings to change `port` |
| Blank page | Run `npm run build`, then hard-refresh with `Ctrl+F5`; the backend serves `web/dist` |
| Page shows a stack trace and Reload button | The frontend crashed; the button reloads it. The stack trace is the useful bug-report detail |
| Backend starts then dies | Read `logs\backend.error.log` and `logs\autostart.log` |

Health check:

```text
http://127.0.0.1:8788/api/status
```

A JSON answer means the Express backend is alive even if the browser looks broken.

---

## ComfyUI problems

### "ComfyUI is not reachable"

Start ComfyUI first - `run_nvidia_gpu.bat` in the portable folder, or the **Start**
button in H3 Director's top bar - then press **Refresh probe** in Settings. ComfyUI
takes one to three minutes to load models, so a closed port during boot is normal.

### "ComfyUI folder not found"

The app discovers the portable root from the running Python process. If that fails,
paste the absolute folder that contains `ComfyUI\main.py` into **Settings -> ComfyUI
folder** and refresh. For the Windows launcher, `H3_COMFY_HOME` can point at the folder
containing `run_nvidia_gpu.bat`.

### Missing nodes

The probe lists missing classes. Required for video:

```text
MiniMaxH3EasyLoader, MiniMaxH3Easy, MiniMaxH3EasyOutput,
BasicGuider, BasicScheduler, KSamplerSelect, SamplerCustomAdvanced, RandomNoise,
VAEDecode, VAEDecodeAudio, CreateVideo, SaveVideo, LoadImage
```

Install `ComfyUI-MiniMaxH3-Easy` (Nightly) and update ComfyUI. Reference videos need
`VHS_LoadVideo` or `LoadVideo`; audio needs `LoadAudio` or `LoadAudioUI`. The app warns
and drops a reference when no loader exists rather than failing the whole render.

### "No Qwen3-VL text encoder is available"

Install the H3 text encoder into `ComfyUI/models/text_encoders/`. The still stage
separately needs `qwen_image_2.1*` diffusion model, `qwen3vl_8b*` text encoder and
`qwen_image_2.1_vae*` in the matching folders. See
[Installation, step 4](INSTALLATION.md#step-4-download-the-model-files).

### Render hangs or times out

Defaults are 25 minutes for video and 20 minutes for images. Raise
`renderTimeoutMin` / `imageTimeoutMin` in Settings for slow 2K or long shots. Check
`logs\comfyui.log` and the job's `data/logs/<jobId>.jsonl`. If ComfyUI is stuck, press
**Interrupt** or **Free memory** in Settings before retrying.

---

## Video and timeline problems

### Voice clip ignored / `r2v` refused

H3 does not accept audio-only references. Attach a reference image of the speaker as
well as the voice clip.

### Image-to-image renders as a brand-new image

The still stage had no reference images. Add at least one Library image under
`i2i`; with no references, Qwen has nothing to be faithful to and falls back to
text-to-image.

### The still canvas is greyed out

Expected in `i2i`. The output takes the shape of the reference image, so canvas
settings do not apply.

### A chained seam still jumps

Check that the previous shot's take was **accepted** and that the next shot has
"Continue from previous" enabled. A shot with a freshly generated still deliberately
ignores chaining. Inspect the cut frame by frame: frame 0 must be the previous shot's
exact final frame, and the next frames must keep moving while they morph into H3's
generated motion, with a single clean silhouette. If several consecutive frames are
pixel-identical, or the body appears doubled, the clip was made by an older conform
(frozen hold or plain crossfade) - re-render or re-conform it. If frame 0 itself
differs, the conform step failed - see the job log.

### The face changes between shots, even with a clean seam

The seam protects the first frame, not the identity. Bind a source portrait:
**Library → Project character** (then **Apply to all**) or **Source character —
identity lock** in the shot inspector. The lock attaches the portrait to Qwen stills and
to H3 as an identity-only `<Picture 2>` behind the seam frame, which is `<Picture 1>`
and is also written back as the exact first frame. If the shot has no seam or pinned
first frame, the portrait becomes `<Picture 1>` and also anchors the shot. If the timeline
tile has no
🔒 badge, the shot has no lock. If an older shot shows a warning about image mode,
re-select the character so the shot moves to `r2v` — image mode has no identity slot.
Use a sharp, front-facing source image; identity guidance is probabilistic, not a hash.

### The background or camera angle changes halfway through the shot

The seam is exact only at frame 0. In reference mode H3 keeps conditioning on all
pictures for the rest of the clip, so words like "camera following", "tracking", "zoom"
or "cut" can make it invent a new location while preserving the locked face. For an
identity-locked chained shot the engine now appends a location lock: keep `<Picture 1>`'s
environment, lighting and camera position for the whole shot, do not use `<Picture 2>`'s
background, and make no cut. Chained identity-locked shots also receive the previous
shot's tail clip (the 1.5s ending on the seam) as a `<Video N>` reference so the camera
and location are conditioned across time without reintroducing the source portrait. Remove conflicting camera directions from the shot prompt —
describe only the actor's expression and head movement. If you want a visible camera move,
turn the character lock off or accept that the location may change.

### Export used an old take

Fixed in the current code: export uses the newest accepted take via `acceptedTakeOf`.
If you see this on an older checkout, update and re-accept the intended take.

### A project disappeared from the picker

Do not delete the file yet. Look for `data/projects/<id>.json.bak` and read the job log.
Modern builds keep one previous generation and report corrupt reads on stderr instead
of silently returning "not found". Move the bad file aside, copy the `.bak` over it and
reload.

---

## AI co-director problems

### "No model" or provider error

Open **Settings -> AI**, choose a provider and pick a model. Local defaults:

- Ollama: `http://localhost:11434/v1`, model `qwen3:8b` (`ollama pull qwen3:8b`)
- LM Studio: `http://127.0.0.1:1234/v1`

Cloud providers need a key, entered in the app or supplied through the matching
environment variable (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROK_API_KEY`,
`OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `KILOCODE_API_KEY`, `CLINE_API_KEY`).
The browser only ever receives `last4` and a configured flag.

### The model returned prose instead of a shot list

The co-director retries without `response_format` for older endpoints and can extract
a JSON object from a markdown fence. Very small models still ignore the schema. Use a
larger local model or a cloud endpoint with JSON-mode support.

---

## Windows autostart problems

- **Nothing opens at logon**: run `powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1 -Status`.
- **Backend is up but no browser window**: check `logs\autostart.log` for `opening ...`
  and for Chrome profile warnings.
- **Wrong Chrome account received the link**: set `H3_CHROME_PROFILE` (for example
  `Profile 1`) or pass `-ChromeProfile`. Chrome's singleton hand-off yields to an
  already-running profile, so close other Chrome windows first if you need a specific
  identity.
- **Two ComfyUI engines started**: the launcher refuses a second start when a process
  owns `main.py` or when the port answers. Remove duplicate scheduled tasks/shortcuts
  if you installed more than once.

---

## Useful file locations

| File | What it tells you |
| --- | --- |
| `logs\autostart.log` | Launcher decisions, backend READY, restarts, browser opening |
| `logs\backend.log` | Backend stdout |
| `logs\backend.error.log` | Backend errors |
| `logs\comfyui.log` | Engine output when the launcher started it |
| `data\logs\<jobId>.jsonl` | Per-render events, warnings and errors |
| `data\outputs\<project>\<shot>\graph_<promptId>.json` | Exact graph submitted to ComfyUI |
| `data\settings.json` | Settings and provider keys - **do not publish** |

When reporting a bug, include the probe JSON from `/api/status`, the relevant job log,
the graph JSON if it was a render, and your Node/ComfyUI versions. Never paste API keys.
