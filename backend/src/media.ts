import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ComfyClient } from "./comfy";
import { DATA_DIR } from "./settings";

const execFileP = promisify(execFile);

export function absData(rel: string): string {
  return path.join(DATA_DIR, rel);
}

export function sha1File(file: string): string {
  const h = crypto.createHash("sha1");
  h.update(fs.readFileSync(file));
  return h.digest("hex").slice(0, 12);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 90);
}

/** Discover the running portable ComfyUI install by locating the python process that launched main.py. */
export async function discoverComfyRoot(): Promise<string> {
  const ps = "powershell";
  const script =
    "(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'python*' -and $_.CommandLine -like '*ComfyUI*main.py*' } | Select-Object -First 1 -ExpandProperty ExecutablePath)";
  try {
    const { stdout } = await execFileP(ps, ["-NoProfile", "-Command", script], { timeout: 15000 });
    const exe = stdout.trim();
    if (!exe) return "";
    const pythonDir = path.dirname(exe); // <root>/python_embeded
    const root = path.dirname(pythonDir);
    const comfy = path.join(root, "ComfyUI");
    if (fs.existsSync(path.join(comfy, "main.py"))) return comfy;
    return "";
  } catch {
    return "";
  }
}

export interface StagedMedia {
  inputRel: string; // filename relative to ComfyUI/input, e.g. "h3director/<projectId>/<name>"
  stagedAbs: string; // absolute path inside ComfyUI/input
}

export interface MediaStager {
  comfyInputDir: string; // absolute path to ComfyUI/input
  uploadImage: (srcAbs: string) => Promise<StagedMedia>; // fallback when input dir is unknown
}

/**
 * Stage local media files (library assets or generated frames) into the ComfyUI input
 * directory so loader nodes can reference them by filename. Names are content-hashed,
 * so re-staging the same bytes is free and never overwrites another file.
 */
export async function stageFiles(
  comfyInputDir: string,
  projectId: string,
  files: Array<{ abs: string; kind: "image" | "audio" | "video" }>,
): Promise<Map<string, StagedMedia>> {
  const out = new Map<string, StagedMedia>();
  const dir = path.join(comfyInputDir, "h3director", projectId);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    if (!fs.existsSync(f.abs)) throw new Error(`Media file missing: ${f.abs}`);
    const hash = sha1File(f.abs);
    const name = `${hash}_${sanitize(path.basename(f.abs))}`;
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(f.abs, dest);
    }
    out.set(f.abs, { inputRel: `h3director/${projectId}/${name}`, stagedAbs: dest });
  }
  return out;
}

/** Upload an image to ComfyUI via /upload/image (used when the input dir is unknown). */
export async function uploadImage(comfy: ComfyClient, srcAbs: string): Promise<StagedMedia> {
  const buf = fs.readFileSync(srcAbs);
  const form = new FormData();
  const name = `${sha1File(srcAbs)}_${sanitize(path.basename(srcAbs))}`;
  form.append("image", new Blob([new Uint8Array(buf)]), name);
  form.append("subfolder", "h3director");
  form.append("overwrite", "true");
  const res = await fetch(`${comfy.baseUrl}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ComfyUI image upload failed: ${res.status}`);
  const j = (await res.json()) as { name?: string; subfolder?: string };
  const sub = j.subfolder ? `${j.subfolder}/${j.name ?? name}` : (j.name ?? name);
  return { inputRel: sub, stagedAbs: "" };
}
