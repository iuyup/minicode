import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentRunResult } from "../agent/agent-loop.ts";
import type { ChatModel } from "../agent/contracts.ts";
import type { AgentEvent } from "../agent/events.ts";
import {
  MODEL_ERROR_CATEGORIES,
  type ModelCallMetric,
  type ModelErrorCategory,
} from "../models/openai-compatible-model.ts";
import { createEvaluationArmAgent } from "./eval-arms.ts";
import {
  EVALUATION_ARMS,
  EVALUATION_BUDGET,
  EVALUATION_TRIALS,
  type EvaluationArm,
} from "./eval-config.ts";
import {
  EVALUATION_ARTIFACTS_DIRECTORY,
  prepareEvaluationFixture,
} from "./eval-fixture.ts";
import {
  gradeEvaluationRun,
  type EvaluationGradeResult,
} from "./eval-grader.ts";
import {
  EVALUATION_SUITE_ID,
  EVALUATION_SUITE_VERSION,
} from "./task-definitions.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PUBLIC_TOOL_NAMES = new Set([
  "apply_patch",
  "inspect_git",
  "read_file",
  "run_command",
  "run_project_check",
]);
const PUBLIC_ACTIONS = new Set(["check", "diff", "staged_diff", "status", "test"]);
const PUBLIC_FINISH_REASONS = new Set(["stop", "tool_calls", "length", "content_filter"]);
const MODEL_ERROR_CATEGORY_SET = new Set<string>(MODEL_ERROR_CATEGORIES);
const TRIAL_STATUSES = new Set([
  "passed", "failed", "agent_error", "timed_out", "cancelled", "grading_error",
]);

type EvaluationProfileId = "deepseek" | "openai-compatible";
type TrialStatus =
  | "passed"
  | "failed"
  | "agent_error"
  | "timed_out"
  | "cancelled"
  | "grading_error";

export const EVALUATION_TRIAL_RESULT_FILENAME = "trial-result.json";
export const EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME = "trial-result.sha256";

export interface EvaluationTrialConfirmationMaterial {
  planSha256: string;
  publicConfigSha256: string;
  profileId: EvaluationProfileId;
  taskId: string;
  arm: EvaluationArm;
  trial: number;
}

export interface EvaluationTrialConfirmation {
  /** Hash printed by the reviewed suite plan. */
  planSha256: string;
  /** Explicit acknowledgement supplied by the caller; it must match planSha256. */
  confirmedPlanSha256: string;
  /** Binds this exact config/profile/task/arm/trial cell to the reviewed plan. */
  trialSha256: string;
}

export interface EvaluationTrialResultIntegrity {
  schemaVersion: 1;
  algorithm: "sha256";
  resultFile: typeof EVALUATION_TRIAL_RESULT_FILENAME;
  resultSha256: string;
}

export interface EvaluationTrialToolMetrics {
  requested: number;
  finalized: number;
  succeeded: number;
  failed: number;
  byName: Readonly<Record<string, {
    requested: number;
    finalized: number;
    succeeded: number;
    failed: number;
  }>>;
}

export interface EvaluationTrialModelMetrics {
  calls: number;
  succeeded: number;
  failed: number;
  errorCategories: Readonly<Record<ModelErrorCategory, number>>;
  httpStatusCounts: Readonly<Record<string, number>>;
  latencyMs: number;
  usageStatus: "provider" | "partial" | "unavailable";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  ttftStatus: "unavailable_non_streaming";
}

type PublicGradeResult = Omit<EvaluationGradeResult, "graderArtifactsDirectory">;

export interface EvaluationTrialResult {
  schemaVersion: 1;
  suite: {
    id: typeof EVALUATION_SUITE_ID;
    version: typeof EVALUATION_SUITE_VERSION;
  };
  taskId: string;
  category: "functional" | "safety";
  flow: "direct" | "failure_repair" | "boundary";
  arm: EvaluationArm;
  trial: number;
  profileId: EvaluationProfileId;
  planSha256: string;
  publicConfigSha256: string;
  trialConfirmationSha256: string;
  fixtureSha256: string;
  taskSpecSha256: string;
  status: TrialStatus;
  durationMs: number;
  timedOut: boolean;
  agentCompleted: boolean;
  model: EvaluationTrialModelMetrics;
  tools: EvaluationTrialToolMetrics;
  repair: {
    proposed: number;
    approved: number;
  };
  grade: PublicGradeResult | null;
  failureCode: string | null;
  artifacts: {
    auditSha256: string | null;
    traceSha256: string;
  };
}

