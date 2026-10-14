import type { ProviderKind } from "@/lib/providers/public";

export interface ModelPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  kind?: ProviderKind;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  {
    id: "qwen",
    label: "通义",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    model: "",
  },
  {
    id: "cursor",
    label: "Cursor（订阅额度）",
    baseUrl: "",
    model: "composer-2",
    kind: "cursor",
  },
];
