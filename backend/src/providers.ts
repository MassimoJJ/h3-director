// Catalog of AI providers the co-director can route to. All are OpenAI-compatible
// chat endpoints (Gemini's listed base is Google's official OpenAI-compat shim).

export interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  envVar: string;
  builtin: boolean; // cannot be deleted, only key-cleared
}

export const PROVIDERS: ProviderDef[] = [
  { id: "ollama", label: "Ollama (local)", baseUrl: "", envVar: "", builtin: true },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", envVar: "", builtin: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", envVar: "OPENAI_API_KEY", builtin: true },
  { id: "grok", label: "Grok (xAI)", baseUrl: "https://api.x.ai/v1", envVar: "GROK_API_KEY", builtin: true },
  { id: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envVar: "GEMINI_API_KEY", builtin: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY", builtin: true },
  { id: "opencode", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", envVar: "OPENCODE_API_KEY", builtin: true },
  { id: "kilocode", label: "KiloCode", baseUrl: "https://api.kilo.ai/api/gateway", envVar: "KILOCODE_API_KEY", builtin: true },
  { id: "cline", label: "Cline API", baseUrl: "https://api.cline.bot/api/v1", envVar: "CLINE_API_KEY", builtin: true },
  { id: "custom", label: "Other (OpenAI-compatible)", baseUrl: "http://127.0.0.1:8000/v1", envVar: "", builtin: false },
];

export function providerDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

// ClinePass models (flat $9.99/mo subscription) are usable through the Cline API
// with the full slug (docs: "Using ClinePass outside of Cline"), but they are NOT
// returned by GET /api/v1/models — so we merge them in ourselves. Source:
// docs.cline.bot/getting-started/clinepass.md ("Models" table). Deprecated ones
// (GLM-5.2, Kimi K2.6, Kimi K2.7 Code, DeepSeek V4 Flash) are already excluded.
export const CLINE_PASS_MODELS = [
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.3-flash",
  "cline-pass/kimi-k3",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/deepseek-v4.1-flash",
  "cline-pass/mimo-v2.5",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/minimax-m3",
  "cline-pass/muse-spark-1.3-contributor",
  "cline-pass/qwen3.8-max",
  "cline-pass/qwen3.7-max",
  "cline-pass/qwen3.7-plus",
];

export function defaultModelFor(id: string): string {
  switch (id) {
    case "ollama":
      return "qwen3:8b";
    case "openai":
      return "gpt-4o-mini";
    case "grok":
      return "grok-3-mini";
    case "gemini":
      return "gemini-3-flash";
    case "openrouter":
      return "openrouter/auto";
    case "opencode":
      return "opencode/zen-mini";
    case "kilocode":
      return "kilocode/mini";
    case "cline":
      // Verified live against api.cline.bot with a real key: cline-pass/* returns
      // 403 (no subscription), `deepseek/deepseek-chat` 404s (renamed upstream), and
      // `:free` ids are usually 429-rate-limited. This one is cheap and stable.
      return "deepseek/deepseek-chat-v3.1";
    default:
      return "";
  }
}