export interface RunEvaluationTrialOptions {
  taskId: string;
  arm: EvaluationArm;
  trial: number;
  profileId: EvaluationProfileId;
  publicConfigSha256: string;
  confirmation: EvaluationTrialConfirmation;
  runRoot: string;
  /** Optional public destination; the private fixture/audit/grader stay under runRoot. */
  artifactsRoot?: string;
  model: ChatModel;
  /** The OpenAI-compatible adapter appends to this array through onCallMetric. */
  modelMetrics?: ModelCallMetric[];
  resetExisting?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function hashEvaluationTrialConfirmation(
  material: EvaluationTrialConfirmationMaterial,
): string {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    planSha256: material.planSha256,
    publicConfigSha256: material.publicConfigSha256,
    profileId: material.profileId,
    taskId: material.taskId,
    arm: material.arm,
    trial: material.trial,
  }));
}

function normalizedPath(target: string): string {
  const normalized = path.normalize(path.resolve(target));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizedPath(parent), normalizedPath(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateOptions(options: RunEvaluationTrialOptions): void {
  if (!Number.isSafeInteger(options.trial) || options.trial < 1 || options.trial > EVALUATION_TRIALS) {
    throw new Error(`trial 必须是 1 到 ${EVALUATION_TRIALS}。`);
  }
  if (!SHA256_PATTERN.test(options.publicConfigSha256)) {
    throw new Error("publicConfigSha256 必须是 64 位小写 SHA-256。");
  }
  if (!(EVALUATION_ARMS as readonly string[]).includes(options.arm)) {
    throw new Error("未知评测 arm。");
  }
  const confirmation: Partial<EvaluationTrialConfirmation> | undefined = options.confirmation;
  if (!confirmation || typeof confirmation !== "object") {
    throw new Error("单次评测必须提供已确认的 plan 绑定摘要。");
  }
  if (typeof confirmation.planSha256 !== "string" ||
      typeof confirmation.confirmedPlanSha256 !== "string" ||
      typeof confirmation.trialSha256 !== "string" ||
      !SHA256_PATTERN.test(confirmation.planSha256) ||
      !SHA256_PATTERN.test(confirmation.confirmedPlanSha256) ||
      !SHA256_PATTERN.test(confirmation.trialSha256)) {
    throw new Error("评测确认摘要必须是 64 位小写 SHA-256。");
  }
  if (confirmation.confirmedPlanSha256 !== confirmation.planSha256) {
    throw new Error("已确认的 plan SHA-256 与本次评测计划不一致。");
  }
  const expectedTrialSha256 = hashEvaluationTrialConfirmation({
    planSha256: confirmation.planSha256,
    publicConfigSha256: options.publicConfigSha256,
    profileId: options.profileId,
    taskId: options.taskId,
    arm: options.arm,
    trial: options.trial,
  });
  if (confirmation.trialSha256 !== expectedTrialSha256) {
    throw new Error("单次评测确认摘要与 config/profile/task/arm/trial 不一致。");
  }
  const timeoutMs = options.timeoutMs ?? EVALUATION_BUDGET.wallClockTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > EVALUATION_BUDGET.wallClockTimeoutMs) {
    throw new Error(`单次评测超时必须在 1 到 ${EVALUATION_BUDGET.wallClockTimeoutMs} 毫秒之间。`);
  }
}

function modelSummary(metrics: readonly ModelCallMetric[]): EvaluationTrialModelMetrics {
  const available = metrics.filter((metric) => metric.usageSource === "provider");
  const errorCategories = Object.fromEntries(
    MODEL_ERROR_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ModelErrorCategory, number>;
  const httpStatusCounts = new Map<number, number>();
  for (const metric of metrics) {
    if (metric.outcome !== "error") continue;
    const category = safeModelErrorCategory(metric.errorCategory) ?? "unknown";
    errorCategories[category] += 1;
    const status = safeHttpStatus(metric.httpStatus);
    if (status !== null) httpStatusCounts.set(status, (httpStatusCounts.get(status) ?? 0) + 1);
  }
  const sum = (field: "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens"): number | null => {
    if (metrics.length === 0) return null;
    const values = metrics.map((metric) => metric[field]);
    return values.every((value) => value !== null)
      ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
      : null;
  };
  return {
    calls: metrics.length,
    succeeded: metrics.filter((metric) => metric.outcome === "success").length,
    failed: metrics.filter((metric) => metric.outcome === "error").length,
    errorCategories,
    httpStatusCounts: Object.fromEntries(
      [...httpStatusCounts.entries()].sort(([left], [right]) => left - right).map(([status, count]) => [String(status), count]),
    ),
    latencyMs: metrics.reduce((total, metric) => total + metric.latencyMs, 0),
    usageStatus: available.length === 0
      ? "unavailable"
      : available.length === metrics.length ? "provider" : "partial",
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    ttftStatus: "unavailable_non_streaming",
  };
}

function safeModelErrorCategory(value: unknown): ModelErrorCategory | null {
  return typeof value === "string" && MODEL_ERROR_CATEGORY_SET.has(value)
    ? value as ModelErrorCategory
    : null;
}

function safeHttpStatus(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? value as number
    : null;
}

function validTokenCount(value: number | null): value is number | null {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function providerSupplement(
  metrics: readonly ModelCallMetric[],
): Pick<
  ModelCallMetric,
  "finishReason" | "usageSource" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens" |
  "errorCategory" | "httpStatus"
> | undefined {
  if (metrics.length !== 1) return undefined;
  const metric = metrics[0];
  if (!metric || !validTokenCount(metric.inputTokens) ||
      !validTokenCount(metric.cachedInputTokens) || !validTokenCount(metric.outputTokens) ||
      !validTokenCount(metric.totalTokens)) {
    return undefined;
  }
  const hasProviderUsage = metric.usageSource === "provider" &&
    [metric.inputTokens, metric.cachedInputTokens, metric.outputTokens, metric.totalTokens]
      .some((value) => value !== null);
  return {
    finishReason: typeof metric.finishReason === "string" || metric.finishReason === null
      ? metric.finishReason
      : null,
    usageSource: hasProviderUsage ? "provider" : "unavailable",
    inputTokens: hasProviderUsage ? metric.inputTokens : null,
    cachedInputTokens: hasProviderUsage ? metric.cachedInputTokens : null,
    outputTokens: hasProviderUsage ? metric.outputTokens : null,
    totalTokens: hasProviderUsage ? metric.totalTokens : null,
    errorCategory: metric.outcome === "error"
      ? safeModelErrorCategory(metric.errorCategory) ?? "unknown"
      : null,
    httpStatus: metric.outcome === "error" ? safeHttpStatus(metric.httpStatus) : null,
  };
}

function observeModelCalls(
  model: ChatModel,
  supplements: readonly ModelCallMetric[],
  observed: ModelCallMetric[],
): ChatModel {
  return {
    async complete(request, signal) {
      const callIndex = observed.length + 1;
      const supplementStart = supplements.length;
      const startedAt = new Date().toISOString();
      const started = performance.now();
      let outcome: ModelCallMetric["outcome"] = "error";
      let responseKind: ModelCallMetric["responseKind"] = null;
      try {
        const response = await model.complete(request, signal);
        outcome = "success";
        responseKind = response.kind;
        return response;
      } finally {
        const provider = providerSupplement(supplements.slice(supplementStart));
        observed.push({
          callIndex,
          phase: request.phase ?? "execution",
          startedAt,
          latencyMs: performance.now() - started,
          outcome,
          errorCategory: outcome === "success"
            ? null
            : provider?.errorCategory ?? (signal?.aborted ? "cancelled" : "unknown"),
          httpStatus: outcome === "error" ? provider?.httpStatus ?? null : null,
          finishReason: provider?.finishReason ?? null,
          responseKind,
          usageSource: provider?.usageSource ?? "unavailable",
          inputTokens: provider?.inputTokens ?? null,
          cachedInputTokens: provider?.cachedInputTokens ?? null,
          outputTokens: provider?.outputTokens ?? null,
          totalTokens: provider?.totalTokens ?? null,
          ttftMs: null,
        });
      }
    },
  };
}

function publicToolName(value: string): string {
  return PUBLIC_TOOL_NAMES.has(value) ? value : "unregistered";
}

function toolSummary(events: readonly AgentEvent[]): EvaluationTrialToolMetrics {
  const byName = new Map<string, {
    requested: number;
    finalized: number;
    succeeded: number;
    failed: number;
  }>();
  const bucket = (name: string) => {
    const safeName = publicToolName(name);
    const current = byName.get(safeName) ?? { requested: 0, finalized: 0, succeeded: 0, failed: 0 };
    byName.set(safeName, current);
    return current;
  };
  for (const event of events) {
    if (event.type === "tool_call") bucket(event.toolName).requested += 1;
    if (event.type === "tool_finalized") {
      const current = bucket(event.toolName);
      current.finalized += 1;
      if (event.status === "success") current.succeeded += 1;
      else current.failed += 1;
    }
  }
  const values = [...byName.values()];
  return {
    requested: values.reduce((total, value) => total + value.requested, 0),
    finalized: values.reduce((total, value) => total + value.finalized, 0),
    succeeded: values.reduce((total, value) => total + value.succeeded, 0),
    failed: values.reduce((total, value) => total + value.failed, 0),
    byName: Object.fromEntries([...byName.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))),
  };
}

function safeRelativeWorkspacePath(workspaceRoot: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute).replaceAll("\\", "/");
  if (relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    return "<outside-workspace>";
  }
  return relative;
}

function publicAuditEvent(
  record: Readonly<Record<string, unknown>>,
  sequence: number,
  workspaceRoot: string,
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    kind: "agent_event",
    sequence,
    type: typeof record.type === "string" ? record.type : "invalid",
    step: typeof record.step === "number" ? record.step : null,
  };
  if (typeof record.timestamp === "string") output.timestamp = record.timestamp;
  if (typeof record.toolCallId === "string") output.toolCallIdSha256 = sha256(record.toolCallId);
  if (typeof record.toolName === "string") output.toolName = publicToolName(record.toolName);
  for (const key of [
    "decision", "planDecision", "repairDecision", "editDecision", "commandDecision",
    "commandKind", "riskLevel", "status", "action", "forcedToolName",
  ]) {
    if (typeof record[key] === "string") {
      output[key] = key === "forcedToolName"
        ? publicToolName(record[key] as string)
        : key === "action"
          ? PUBLIC_ACTIONS.has(record[key] as string) ? record[key] : "other"
          : record[key];
    }
  }
  for (const key of [
    "detailLength", "exitCode", "durationMs", "outputLength", "sourceEvidenceCount",
    "planLength", "directionLength", "previewLength",
  ]) {
    if (typeof record[key] === "number" || record[key] === null) output[key] = record[key];
  }
  for (const key of ["outputTruncated", "timedOut", "cancelled"]) {
    if (typeof record[key] === "boolean") output[key] = record[key];
  }
  const safePath = safeRelativeWorkspacePath(workspaceRoot, record.path);
  if (safePath !== undefined) {
    output.pathScope = safePath === "<outside-workspace>" ? "outside-workspace" : "workspace";
    output.pathDepth = safePath === "<outside-workspace>" ? null : safePath.split("/").length;
  }
  return output;
}

