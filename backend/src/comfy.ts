// Thin ComfyUI REST/WebSocket client.

export interface ObjectInfoEntry {
  input?: {
    required?: Record<string, unknown[]>;
    optional?: Record<string, unknown[]>;
  };
  output?: unknown;
  category?: unknown;
}

export class ComfyError extends Error {
  constructor(
    message: string,
    public readonly detail?: unknown,
    public readonly validationErrors?: unknown,
  ) {
    super(message);
  }
}

function parseCombo(spec: unknown): string[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;
  const first = spec[0];
  if (!Array.isArray(first)) return null;
  return first.map(String);
}

export class ComfyClient {
  constructor(
    public baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(method === "GET" ? 30_000 : 60_000),
      });
    } catch (e) {
      throw new ComfyError(`ComfyUI unreachable at ${this.baseUrl}: ${String(e)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ComfyError(`ComfyUI ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async get(path: string): Promise<unknown> {
    return this.req("GET", path);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.req("POST", path, body);
  }

  // Cache object_info for 5 minutes; model choices are read at render time via refresh().
  private objectInfoCache: Record<string, ObjectInfoEntry> | null = null;
  private objectInfoAt = 0;

  async objectInfo(force = false): Promise<Record<string, ObjectInfoEntry>> {
    if (!force && this.objectInfoCache && Date.now() - this.objectInfoAt < 300_000) {
      return this.objectInfoCache;
    }
    const oi = (await this.get("/object_info")) as Record<string, ObjectInfoEntry>;
    this.objectInfoCache = oi;
    this.objectInfoAt = Date.now();
    return oi;
  }

  async nodeExists(nodeClass: string): Promise<boolean> {
    const oi = await this.objectInfo();
    return nodeClass in oi;
  }

  async comboChoices(nodeClass: string, inputName: string, section: "required" | "optional" = "required"): Promise<string[]> {
    const oi = await this.objectInfo();
    const entry = oi[nodeClass];
    const spec = entry?.input?.[section]?.[inputName];
    return parseCombo(spec) ?? [];
  }

  async systemStats(): Promise<{ system?: { comfyui_version?: string; devices?: Array<{ name?: string; vram_total?: number }> } }> {
    return (await this.get("/system_stats")) as never;
  }

  async queuePrompt(prompt: Record<string, unknown>, clientId: string): Promise<{ prompt_id: string; number?: number; node_errors?: unknown }> {
    const body = { prompt, client_id: clientId };
    const res = (await this.post("/prompt", body)) as { prompt_id: string; number?: number; node_errors?: unknown; error?: unknown };
    if (res.error) throw new ComfyError("ComfyUI rejected prompt", res.error);
    if (res.node_errors && Object.keys(res.node_errors as object).length > 0) {
      throw new ComfyError("Workflow validation failed (no job was queued)", undefined, res.node_errors);
    }
    return res;
  }

  async history(promptId: string): Promise<Record<string, unknown> | undefined> {
    const h = (await this.get(`/history/${promptId}`)) as Record<string, Record<string, unknown>>;
    return h[promptId];
  }

  async interrupt() {
    await this.post("/interrupt", {});
  }

  async freeMemory() {
    try {
      await this.post("/free", { unload_models: true, free_memory: true });
    } catch {
      // non-fatal
    }
  }

  async viewFile(filename: string, subfolder: string, type: string): Promise<Buffer> {
    const url = `${this.baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new ComfyError(`/view ${filename} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  }
}

// Recursively collect ComfyUI output file records ({filename, subfolder, type}) that
// appear in a /history node-outputs payload, keeping order.
export function collectOutputFiles(outputs: unknown): Array<{ filename: string; subfolder: string; type: string; isVideo: boolean }> {
  const found: Array<{ filename: string; subfolder: string; type: string; isVideo: boolean }> = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.filename === "string" && typeof rec.type === "string") {
        const isVideo = /\.(mp4|webm|mov|mkv|gif)$/i.test(rec.filename);
        if (isVideo || /\.(png|jpg|jpeg|webp)$/i.test(rec.filename)) {
          found.push({
            filename: rec.filename,
            subfolder: typeof rec.subfolder === "string" ? rec.subfolder : "",
            type: rec.type,
            isVideo,
          });
          return;
        }
      }
      for (const k of Object.keys(rec)) visit(rec[k], depth + 1);
    }
  };
  visit(outputs, 0);
  return found;
}
