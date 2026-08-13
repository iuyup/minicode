import { OpenAiCompatibleModel } from "./openai-compatible-model.ts";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;

export interface DeepSeekModelOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImplementation?: typeof fetch;
}

/**
 * 保留旧入口，同时把 DeepSeek 的专属请求参数收敛成一个 Profile 预设。
 */
export class DeepSeekModel extends OpenAiCompatibleModel {
  constructor(options: DeepSeekModelOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      model: options.model ?? DEFAULT_MODEL,
      providerName: "DeepSeek",
      apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
      disableThinking: true,
    });
  }
}

export const deepSeekDefaults = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: DEFAULT_MAX_TOKENS,
} as const;
