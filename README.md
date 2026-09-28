# H3 Director Studio

A clean, local "director desk" for **MiniMax H3** video generation. No node canvas, no
prompt-hacking in ComfyUI â€” you get a real timeline editor (shots, first/last frames,
character/voice references, seamless long-video chaining) while your **existing ComfyUI
installation runs headless in the background as the render engine**.

Everything runs on models you already own â€” **nothing new is downloaded**.

---

## Quick start

Prerequisites: Node.js â‰¥ 20 and your ComfyUI instance running (this project drives
whichever ComfyUI is live on `http://127.0.0.1:8188`).

```bash
cd h3-director
npm install            # first run only
npm run build          # first run only (builds the web UI)
npm start              # opens http://127.0.0.1:8788
```

Or double-click `start.bat`.

The app auto-discovers the running ComfyUI folder (models + input dir). If you run
ComfyUI on another port/host, set it in **Settings** inside the app.

### Start automatically when Windows boots

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

This drops a shortcut in your Startup folder (no admin rights needed) and launches
the app hidden at every logon: ComfyUI is started first if it is not already
listening, then the backend on `http://127.0.0.1:8788`. A supervisor keeps it alive
and restarts it if it crashes. Useful commands:

```powershell
.\scripts\install-autostart.ps1 -Status     # what is installed / is it running
.\scripts\install-autostart.ps1 -Uninstall  # remove it again
.\scripts\start-h3-director.ps1             # start it now (same as the shortcut)
```

Run the installer from an elevated PowerShell and it additionally registers a
logon Scheduled Task.

