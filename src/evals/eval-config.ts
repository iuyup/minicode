import { createHash } from "node:crypto";

import {
  EDIT_HARD_MAX_ACCEPTED_TOOL_CALLS,
  EDIT_HARD_MAX_MODEL_REQUESTS,
} from "../agent/budget-limits.ts";

import {
  getModelProfile,
  parseModelProfileId,
  type ModelProfileId,
} from "../models/model-profiles.ts";
import {
  EVALUATION_SUITE_ID,
  EVALUATION_SUITE_VERSION,
} from "./task-definitions.ts";
import { EVALUATION_PROMPTS } from "./eval-prompts.ts";

export const EVALUATION_TRIALS = 3 as const;

export const EVALUATION_ARMS = Object.freeze([
  "baseline-3tool",
  "minicode-3tool",
  "minicode-product",
] as const);

export type EvaluationArm = typeof EVALUATION_ARMS[number];

export const EVALUATION_BUDGET = Object.freeze({
  baselineMaxModelRequests: 7,
  guidedBaseMaxModelRequests: 8,
  baseMaxAcceptedToolCalls: 6,
  postPatchValidationExtraModelRequests: 2,
  postPatchValidationExtraToolCalls: 1,
  postPatchCloseoutExtraModelRequests: 2,
  postPatchCloseoutExtraToolCalls: 2,
  sameTurnRecoveryExtraModelRequests: 1,
  failureRepairExtraToolCalls: 3,
  repairPatchValidationExtraToolCalls: 1,
  originalActionRevalidationExtraToolCalls: 1,
  postRepairGitExtraToolCalls: 2,
  hardMaxModelRequests: EDIT_HARD_MAX_MODEL_REQUESTS,
  hardMaxAcceptedToolCalls: EDIT_HARD_MAX_ACCEPTED_TOOL_CALLS,
  maxToolCallsPerTurn: 1,
  maxOutputTokensPerRequest: 2_048,
  wallClockTimeoutMs: 180_000,
} as const);

export interface EvaluationPricingSnapshot {
  snapshotId: string;
  profileId: ModelProfileId;
  model: string;
  effectiveAt: string;
  currency: "USD";
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens: number;
  source?: string;
}

export type EvaluationPublicModel =
  | {
      readonly profileId: "fake";
      readonly kind: "fake";
      readonly model: "fake";
    }
  | {
      readonly profileId: "deepseek" | "openai-compatible";
      readonly kind: "openai-compatible";
      readonly model: string;
      readonly endpointSha256: string;
      readonly disableThinking: boolean;
      readonly allowInsecureHttp: boolean;
    };

export type EvaluationCostConfiguration =
  | { readonly status: "unavailable" }
  | {
      readonly status: "configured";
      readonly pricing: Readonly<EvaluationPricingSnapshot>;
    };

export interface PublicEvaluationConfig {
  readonly schemaVersion: 1;
  readonly suite: {
    readonly id: typeof EVALUATION_SUITE_ID;
    readonly version: typeof EVALUATION_SUITE_VERSION;
    readonly trials: typeof EVALUATION_TRIALS;
  };
  readonly arms: readonly EvaluationArm[];
  readonly model: EvaluationPublicModel;
  readonly budget: typeof EVALUATION_BUDGET;
  readonly runtime: {
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly approvalMode: "fixture-auto-approve-allowlist";
    readonly temperature: null;
    readonly seed: null;
  };
  readonly prompts: Readonly<Record<EvaluationArm, {
    readonly systemSha256: string;
    readonly planningSha256: string | null;
  }>>;
  readonly cost: EvaluationCostConfiguration;
}

export interface EvaluationConfig {
  readonly publicConfig: PublicEvaluationConfig;
  readonly publicConfigJson: string;
  readonly publicConfigSha256: string;
}

export interface CreateEvaluationConfigOptions {
  profileId: string;
  environment?: NodeJS.ProcessEnv;
  pricing?: EvaluationPricingSnapshot;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label}不能为空。`);
  return normalized;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是大于或等于 0 的有限数值。`);
  }
  return value;
}

function publicModel(profileId: ModelProfileId, environment: NodeJS.ProcessEnv): EvaluationPublicModel {
  const profile = getModelProfile(profileId, environment);
  if (profile.kind === "fake") {
    return { profileId: "fake", kind: "fake", model: "fake" };
  }

  return {
    profileId: profile.id,
    kind: profile.kind,
    model: nonEmpty(profile.model, `${profile.label} model`),
    endpointSha256: createHash("sha256")
      .update(nonEmpty(profile.baseUrl, `${profile.label} baseUrl`), "utf8")
      .digest("hex"),
    disableThinking: profile.disableThinking,
    allowInsecureHttp: environment.MINICODE_ALLOW_INSECURE_HTTP?.trim() === "1",
  };
}

