import { deepSeekDefaults } from "./deepseek-model.ts";
import { validateOpenAiCompatibleBaseUrl } from "./openai-compatible-model.ts";

export type ModelProfileId = "fake" | "deepseek" | "openai-compatible";

interface BaseModelProfile {
  id: ModelProfileId;
  label: string;
  description: string;
}

export interface FakeModelProfile extends BaseModelProfile {
  id: "fake";
  kind: "fake";
}

export interface OpenAiCompatibleProfile extends BaseModelProfile {
  id: "deepseek" | "openai-compatible";
  kind: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnvironmentVariable: string;
  disableThinking: boolean;
}

export type ModelProfile = FakeModelProfile | OpenAiCompatibleProfile;

export interface ResolvedOpenAiCompatibleProfile {
  profile: OpenAiCompatibleProfile;
  apiKey: string;
  allowInsecureHttp: boolean;
}

export interface ModelProfileReadiness {
  ready: boolean;
  reason?: string;
}

function valueFrom(environment: NodeJS.ProcessEnv, name: string): string {
  return environment[name]?.trim() ?? "";
}

function allowInsecureHttpFrom(environment: NodeJS.ProcessEnv): boolean {
  return valueFrom(environment, "MINICODE_ALLOW_INSECURE_HTTP") === "1";
}

export function parseModelProfileId(value: string): ModelProfileId | undefined {
  switch (value) {
    case "fake":
    case "deepseek":
    case "openai-compatible":
      return value;
    case "openai":
      return "openai-compatible";
    default:
      return undefined;
  }
}

/**
 * Profile 只保存可公开的连接元数据和环境变量名；API Key 从不进入 Profile。
 */
export function getModelProfiles(environment: NodeJS.ProcessEnv = process.env): readonly ModelProfile[] {
  return [
    {
      id: "fake",
      kind: "fake",
      label: "FakeModel（离线）",
      description: "本地确定性演示，不发送网络请求。",
    },
    {
      id: "deepseek",
      kind: "openai-compatible",
      label: "DeepSeek",
      description: "DeepSeek 的 OpenAI-compatible 预设。",
      baseUrl: deepSeekDefaults.baseUrl,
      model: valueFrom(environment, "DEEPSEEK_MODEL") || deepSeekDefaults.model,
      apiKeyEnvironmentVariable: "DEEPSEEK_API_KEY",
      disableThinking: true,
    },
    {
      id: "openai-compatible",
      kind: "openai-compatible",
      label: "OpenAI-compatible",
      description: "从环境变量读取使用 Bearer Key 与 Chat Completions 工具调用的兼容服务。",
      baseUrl: valueFrom(environment, "MINICODE_OPENAI_BASE_URL"),
      model: valueFrom(environment, "MINICODE_OPENAI_MODEL"),
      apiKeyEnvironmentVariable: "MINICODE_OPENAI_API_KEY",
      disableThinking: false,
    },
  ];
}

export function getModelProfile(
  id: ModelProfileId,
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfile {
  const profile = getModelProfiles(environment).find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`未找到模型 Profile：${id}。`);
  return profile;
}

export function getModelProfileReadiness(
  profile: ModelProfile,
  environment: NodeJS.ProcessEnv = process.env,
): ModelProfileReadiness {
  if (profile.kind === "fake") return { ready: true };
  if (profile.baseUrl === "") return { ready: false, reason: "缺少 baseUrl 环境变量" };
  const baseUrlProblem = validateOpenAiCompatibleBaseUrl(profile.baseUrl, {
    allowInsecureHttp: allowInsecureHttpFrom(environment),
  });
  if (baseUrlProblem) return { ready: false, reason: baseUrlProblem };
  if (profile.model === "") return { ready: false, reason: "缺少 model 环境变量" };
  if (valueFrom(environment, profile.apiKeyEnvironmentVariable) === "") {
    return { ready: false, reason: `缺少 ${profile.apiKeyEnvironmentVariable}` };
  }
  return { ready: true };
}

export function resolveOpenAiCompatibleProfile(
  id: ModelProfileId,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedOpenAiCompatibleProfile {
  const profile = getModelProfile(id, environment);
  if (profile.kind === "fake") {
    throw new Error("FakeModel 不需要 OpenAI-compatible 配置。");
  }
  const readiness = getModelProfileReadiness(profile, environment);
  if (!readiness.ready) {
    throw new Error(`${profile.label} Profile 尚未配置：${readiness.reason ?? "配置不完整"}。`);
  }
  return {
    profile,
    apiKey: valueFrom(environment, profile.apiKeyEnvironmentVariable),
    allowInsecureHttp: allowInsecureHttpFrom(environment),
  };
}