Logs: `logs\autostart.log` (launcher decisions, `backend READY`, restarts),
`logs\backend.log` + `logs\backend.error.log` (the backend's own output) and
`logs\comfyui.log` (the engine's output - the engine itself still runs hidden).

At logon the launcher brings the backend up and **opens the UI in your browser** once it
answers, so the app is simply on screen when you sit down.

**ComfyUI is not started for you.** The engine is heavy (a few minutes and most of the
card's VRAM), so start it when you actually want to render - either the **Start** button
in the app's top bar, or `run_nvidia_gpu.bat` in the portable folder yourself. If the
engine *is* already running, the launcher only notes it, so it can never start a second
one. Add `-WithComfy` if you would rather boot the engine at logon too:

```powershell
.\scripts\start-h3-director.ps1 -Open            # app only - what the logon shortcut does
.\scripts\start-h3-director.ps1 -Open -WithComfy # app + ComfyUI engine
```

The launcher is idempotent and safe to run any time: it treats *an HTTP reply* rather
than a listening port as "up", it refuses to run twice at once, and it keeps supervising
the backend after a successful start, restarting it if it crashes.

`start.bat` calls exactly this, so double-clicking it and booting the PC do the same
thing. Work history, open items and the verification recipe live in `TASK_HISTORY.md`.

## What you can do

| Area | What it does |
| --- | --- |
| **Script / Timeline** | Shot list where each shot picks a mode â€” `t2v` (text), `i2v` (start image), `fl2v` (first **and** last frame locked), `r2v` (character / scene / voice references). Per-shot: prompt, duration, resolution/aspect, fps, steps, sampler/scheduler, seed, realism LoRA, Spectrum accelerator, sigma shift. |
| **Library** | Upload or import character sheets, location stills, motion clips and voice recordings. Tag roles (`character`, `voice`, `location`, â€¦) so the AI co-director and you can find them. |
| **Voice / dialogue** | Attach a voice clip to an `r2v` shot; H3 clones the voice for dialogue in one pass (a reference image of the speaker is required â€” H3 does not accept audio-only references). |
| **Seamless chaining** | "Continue from previous shot" extracts the previous shot's *exact last frame* and hard-locks it as the next shot's first frame (H3's FL2V positional keyframe). Verified frame-identical seams (PSNR â‰ˆ 37 dB). |
| **Queue** | Render whole projects or single shots, serial execution, live status, per-shot re-render, cancel. |
| **Gallery** | Every take with audio, accept/reject, seed info, the exact compiled prompt sent to H3. |
| **Export** | Concatenate the accepted take of each shot into a full movie (ffmpeg, 24 fps H.264/AAC). |
| **AI co-director** | Type a logline; a local LLM (LM Studio / Ollama, any OpenAI-compatible endpoint) writes the shot list â€” prompt, mode, duration, which library assets to use â€” and drops it into the timeline. |
| **Stills** | A scratchpad for Qwen Image 2.1 stills that are *not* attached to a shot. For a shot's own picture, use the still stage in the **Script** tab - that is the normal path. |

## The still stage (Qwen Image 2.1)

Every shot is a **two-stage pipeline**: first a picture is made with **Qwen Image 2.1** through
the same headless ComfyUI, then that picture is animated. Both stages live in the shot
inspector, so a shot is configured in one place instead of two.

### Stage 1 - make the picture

Each shot has a **still mode**:

- **No still** - skip stage 1 and go straight to video from the text prompt.
- **Text to image (`t2i`)** - Qwen writes the picture from a prompt. Leave the still prompt
  empty to reuse the shot's own prompt.
- **Image to image (`i2i`)** - Qwen edits one or more Library reference images; the prompt
  describes the *change*. The output follows the references' shape, so the canvas setting
  does not apply.

The still stage also holds canvas, steps, CFG, sampler/scheduler, seed policy, a **variants**
count (1-4 per run) and its own list of **takes**. Seed policy is per shot: `random` (a fresh
seed per take) or `fixed` (reproducible A/B of prompt-only changes).

**Rendering a still** appends takes, promotes the best one to the **Library**, and
automatically points the shot at it as its **first frame** - and flips a `t2v` shot to `i2v`,
because the video is now driven by an image. Click any later take to swap which one is used.

**Rendering the shot** (`Render` on the timeline) runs the whole pipeline: stage 1 generates the
still, then stage 2 animates it. A still generated in the same run is always the shot's real
first frame, so "continue from previous" is deliberately ignored for that shot rather than
silently overwriting the picture you just made.

Stills and their takes persist with the project. Older projects without a still stage load
unchanged and behave as **No still**.

### The Stills tab

The separate **Stills** tab keeps the older board-based workflow for images that are not part
of a shot - a look-development scratchpad. It no longer feeds the pipeline automatically:
to use a still from there, promote it to the **Library** and attach it as an `i2i` reference.


## How the engine works

The backend renders each shot as an **API-format ComfyUI prompt** over the
`MiniMaxH3EasyLoader â†’ MiniMaxH3Easy â†’ MiniMaxH3EasyOutput â†’ sampler â†’ VAE decode â†’
CreateVideo â†’ SaveVideo` chain â€” the same pipeline your `MiniMax_H3_Easy.json` workflow
uses. Media files are content-hashed and copied into `ComfyUI/input/h3director/â€¦`, so
reference numbering is exact and re-staging is free. Results are pulled back over
`/view` and stored under `data/outputs/`.

Capabilities and safe defaults:

- The engine uses `minimax_h3_fl2va_pruned_int8_convrot` (image mode / T2V) and
  `minimax_h3_ref2va_pruned_int8_convrot` (reference mode) with the Qwen3-VL-32B H3
  text encoder and both H3 VAEs â€” whatever your ComfyUI reports as available.
- Per-shot length is capped at **15 s** (H3's single-generation ceiling). Long films =
  multiple shots with seamless chaining.
- Prompts are handed to H3 exactly as written; canonical tags (`<Picture N>`,
  `<Audio N>`) are used for references, and a voice hint is appended automatically when
  a voice clip is attached.
- The KJNodes SageAttention patch is **not** auto-applied â€” it requires the optional
  `sageattention` pip package. Enable Spectrum (installed) instead when you want speed.
- Realism LoRA and Spectrum only apply when enabled on a shot and present on the engine.

## Data & settings

- `data/` â€” projects, asset library, outputs, exports, job log (git-ignored).
- `data/settings.json` â€” ComfyUI address/folder, VRAM purge toggle, LLM endpoint.
- The ComfyUI install itself is never modified; only `input/` and `output/` gain
  `h3director/â€¦` files while you render.

## Performance expectations

On an RTX 4090 (24 GB): roughly **1.5â€“4 minutes per shot** depending on resolution and
steps (16â€“20 steps, 360â€“480p â‰ˆ 60â€“120 s; 768p/2K â‰ˆ 4â€“5 min). A long project is a batch
you can leave running; use low-res + fewer steps for drafts, then re-render finals.

## Troubleshooting

- **"ComfyUI is not reachable"** â€” start ComfyUI first (`run_nvidia_gpu.bat`), then open
  Settings â†’ Refresh probe.
- **"ComfyUI folder not found"** â€” the app auto-detects the portable install from the
  running process. If it fails, paste the absolute path (â€¦`\ComfyUI`) into Settings.
- **Missing nodes** â€” the engine needs the `ComfyUI-MiniMaxH3-Easy` pack and stock core
  video nodes. Probe status in Settings lists what's missing.
- **Voice clip ignored / r2v refused** â€” H3 requires a visual reference alongside audio;
  attach a reference image of the speaker too.
- **AI co-director says no model** â€” point Settings at your local LLM (default
  `http://127.0.0.1:1234/v1` for LM Studio, `http://localhost:11434/v1` for Ollama) and
  pick a model id.
- **The still stage says Qwen is not ready** - it needs three Qwen Image model files in
  ComfyUI: the diffusion model, the text encoder and the VAE. The Stills header names
  whichever one is missing.
- **Image-to-image renders as a brand-new image** - no reference was attached. Add at least
  one Library image under the still stage; without references `i2i` has nothing to be
  faithful to, and falls back to a text-to-image render.
- **The canvas is greyed out** - expected in `i2i`. The output takes the shape of the
  reference image rather than the chosen canvas.
- **Black screen / blank page** - the front-end crashed before it could render; the backend
  may still be perfectly healthy (check `logs\backend.log` and that
  http://127.0.0.1:8788/api/status answers). A crash now shows its stack trace with a Reload
  button instead of a void, so a *completely* blank page means an older build: run
  `npm run build` and hard-refresh (Ctrl+F5). A cached `index.html` pointing at a bundle that
  a rebuild has replaced looks exactly like a dead app.

```
backend/   Node/TypeScript: Express API, ComfyUI client, engine (graph builder),
           render queue with chaining, ffmpeg assembly, AI co-director client
web/       React + Vite single-page UI (dark, video-editor style)
data/      runtime state (created on first start)
```

*MiniMax H3 is an open-weights model by MiniMax (see its Hugging Face repo for the
license). This app is an interface on top of ComfyUI + the ComfyUI-MiniMaxH3-Easy node
pack; it contains no model weights.*