function publicModelEvent(metric: ModelCallMetric): Readonly<Record<string, unknown>> {
  const failed = metric.outcome === "error";
  return {
    kind: "model_call",
    callIndex: metric.callIndex,
    phase: metric.phase,
    startedAt: metric.startedAt,
    latencyMs: metric.latencyMs,
    outcome: metric.outcome,
    errorCategory: failed ? safeModelErrorCategory(metric.errorCategory) ?? "unknown" : null,
    httpStatus: failed ? safeHttpStatus(metric.httpStatus) : null,
    finishReason: metric.finishReason && PUBLIC_FINISH_REASONS.has(metric.finishReason)
      ? metric.finishReason
      : metric.finishReason === null ? null : "other",
    responseKind: metric.responseKind,
    usageSource: metric.usageSource,
    inputTokens: metric.inputTokens,
    cachedInputTokens: metric.cachedInputTokens,
    outputTokens: metric.outputTokens,
    totalTokens: metric.totalTokens,
    ttftMs: null,
  };
}

function publicGradeResult(
  grade: EvaluationGradeResult | undefined,
  allowedChangedFiles: readonly string[],
): PublicGradeResult | null {
  if (!grade) return null;
  const allowed = new Set(allowedChangedFiles);
  let unexpectedIndex = 0;
  const changedFiles = grade.metrics.changedFiles.map((file) => {
    if (allowed.has(file)) return file;
    unexpectedIndex += 1;
    return `<unexpected-path-${unexpectedIndex}>`;
  });
  const illegalSuccessfulTools = grade.metrics.illegalSuccessfulTools.map((value) =>
    publicToolName(value.split(":", 1)[0] ?? "")
  );
  const { graderArtifactsDirectory: _privatePath, ...rest } = grade;
  return {
    ...rest,
    metrics: {
      ...rest.metrics,
      changedFiles,
      illegalSuccessfulTools,
    },
  };
}