function normalizePricing(
  pricing: EvaluationPricingSnapshot,
  model: EvaluationPublicModel,
): Readonly<EvaluationPricingSnapshot> {
  if (pricing.profileId !== model.profileId) {
    throw new Error(`价格快照 profileId=${pricing.profileId} 与评测 Profile ${model.profileId} 不匹配。`);
  }
  if (pricing.currency !== "USD") {
    throw new Error("价格快照 currency 当前只允许 USD。");
  }
  if (nonEmpty(pricing.model, "价格快照 model") !== model.model) {
    throw new Error(`价格快照 model=${pricing.model} 与评测模型 ${model.model} 不匹配。`);
  }
  const effectiveAt = new Date(pricing.effectiveAt);
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new Error("价格快照 effectiveAt 必须是有效日期时间。");
  }

  return Object.freeze({
    snapshotId: nonEmpty(pricing.snapshotId, "价格快照 snapshotId"),
    profileId: pricing.profileId,
    model: model.model,
    effectiveAt: effectiveAt.toISOString(),
    currency: "USD" as const,
    inputUsdPerMillionTokens: nonNegativeFinite(
      pricing.inputUsdPerMillionTokens,
      "inputUsdPerMillionTokens",
    ),
    ...(pricing.cachedInputUsdPerMillionTokens === undefined
      ? {}
      : {
          cachedInputUsdPerMillionTokens: nonNegativeFinite(
            pricing.cachedInputUsdPerMillionTokens,
            "cachedInputUsdPerMillionTokens",
          ),
        }),
    outputUsdPerMillionTokens: nonNegativeFinite(
      pricing.outputUsdPerMillionTokens,
      "outputUsdPerMillionTokens",
    ),
    ...(pricing.source === undefined ? {} : { source: nonEmpty(pricing.source, "价格快照 source") }),
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
    output[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function freezePublicConfig(config: PublicEvaluationConfig): PublicEvaluationConfig {
  Object.freeze(config.suite);
  Object.freeze(config.arms);
  Object.freeze(config.model);
  Object.freeze(config.budget);
  Object.freeze(config.runtime);
  for (const prompt of Object.values(config.prompts)) Object.freeze(prompt);
  Object.freeze(config.prompts);
  if (config.cost.status === "configured") Object.freeze(config.cost.pricing);
  Object.freeze(config.cost);
  return Object.freeze(config);
}

export function serializePublicEvaluationConfig(config: PublicEvaluationConfig): string {
  return `${JSON.stringify(canonicalValue(config), null, 2)}\n`;
}

export function hashPublicEvaluationConfig(config: PublicEvaluationConfig): string {
  return createHash("sha256").update(serializePublicEvaluationConfig(config), "utf8").digest("hex");
}

export function createEvaluationConfig(options: CreateEvaluationConfigOptions): EvaluationConfig {
  const profileId = parseModelProfileId(options.profileId);
  if (!profileId) {
    throw new Error("未知评测 Profile；可选 fake、deepseek、openai-compatible。");
  }
  const model = publicModel(profileId, options.environment ?? process.env);
  const cost: EvaluationCostConfiguration = options.pricing
    ? { status: "configured", pricing: normalizePricing(options.pricing, model) }
    : { status: "unavailable" };
  const publicConfig = freezePublicConfig({
    schemaVersion: 1,
    suite: {
      id: EVALUATION_SUITE_ID,
      version: EVALUATION_SUITE_VERSION,
      trials: EVALUATION_TRIALS,
    },
    arms: [...EVALUATION_ARMS],
    model,
    budget: EVALUATION_BUDGET,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      approvalMode: "fixture-auto-approve-allowlist",
      temperature: null,
      seed: null,
    },
    prompts: Object.fromEntries(EVALUATION_ARMS.map((arm) => [arm, {
      systemSha256: createHash("sha256").update(EVALUATION_PROMPTS[arm].system, "utf8").digest("hex"),
      planningSha256: EVALUATION_PROMPTS[arm].planning === null
        ? null
        : createHash("sha256").update(EVALUATION_PROMPTS[arm].planning, "utf8").digest("hex"),
    }])) as PublicEvaluationConfig["prompts"],
    cost,
  });
  const publicConfigJson = serializePublicEvaluationConfig(publicConfig);
  return Object.freeze({
    publicConfig,
    publicConfigJson,
    publicConfigSha256: createHash("sha256").update(publicConfigJson, "utf8").digest("hex"),
  });
}
