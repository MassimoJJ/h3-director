import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
export const FFMPEG = "ffmpeg";
export const FFPROBE = "ffprobe";

async function run(bin: string, args: string[], timeoutMs = 300_000): Promise<string> {
  const { stdout } = await execFileP(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export interface MediaInfo {
  durationS: number;
  width: number;
  height: number;
  fps: number;
  frames: number;
}

export async function probeVideo(file: string): Promise<MediaInfo> {
  const out = await run(
    FFPROBE,
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
      "-show_entries", "format=duration",
      "-of", "json", file,
    ],
  );
  const j = JSON.parse(out) as {
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; nb_frames?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const s = j.streams?.[0] ?? {};
  const fr = s.r_frame_rate?.split("/");
  const fps = fr && fr.length === 2 && Number(fr[1]) ? Number(fr[0]) / Number(fr[1]) : 24;
  return {
    durationS: Number(s.duration ?? j.format?.duration ?? 0),
    width: Number(s.width ?? 0),
    height: Number(s.height ?? 0),
    fps,
    frames: Number(s.nb_frames ?? Math.round((Number(s.duration ?? 0)) * fps)),
  };
}

/** Extract the exact last video frame as a PNG. */
export async function extractLastFrame(videoAbs: string, outPng: string): Promise<void> {
  const info = await probeVideo(videoAbs).catch(() => null);
  if (info && info.frames > 0) {
    const last = info.frames - 1;
    await run(
      FFMPEG,
      ["-y", "-i", videoAbs, "-vf", `select=eq(n\\,${last})`, "-frames:v", "1", outPng],
      180_000,
    );
    return;
  }
  // Fallback: seek near the very end.
  await run(FFMPEG, ["-y", "-sseof", "-0.05", "-i", videoAbs, "-frames:v", "1", "-update", "1", outPng], 180_000);
}

/** Extract the first video frame as a PNG thumbnail. */
export async function extractFirstFrame(videoAbs: string, outPng: string): Promise<void> {
  await run(FFMPEG, ["-y", "-i", videoAbs, "-frames:v", "1", outPng], 180_000);
}

export interface ConformResult {
  ok: boolean;
  reason?: string;
}

/**
 * Overwrite the first (or last) frame of a rendered clip with an exact keyframe image.
 *
 * Why this is needed: MiniMax H3 has no hard keyframe lock. comfy/ldm/minimax/model.py
 * packs keyframes into `PackedLayout` as extra "cond" token rows whose `img_update` is
 * all False, so the keyframe latent is *context only* - it is never written back into
 * the output latent. The model therefore re-generates frame 0 from the keyframe
 * (measured ~33 dB PSNR: same scene and composition, not the same pixels), which makes
 * a chained seam jump.
 *
 * For a director tool the seam has to be exact, so we conform it in post: the keyframe
 * is resampled exactly like the node does it (cover-scale + centre crop to the clip
 * canvas, comfy.utils.common_upscale(..., "center")) and swapped in, keeping the frame
 * count, the fps and the audio stream untouched.
 */
export async function conformFrame(
  videoAbs: string,
  framePng: string,
  outAbs: string,
  which: "first" | "last" = "first",
): Promise<ConformResult> {
  if (!fs.existsSync(framePng)) return { ok: false, reason: "keyframe image is missing" };
  const info = await probeVideo(videoAbs).catch(() => null);
  if (!info || !info.width || !info.height) return { ok: false, reason: "could not probe the rendered clip" };
  if (info.frames < 2) return { ok: false, reason: "clip has fewer than two frames" };

  const fps = info.fps > 0 ? info.fps : 24;
  const { width: w, height: h } = info;
  const keyStream =
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
    `format=yuv420p,trim=end_frame=1,setpts=PTS-STARTPTS[kf]`;
  const keepStream =
    which === "first"
      ? `[0:v]trim=start_frame=1,setpts=PTS-STARTPTS[rest]`
      : `[0:v]trim=end_frame=${Math.max(1, info.frames - 1)},setpts=PTS-STARTPTS[rest]`;
  const chain = which === "first" ? "[kf][rest]" : "[rest][kf]";

  try {
    await run(
      FFMPEG,
      [
        "-y",
        "-i", videoAbs,
        "-loop", "1", "-framerate", String(fps), "-i", framePng,
        "-filter_complex", `${keyStream};${keepStream};${chain}concat=n=2:v=1:a=0[v]`,
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outAbs,
      ],
      600_000,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 400) : String(e) };
  }
}

export async function concatVideos(files: string[], outAbs: string, fps = 24): Promise<void> {
  const listFile = `${outAbs}.concat.txt`;
  fs.writeFileSync(
    listFile,
    files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n"),
    "utf8",
  );
  try {
    await run(
      FFMPEG,
      [
        "-y", "-f", "concat", "-safe", "0", "-i", listFile,
        "-vf", `fps=${fps},format=yuv420p`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outAbs,
      ],
      1_800_000,
    );
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}