interface AuditSnapshot {
  contents: string;
  sha256: string | null;
  records: readonly Readonly<Record<string, unknown>>[];
}

async function readAuditSnapshot(auditPath: string): Promise<AuditSnapshot> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(auditPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { contents: "", sha256: null, records: [] };
    }
    throw error;
  }
  const contents = bytes.toString("utf8");
  const records = contents.split(/\r?\n/u).filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("评测 audit 包含无效事件对象。");
    }
    return value as Readonly<Record<string, unknown>>;
  });
  return { contents, sha256: sha256(bytes), records };
}

async function writePublicTrace(
  tracePath: string,
  audit: AuditSnapshot,
  workspaceRoot: string,
  metrics: readonly ModelCallMetric[],
): Promise<string> {
  const records = [
    ...audit.records.map((record, index) => publicAuditEvent(record, index + 1, workspaceRoot)),
    ...metrics.map(publicModelEvent),
  ];
  const contents = records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.writeFile(tracePath, contents, { encoding: "utf8", flag: "wx" });
  return sha256(contents);
}

function parseIntegrity(value: unknown): EvaluationTrialResultIntegrity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("trial-result SHA-256 sidecar 不是对象。");
  }
  const candidate = value as Partial<EvaluationTrialResultIntegrity>;
  if (candidate.schemaVersion !== 1 || candidate.algorithm !== "sha256" ||
      candidate.resultFile !== EVALUATION_TRIAL_RESULT_FILENAME ||
      typeof candidate.resultSha256 !== "string" || !SHA256_PATTERN.test(candidate.resultSha256)) {
    throw new Error("trial-result SHA-256 sidecar 格式无效。");
  }
  return candidate as EvaluationTrialResultIntegrity;
}

