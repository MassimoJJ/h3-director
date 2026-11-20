# Installation

This guide assumes a Windows machine with an NVIDIA GPU and a ComfyUI portable install.
The app itself is small; the heavy part is the model set you already use with ComfyUI.

> The repository contains **no model weights**. You download weights once into your
> ComfyUI folders. H3 Director only reads them through ComfyUI.

---

## Requirements

| Requirement | Minimum | Notes |
| --- | --- | --- |
| Node.js | 20 LTS or newer | `node --version` to check. 22.x is fine. |
| npm | ships with Node | Workspaces are used; install at the repository root. |
| ComfyUI | recent build with Qwen Image 2.1 nodes | H3 Easy asks for ComfyUI 0.45.0+ for image workflows. |
| GPU | NVIDIA, ideally 24 GB VRAM for the int8 H3 set | Lower VRAM needs smaller/quantised variants and slow renders. |
| ffmpeg / ffprobe | any recent build | Must be on `PATH`. Verify with `ffmpeg -version`. |
| Disk | tens of GB | H3 and Qwen weights are large; leave headroom for outputs. |
| Local LLM (optional) | Ollama, LM Studio or any OpenAI-compatible URL | Only needed for the AI co-director. |

---

## Step 1 - Install Node.js

Download from https://nodejs.org/ and install the LTS branch. Verify:

```powershell
node --version
npm --version
```

---

## Step 2 - Install ComfyUI portable

If you do not already have it, download the latest portable NVIDIA build from
https://github.com/comfyanonymous/ComfyUI/releases and unpack it somewhere stable,
for example:

```text
C:\AI\ComfyUI_windows_portable\
  run_nvidia_gpu.bat
  python_embeded\
  ComfyUI\
    main.py
    models\
    custom_nodes\
```

Start it once with `run_nvidia_gpu.bat` and confirm `http://127.0.0.1:8188` answers.
Leave it running while you set up the rest.

---

## Step 3 - Install the ComfyUI node packs

The compiled H3 graph uses `MiniMaxH3EasyLoader`, `MiniMaxH3Easy` and
`MiniMaxH3EasyOutput` from **ComfyUI-MiniMaxH3-Easy**:

```powershell
cd C:\AI\ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy.git
```

If you use ComfyUI Manager instead, search for `ComfyUI-MiniMaxH3-Easy` and choose the
**Nightly** version - the stable package can lag behind the repository.

Restart ComfyUI after installing. Optional packs the app detects but does not require:

| Pack | Used for | Behaviour if missing |
| --- | --- | --- |
| VideoHelperSuite (`VHS_LoadVideo`) | reference video loading | App falls back to `LoadVideo`, then warns and drops the video |
| `comfyui-spectrum-minimax-h3` | Spectrum speed toggle | Toggle is ignored |
| Realism LoRA in `models/loras` | realism strength slider | Slider is ignored |
| `sageattention` pip package | KJNodes SageAttention patch | **Never auto-applied**; enabling it without the package aborts renders |

The Qwen Image 2.1 still stage uses stock ComfyUI nodes
(`UNETLoader`, `CLIPLoader`, `VAELoader`, `TextEncodeQwenImage21`, `QwenImage21Cache`),
so a recent ComfyUI is enough.

---

## Step 4 - Download the model files

### H3 video models

Source: https://huggingface.co/Comfy-Org/MiniMax-H3
License: https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE

| Role | Example filename used here | Destination under `ComfyUI/` |
| --- | --- | --- |
| FL2VA transformer (image / text modes) | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| Ref2VA transformer (character/voice mode) | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` |
| Text encoder | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | `models/text_encoders/` |
| Video VAE | `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` |
| Audio VAE | `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` |

The repository also offers bf16, fp8 and nvfp4 variants. Pick the set that fits your
VRAM; the app reads the available choices from ComfyUI rather than hard-coding names.

### Qwen Image 2.1 still models

Source: https://huggingface.co/Comfy-Org/Qwen-Image-2.1
License: https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE

| Role | Example filename used here | Destination under `ComfyUI/` |
| --- | --- | --- |
| Diffusion model | `qwen_image_2.1_bf16.safetensors` | `models/diffusion_models/` |
| Text encoder | `qwen3vl_8b_bf16.safetensors` | `models/text_encoders/` |
| VAE | `qwen_image_2.1_vae_bf16.safetensors` | `models/vae/` |

The still stage is optional per shot (`No still` skips it), but the normal shot
workflow uses it, so install these three unless you only ever render text-to-video.

### Manual download

Open each Hugging Face page, use **Files and versions**, download the files above and
place them in the matching `ComfyUI/models/...` folder. The filenames must stay intact:
the app matches model names by substring, so renaming them can break detection.

### CLI download

With `hf` available (`pip install -U huggingface_hub`), run from anywhere and point
`--local-dir` at the **ComfyUI folder** - the repository paths already include the
`diffusion_models/`, `text_encoders/` and `vae/` subfolders:

```powershell
$comfy = "C:\AI\ComfyUI_windows_portable\ComfyUI"

