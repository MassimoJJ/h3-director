// Start / stop the local ComfyUI engine from the H3 Director backend.
// ComfyUI is normally launched by double-clicking run_nvidia_gpu.bat in the
// portable folder; this module does the same thing as a background process
// (or kills whatever is listening on the configured port).

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let spawnedPid: number | null = null;

export interface ComfyStartResult {
  started: boolean;
  alreadyRunning?: boolean;
  launcher?: string;
  pid?: number;
  error?: string;
}

export interface ComfyStopResult {
  ok: boolean;
  error?: string;
}

function portOf(url: string): number {
  try {
    return Number(new URL(url).port) || 8188;
  } catch {
    return 8188;
  }
}

interface Launcher {
  cmd: string;
  args: string[];
  cwd: string;
  label: string;
}

/** Find how to launch this ComfyUI install. `comfyRoot` = folder with main.py. */
export function launcherFor(comfyRoot: string, port: number): Launcher | null {
  if (!comfyRoot) return null;
  // Locate the folder that contains main.py. Accept either the ComfyUI folder
  // itself or the portable root that wraps it (…/ComfyUI_windows_portable).
  let comfyDir = comfyRoot;
  if (!fs.existsSync(path.join(comfyDir, "main.py"))) {
    const nested = path.join(comfyRoot, "ComfyUI", "main.py");
    if (fs.existsSync(nested)) comfyDir = path.join(comfyRoot, "ComfyUI");
    else return null;
  }
  const mainPy = path.join(comfyDir, "main.py");
  const portableRoot = path.dirname(comfyDir); // run_*.bat + python_embeded live here in a standalone build
  const python = path.join(portableRoot, "python_embeded", "python.exe");

  // 1) Preferred: the exact batch file the user would double-click.
  //    Only used for the default 8188 port (the .bat hardcodes it).
  if (port === 8188) {
    for (const name of ["run_nvidia_gpu.bat", "run_cpu.bat"]) {
      const bat = path.join(portableRoot, name);
      if (fs.existsSync(bat)) {
        return { cmd: "cmd.exe", args: ["/c", bat], cwd: portableRoot, label: name };
      }
    }
  }
  // 2) The bundled python, like the .bat does (supports a custom --port).
  const args = ["-s", mainPy, "--windows-standalone-build"];
  if (port !== 8188) args.push("--port", String(port));
  if (fs.existsSync(python)) {
    return { cmd: python, args, cwd: portableRoot, label: "python_embeded\\python.exe" };
  }
  // 3) System python as a last resort.
  return { cmd: "python", args: [mainPy, ...(port !== 8188 ? ["--port", String(port)] : [])], cwd: portableRoot, label: "python" };
}

/** Launch ComfyUI in its own console window. Returns once the process spawned. */
export async function startComfy(
  comfyRoot: string,
  comfyUrl: string,
  isUp: () => Promise<boolean>,
): Promise<ComfyStartResult> {
  const port = portOf(comfyUrl);
  if (await isUp()) return { started: false, alreadyRunning: true };
  const L = launcherFor(comfyRoot, port);
  if (!L) {
    return {
      started: false,
      error: `Could not find a ComfyUI install at "${comfyRoot || "(unset)"}". In Settings set “ComfyUI folder” to the folder that contains ComfyUI\\main.py.`,
    };
  }
  try {
    const child = spawn(L.cmd, L.args, { cwd: L.cwd, detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {
      // e.g. cmd.exe/python missing — surfaced via the up-poll timing out.
    });
    spawnedPid = child.pid ?? null;
    child.unref();
    return { started: true, launcher: L.label, pid: child.pid };
  } catch (e) {
    return { started: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stop ComfyUI: the process we launched, or whoever listens on the port. */
export async function stopComfy(comfyUrl: string): Promise<ComfyStopResult> {
  const port = portOf(comfyUrl);
  let target = spawnedPid;
  spawnedPid = null;
  if (!target) target = await pidListeningOn(port);
  if (!target) return { ok: false, error: "No ComfyUI process found — nothing to stop." };
  try {
    if (os.platform() === "win32") {
      await run("taskkill", ["/PID", String(target), "/T", "/F"]);
    } else {
      try {
        process.kill(-target, "SIGTERM");
      } catch {
        process.kill(target, "SIGTERM");
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Find the PID listening on a TCP port (netstat parse). */
export function pidListeningOn(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (os.platform() !== "win32") {
      resolve(spawnedPid);
      return;
    }
    execFile("netstat", ["-ano"], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const needle = `:${port}`;
      for (const line of stdout.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const tokens = line.trim().split(/\s+/);
        const local = tokens[1] ?? "";
        if (local.endsWith(needle)) {
          const pid = Number(tokens[tokens.length - 1]);
          if (pid && pid !== process.pid) {
            resolve(pid);
            return;
          }
        }
      }
      resolve(null);
    });
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err) => (err ? reject(new Error(err.message)) : resolve()));
  });
}