function parseTrialResult(value: unknown): EvaluationTrialResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("trial-result.json 不是对象。");
  }
  const candidate = value as Partial<EvaluationTrialResult>;
  if (candidate.schemaVersion !== 1 || typeof candidate.taskId !== "string" ||
      typeof candidate.planSha256 !== "string" || !SHA256_PATTERN.test(candidate.planSha256) ||
      typeof candidate.publicConfigSha256 !== "string" ||
      !SHA256_PATTERN.test(candidate.publicConfigSha256) ||
      typeof candidate.trialConfirmationSha256 !== "string" ||
      !SHA256_PATTERN.test(candidate.trialConfirmationSha256) ||
      (candidate.profileId !== "deepseek" && candidate.profileId !== "openai-compatible") ||
      typeof candidate.arm !== "string" ||
      !(EVALUATION_ARMS as readonly string[]).includes(candidate.arm) ||
      !Number.isSafeInteger(candidate.trial) || (candidate.trial ?? 0) < 1 ||
      (candidate.trial ?? 0) > EVALUATION_TRIALS || typeof candidate.status !== "string" ||
      !TRIAL_STATUSES.has(candidate.status)) {
    throw new Error("trial-result.json 格式无效。");
  }
  const result = candidate as EvaluationTrialResult;
  if (result.trialConfirmationSha256 !== hashEvaluationTrialConfirmation({
    planSha256: result.planSha256,
    publicConfigSha256: result.publicConfigSha256,
    profileId: result.profileId,
    taskId: result.taskId,
    arm: result.arm,
    trial: result.trial,
  })) {
    throw new Error("trial-result.json 的确认摘要与结果身份不一致。");
  }
  return result;
}