hf download Comfy-Org/MiniMax-H3 `
  diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors `
  diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors `
  text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors `
  vae/minimax_h3_video_vae_fp16.safetensors `
  vae/minimax_h3_audio_vae_fp32.safetensors `
  --local-dir $comfy

hf download Comfy-Org/Qwen-Image-2.1 `
  diffusion_models/qwen_image_2.1_bf16.safetensors `
  text_encoders/qwen3vl_8b_bf16.safetensors `
  vae/qwen_image_2.1_vae_bf16.safetensors `
  --local-dir $comfy
```

Restart ComfyUI after adding model files.

---

## Step 5 - Install ffmpeg

```powershell
winget install Gyan.FFmpeg
```

Or download a build from https://ffmpeg.org/download.html and add its `bin` folder to
`PATH`. Verify in a **new** terminal:

```powershell
ffmpeg -version
ffprobe -version
```

The app uses `ffprobe` for clip metadata, `ffmpeg` to extract exact first/last frames
and to concatenate accepted takes into the final MP4.

---

## Step 6 - Install and start H3 Director

```powershell
git clone https://github.com/MassimoJJ/h3-director.git
cd h3-director
npm install
npm run build
npm start
```

Open **http://127.0.0.1:8788**.

On Windows, `start.bat` does the same and keeps a supervisor alive: it installs
dependencies if `node_modules` is missing, builds `web/dist` if missing, then calls
`scripts\start-h3-director.ps1 -Open`.

> `npm run build` is required at least once. The backend serves the compiled UI from
> `web/dist`; without it the page can look blank or load a stale bundle.

---

## Step 7 - Verify the connection

1. ComfyUI must be running.
2. In H3 Director, open **Settings** and look at the probe panel.
3. It should show ComfyUI up, GPU name, required nodes present and model choices.
4. If the folder was not found, paste the absolute path that contains `ComfyUI\main.py`
   into **ComfyUI folder** and press **Refresh probe**.
5. Check `/api/status` directly if needed: `http://127.0.0.1:8788/api/status`.

A `ComfyUI offline` badge in the top bar is expected when the engine is not running;
the app itself still works for editing.

---

## Optional - AI co-director

Open **Settings -> AI**. Choose a provider and model. Local options need no API key:

| Provider | Default base URL | Suggested model |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | `qwen3:8b` (pull with `ollama pull qwen3:8b`) |
| LM Studio | `http://127.0.0.1:1234/v1` | whatever you have loaded |

Cloud providers (OpenAI, Gemini, Grok, OpenRouter, OpenCode, KiloCode, Cline) use
OpenAI-compatible chat endpoints. Keys can be entered in the app or supplied via the
environment variables listed in `backend/src/providers.ts`. The browser only receives
metadata - `last4`, provider label and a `configured` flag - never the key itself.

---

## Optional - start with Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-autostart.ps1
```

This installs a per-user Startup shortcut and, when run elevated, a logon Scheduled
Task. At logon it starts the backend, waits for an HTTP reply, then opens the UI.
ComfyUI is **not** started unless you pass `-WithComfy`.

Useful commands:

```powershell
.\scripts\install-autostart.ps1 -Status
.\scripts\install-autostart.ps1 -Uninstall
.\scripts\start-h3-director.ps1 -Open
.\scripts\start-h3-director.ps1 -Open -WithComfy
```

The launchers locate the repository from their own script path, so moving the folder
does not break them. If ComfyUI auto-discovery fails, set `H3_COMFY_HOME` to the folder
containing `run_nvidia_gpu.bat`. If you want a fixed Chrome profile, set
`H3_CHROME_PROFILE` (for example `Profile 1`) or pass `-ChromeProfile`.

Logs are written to `logs\autostart.log`, `logs\backend.log`,
`logs\backend.error.log` and, when the launcher starts the engine,
`logs\comfyui.log`.

---

## Upgrading

```powershell
cd h3-director
git pull
npm install
npm run build
```

Restart the backend. Your projects, Library and outputs live in `data/` and are
git-ignored, so a pull never overwrites them.

---

## Removing the app

1. Run `.\scripts\install-autostart.ps1 -Uninstall` if autostart was installed.
2. Stop the backend process or reboot.
3. Delete the repository folder.

Before deleting, copy `data/projects`, `data/library` and `data/outputs` if you want to
keep your work. `data/settings.json` may contain API keys you entered - treat it as a
secret and do not publish it.
