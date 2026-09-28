export interface ProviderCard {
  id: string;
  label: string;
  baseUrl: string;
  envVar: string;
  local: boolean; // local endpoints need no API key
  // Model ids the provider offers that its /models endpoint doesn't return.
  // Cline: ClinePass's cline-free/* (FREE in-app) and cline-pass/* (subscription)
  // models are absent from api.cline.bot's 458-model listing but are valid API slugs.
  extraModels?: string[];
}

// Free-tier first — the same order Cline's own model selector shows them.
const CLINE_FREE_MODELS = [
  "cline-free/deepseek-v4.1-flash",
  "cline-free/gemini-3.8-flash",
  "cline-free/mimo-v2.6-flash",
  "cline-free/muse-spark-1.3-contributor",
];

const CLINE_PASS_MODELS = [
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

export const PROVIDER_CARDS: ProviderCard[] = [
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434", envVar: "", local: true },
  { id: "lmstudio", label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1", envVar: "", local: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", envVar: "OPENAI_API_KEY", local: false },
  { id: "grok", label: "Grok (xAI)", baseUrl: "https://api.x.ai/v1", envVar: "GROK_API_KEY", local: false },
  { id: "gemini", label: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envVar: "GEMINI_API_KEY", local: false },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY", local: false },
  { id: "opencode", label: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", envVar: "OPENCODE_API_KEY", local: false },
  { id: "kilocode", label: "KiloCode", baseUrl: "https://api.kilo.ai/api/gateway", envVar: "KILOCODE_API_KEY", local: false },
  {
    id: "cline",
    label: "Cline API",
    baseUrl: "https://api.cline.bot/api/v1",
    envVar: "CLINE_API_KEY",
    local: false,
    extraModels: [...CLINE_FREE_MODELS, ...CLINE_PASS_MODELS],
  },
  { id: "custom", label: "Other (OpenAI-compatible)", baseUrl: "http://127.0.0.1:8000/v1", envVar: "", local: false },
];