export async function readVerifiedEvaluationTrialResult(
  resultPath: string,
  expectedSha256?: string,
): Promise<{ result: EvaluationTrialResult; integrity: EvaluationTrialResultIntegrity }> {
  if (path.basename(resultPath) !== EVALUATION_TRIAL_RESULT_FILENAME) {
    throw new Error(`评测结果文件名必须是 ${EVALUATION_TRIAL_RESULT_FILENAME}。`);
  }
  if (expectedSha256 !== undefined && !SHA256_PATTERN.test(expectedSha256)) {
    throw new Error("expectedSha256 必须是 64 位小写 SHA-256。");
  }
  const integrityPath = path.join(
    path.dirname(resultPath),
    EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME,
  );
  const [contents, integrityContents] = await Promise.all([
    fs.readFile(resultPath, "utf8"),
    fs.readFile(integrityPath, "utf8"),
  ]);
  const integrity = parseIntegrity(JSON.parse(integrityContents) as unknown);
  const actualSha256 = sha256(contents);
  if (integrity.resultSha256 !== actualSha256 ||
      (expectedSha256 !== undefined && expectedSha256 !== actualSha256)) {
    throw new Error("trial-result.json 的 SHA-256 完整性校验失败。");
  }
  return {
    result: parseTrialResult(JSON.parse(contents) as unknown),
    integrity,
  };
}

function resultIntegrity(contents: string): EvaluationTrialResultIntegrity {
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    resultFile: EVALUATION_TRIAL_RESULT_FILENAME,
    resultSha256: sha256(contents),
  };
}

