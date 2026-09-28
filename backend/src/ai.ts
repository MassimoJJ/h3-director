// Resolves the effective AI endpoint (provider + model + key) from settings,
// with environment-variable fallback, and lists models per provider.

import type { AppSettings } from "./types";
import { CLINE_PASS_MODELS, defaultModelFor, providerDef } from "./providers";

export interface ResolvedAi {
  providerId: string;
  providerLabel: string;
  baseUrl: string; // OpenAI-compatible root, e.g. .../v1
  apiKey: string;
  model: string;
  isOllama: boolean;
}

export function effectiveKey(def: { envVar?: string }, storedKey: string): string {
  if (storedKey) return storedKey;
  if (def.envVar && process.env[def.envVar]) return process.env[def.envVar] ?? "";
  return "";
}

export function resolveAi(settings: AppSettings): ResolvedAi {
  const providerId = settings.director.provider || "ollama";
  if (providerId === "ollama") {
    const ollamaUrl = (settings.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
    const baseUrl = ollamaUrl.endsWith("/v1") ? ollamaUrl : `${ollamaUrl}/v1`;
    const model = settings.director.model || defaultModelFor("ollama");
    return { providerId, providerLabel: "Ollama (local)", baseUrl, apiKey: "", model, isOllama: true };
  }
  const def = providerDef(providerId);
  const entry = settings.keys[providerId];
  const label = def?.label ?? providerId;
  if (!def) {
    return { providerId, providerLabel: label, baseUrl: entry?.baseUrl || "", apiKey: entry?.key ?? "", model: settings.director.model || "", isOllama: false };
  }
  const baseUrl = entry?.baseUrl || def.baseUrl;
  const key = effectiveKey(def, entry?.key ?? "");
  const model = settings.director.model || entry?.model || defaultModelFor(providerId);
  return { providerId, providerLabel: label, baseUrl, apiKey: key, model, isOllama: false };
}

export function keyConfigured(settings: AppSettings, id: string): boolean {
  const def = providerDef(id);
  const entry = settings.keys[id];
  if (entry?.key) return true;
  if (def?.envVar && process.env[def.envVar]) return true;
  return false;
}

/** List models from an OpenAI-compatible /models endpoint. */
export async function listProviderModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`/models returned HTTP ${r.status}`);
  const j = (await r.json()) as { data?: Array<{ id?: string }> };
  const ids = (j.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  // Cline: the API's own /models omits the ClinePass subscription models even
  // though they are callable through the same endpoint — merge them in first.
  if (/api\.cline\.bot/i.test(baseUrl)) {
    const extra = CLINE_PASS_MODELS.filter((m) => !ids.includes(m));
    return [...extra, ...ids];
  }
  return ids;
}

export interface OllamaModel {
  name: string;
  sizeGB?: string;
  details?: string;
}

/** List local Ollama models with human sizes (native /api/tags endpoint). */
export async function listOllamaModels(ollamaUrl: string): Promise<OllamaModel[]> {
  const base = (ollamaUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
  const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Ollama /api/tags returned HTTP ${r.status} — is Ollama running?`);
  const j = (await r.json()) as { models?: Array<{ name?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }> };
  return (j.models ?? [])
    .map((m) => ({
      name: m.name ?? "",
      sizeGB: m.size ? `${(m.size / 1024 ** 3).toFixed(1)} GB` : undefined,
      details: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · ") || undefined,
    }))
    .filter((m) => m.name);
}

export async function ollamaUp(ollamaUrl: string): Promise<boolean> {
  try {
    await listOllamaModels(ollamaUrl);
    return true;
  } catch {
    return false;
  }
}