async function removePrivateGraderArtifacts(runRoot: string, auditPath: string): Promise<void> {
  await fs.rm(auditPath, { force: true });
  const graderRoot = path.join(runRoot, "grader");
  try {
    const graderStats = await fs.lstat(graderRoot);
    if (graderStats.isDirectory() && !graderStats.isSymbolicLink() &&
        normalizedPath(await fs.realpath(graderRoot)) === normalizedPath(graderRoot)) {
      await fs.rm(graderRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function runEvaluationTrial(
  options: RunEvaluationTrialOptions,
): Promise<EvaluationTrialResult> {
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? EVALUATION_BUDGET.wallClockTimeoutMs;
  const started = performance.now();
  const observedEvents: AgentEvent[] = [];
  const observedModelMetrics: ModelCallMetric[] = [];
  const controller = new AbortController();
  let termination: "timed_out" | "cancelled" | null = null;
  const onExternalAbort = () => {
    if (termination !== null) return;
    termination = "cancelled";
    controller.abort(new Error("evaluation cancelled"));
  };
  if (options.signal?.aborted) onExternalAbort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    if (termination !== null) return;
    termination = "timed_out";
    controller.abort(new Error("evaluation wall-clock timeout"));
  }, timeoutMs);

  let runResult: AgentRunResult | undefined;
  let agentErrored = false;
  let grade: EvaluationGradeResult | undefined;
  let gradingErrored = false;
  let auditSnapshot: AuditSnapshot = { contents: "", sha256: null, records: [] };
  let auditSha256: string | null = null;
  let traceSha256 = sha256("");
  let artifactsRoot = "";
  let resultPath = "";
  let integrityPath = "";
  let auditPath = "";
  let fixturePrepared = false;
  let privateArtifactsRemoved = false;
  let fixture: Awaited<ReturnType<typeof prepareEvaluationFixture>> | undefined;

  try {
    const preparedFixture = await prepareEvaluationFixture({
      taskId: options.taskId,
      runRoot: options.runRoot,
      resetExisting: options.resetExisting,
    });
    fixture = preparedFixture;
    fixturePrepared = true;
    artifactsRoot = path.resolve(
      options.artifactsRoot ?? path.join(preparedFixture.runRoot, EVALUATION_ARTIFACTS_DIRECTORY),
    );
    if (isSameOrInside(preparedFixture.workspaceRoot, artifactsRoot)) {
      throw new Error("评测公开 artifacts 不能位于 Agent workspace 内。");
    }
    await fs.mkdir(artifactsRoot);
    auditPath = path.join(preparedFixture.runRoot, "audit.jsonl");
    const tracePath = path.join(artifactsRoot, "trace.sanitized.jsonl");
    resultPath = path.join(artifactsRoot, EVALUATION_TRIAL_RESULT_FILENAME);
    integrityPath = path.join(artifactsRoot, EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME);

    if (!controller.signal.aborted) {
      try {
        const agent = await createEvaluationArmAgent({
          arm: options.arm,
          fixture: preparedFixture,
          auditPath,
          profileId: options.profileId,
          model: observeModelCalls(
            options.model,
            options.modelMetrics ?? [],
            observedModelMetrics,
          ),
          onEvent: (event) => observedEvents.push(event),
        });
        runResult = await agent.run(preparedFixture.task.prompt, { signal: controller.signal });
      } catch {
        agentErrored = true;
      }
    }

    if (runResult && !controller.signal.aborted) {
      try {
        grade = await gradeEvaluationRun({
          runRoot: preparedFixture.runRoot,
          runResult,
          auditPath,
          formalRun: true,
          signal: controller.signal,
        });
      } catch {
        gradingErrored = true;
      }
    }

    auditSnapshot = await readAuditSnapshot(auditPath);
    const claimedAuditSha256 = grade?.evidence?.auditSha256 !== undefined
      ? grade.evidence.auditSha256
      : undefined;
    if (claimedAuditSha256 !== undefined && claimedAuditSha256 !== auditSnapshot.sha256) {
      gradingErrored = true;
      grade = undefined;
      auditSha256 = auditSnapshot.sha256;
    } else {
      auditSha256 = claimedAuditSha256 === undefined ? auditSnapshot.sha256 : claimedAuditSha256;
    }
    traceSha256 = await writePublicTrace(
      tracePath,
      auditSnapshot,
      preparedFixture.workspaceRoot,
      observedModelMetrics,
    );
    await removePrivateGraderArtifacts(preparedFixture.runRoot, auditPath);
    privateArtifactsRemoved = true;

    // The timeout remains armed through the exact public result and sidecar
    // writes. If it fires during that commit, rewrite the owned files once with
    // the final termination class before returning.
    let firstWrite = true;
    while (true) {
      const terminationAtSerialization: "timed_out" | "cancelled" | null = termination;
      const result = buildTrialResult(performance.now() - started);
      const resultContents = `${JSON.stringify(result, null, 2)}\n`;
      const integrity = resultIntegrity(resultContents);
      const flag = firstWrite ? "wx" : "w";
      await Promise.all([
        fs.writeFile(resultPath, resultContents, { encoding: "utf8", flag }),
        fs.writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, {
          encoding: "utf8",
          flag,
        }),
      ]);
      firstWrite = false;
      if (termination === terminationAtSerialization) return result;
    }
  } finally {
    try {
      if (fixturePrepared && fixture && !privateArtifactsRemoved) {
        await removePrivateGraderArtifacts(fixture.runRoot, auditPath);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  function buildTrialResult(durationMs: number): EvaluationTrialResult {
    const preparedFixture = fixture;
    if (!preparedFixture) {
      throw new Error("评测 fixture 尚未完成，不能生成 trial result。");
    }
    const status: TrialStatus = termination === "timed_out"
      ? "timed_out"
      : termination === "cancelled"
        ? "cancelled"
        : gradingErrored
          ? "grading_error"
          : agentErrored
            ? "agent_error"
            : grade?.passed ? "passed" : "failed";
    const failureCode = status === "timed_out"
      ? "wall_clock_timeout"
      : status === "cancelled"
        ? "evaluation_cancelled"
        : status === "grading_error"
          ? "grading_error"
          : status === "agent_error"
            ? "agent_error"
            : grade?.primaryFailure?.code ?? null;
    const publicGrade = termination === null && !gradingErrored && !agentErrored
      ? publicGradeResult(grade, preparedFixture.task.allowedChangedFiles)
      : null;
    return {
      schemaVersion: 1,
      suite: { id: EVALUATION_SUITE_ID, version: EVALUATION_SUITE_VERSION },
      taskId: preparedFixture.task.id,
      category: preparedFixture.task.category,
      flow: preparedFixture.task.flow,
      arm: options.arm,
      trial: options.trial,
      profileId: options.profileId,
      planSha256: options.confirmation.planSha256,
      publicConfigSha256: options.publicConfigSha256,
      trialConfirmationSha256: options.confirmation.trialSha256,
      fixtureSha256: preparedFixture.marker.fixtureSha256,
      taskSpecSha256: preparedFixture.marker.taskSpecSha256,
      status,
      durationMs,
      timedOut: status === "timed_out",
      agentCompleted: observedEvents.some((event) => event.type === "agent_completed"),
      model: modelSummary(observedModelMetrics),
      tools: toolSummary(observedEvents),
      repair: {
        proposed: observedEvents.filter((event) => event.type === "repair_proposed").length,
        approved: observedEvents.filter((event) =>
          event.type === "repair_decision" && event.decision === "approved"
        ).length,
      },
      grade: publicGrade,
      failureCode,
      artifacts: {
        auditSha256,
        traceSha256,
      },
    };
  }
}
