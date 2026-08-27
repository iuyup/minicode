import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ChatModel } from "../agent/contracts.ts";
import {
  OpenAiCompatibleModel,
  type ModelCallMetric,
} from "../models/openai-compatible-model.ts";
import { resolveOpenAiCompatibleProfile } from "../models/model-profiles.ts";
import {
  createEvaluationConfig,
  EVALUATION_ARMS,
  EVALUATION_BUDGET,
  EVALUATION_TRIALS,
  type CreateEvaluationConfigOptions,
  type EvaluationArm,
  type EvaluationConfig,
} from "./eval-config.ts";
import { EVALUATION_ARTIFACTS_DIRECTORY } from "./eval-fixture.ts";
import {
  createEvaluationAggregateReport,
  hashEvaluationReportPlan,
  writeEvaluationAggregateReport,
  type EvaluationAggregateReport,
} from "./eval-report.ts";
import {
  EVALUATION_TRIAL_RESULT_FILENAME,
  EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME,
  hashEvaluationTrialConfirmation,
  readVerifiedEvaluationTrialResult,
  runEvaluationTrial,
  type EvaluationTrialResult,
} from "./eval-runner.ts";
import {
  captureEvaluationSourceProvenance,
  sameEvaluationSourceProvenance,
  type EvaluationSourceProvenance,
} from "./eval-provenance.ts";
import { evaluationTasks, getEvaluationTask } from "./task-definitions.ts";
import { resolvePlainPath } from "./path-safety.ts";

type EvaluationProfileId = "deepseek" | "openai-compatible";

export interface EvaluationMatrixEntry {
  taskId: string;
  arm: EvaluationArm;
  trial: number;
}

export interface EvaluationSuitePlan {
  planSha256: string;
  profileId: EvaluationProfileId;
  publicConfigSha256: string;
  source: EvaluationSourceProvenance;
  tasks: readonly string[];
  arms: readonly EvaluationArm[];
  trialsPerCell: typeof EVALUATION_TRIALS;
  totalTrials: number;
  maximumWallClockMs: number;
  entries: readonly EvaluationMatrixEntry[];
  sendsNetworkRequests: true;
  apiKeyReadDuringPlanning: false;
}

export interface EvaluationModelInstance {
  model: ChatModel;
  metrics: ModelCallMetric[];
}

export type EvaluationModelFactory = (
  entry: EvaluationMatrixEntry,
) => EvaluationModelInstance | Promise<EvaluationModelInstance>;

export interface CreateEvaluationSuitePlanOptions {
  profileId: EvaluationProfileId;
  taskIds?: readonly string[];
  arms?: readonly EvaluationArm[];
  environment?: NodeJS.ProcessEnv;
  pricing?: CreateEvaluationConfigOptions["pricing"];
}

export interface RunEvaluationSuiteOptions extends CreateEvaluationSuitePlanOptions {
  outputRoot: string;
  /** Must exactly match the reviewed planSha256, including for injected models. */
  confirmRealModel?: string;
  modelFactory?: EvaluationModelFactory;
  signal?: AbortSignal;
  onTrialCompleted?: (
    result: EvaluationTrialResult,
    completed: number,
    total: number,
  ) => void;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export interface EvaluationSuiteRunResult {
  plan: EvaluationSuitePlan;
  configuration: EvaluationConfig;
  trials: readonly EvaluationTrialResult[];
  report: EvaluationAggregateReport;
}

function unique<T extends string>(values: readonly T[], label: string): T[] {
  const normalized = [...values];
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}不能重复。`);
  return normalized;
}

function selectedTasks(taskIds: readonly string[] | undefined): string[] {
  const selected = unique(taskIds ?? evaluationTasks.map((task) => task.id), "taskIds");
  if (selected.length === 0) throw new Error("至少选择一个评测任务。");
  for (const taskId of selected) {
    if (!getEvaluationTask(taskId)) throw new Error(`未知评测任务：${taskId}。`);
  }
  return selected;
}

function selectedArms(arms: readonly EvaluationArm[] | undefined): EvaluationArm[] {
  const selected = unique(arms ?? EVALUATION_ARMS, "arms");
  if (selected.length === 0) throw new Error("至少选择一个评测 arm。");
  for (const arm of selected) {
    if (!(EVALUATION_ARMS as readonly string[]).includes(arm)) throw new Error(`未知评测 arm：${arm}。`);
  }
  return selected;
}

export async function createEvaluationSuitePlan(
  options: CreateEvaluationSuitePlanOptions,
): Promise<{ plan: EvaluationSuitePlan; configuration: EvaluationConfig }> {
  const tasks = selectedTasks(options.taskIds);
  const arms = selectedArms(options.arms);
  const source = await captureEvaluationSourceProvenance();
  const configuration = createEvaluationConfig({
    profileId: options.profileId,
    environment: options.environment,
    pricing: options.pricing,
  });
  const entries: EvaluationMatrixEntry[] = [];
  for (const taskId of tasks) {
    for (const arm of arms) {
      for (let trial = 1; trial <= EVALUATION_TRIALS; trial += 1) {
        entries.push({ taskId, arm, trial });
      }
    }
  }
  const planWithoutHash = {
    profileId: options.profileId,
    publicConfigSha256: configuration.publicConfigSha256,
    source,
    tasks,
    arms,
    trialsPerCell: EVALUATION_TRIALS,
    totalTrials: entries.length,
    maximumWallClockMs: entries.length * EVALUATION_BUDGET.wallClockTimeoutMs,
    entries,
    sendsNetworkRequests: true as const,
    apiKeyReadDuringPlanning: false as const,
  };
  const plan: EvaluationSuitePlan = {
    planSha256: hashEvaluationReportPlan(planWithoutHash),
    ...planWithoutHash,
  };
  return { configuration, plan };
}

function builtInModelFactory(
  profileId: EvaluationProfileId,
  environment: NodeJS.ProcessEnv,
): EvaluationModelFactory {
  const resolved = resolveOpenAiCompatibleProfile(profileId, environment);
  return () => {
    const metrics: ModelCallMetric[] = [];
    return {
      metrics,
      model: new OpenAiCompatibleModel({
        apiKey: resolved.apiKey,
        baseUrl: resolved.profile.baseUrl,
        model: resolved.profile.model,
        providerName: resolved.profile.label,
        apiKeyEnvironmentVariable: resolved.profile.apiKeyEnvironmentVariable,
        disableThinking: resolved.profile.disableThinking,
        allowInsecureHttp: resolved.allowInsecureHttp,
        maxTokens: EVALUATION_BUDGET.maxOutputTokensPerRequest,
        onCallMetric: (metric) => metrics.push(metric),
      }),
    };
  };
}

async function assertNewOutputRoot(outputRoot: string): Promise<string> {
  const resolved = await resolvePlainPath(outputRoot, "评测 suite 输出目录");
  try {
    await fs.lstat(resolved);
    throw new Error("评测 suite 输出目录已存在；正式运行不会覆盖或续跑。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(resolved, { recursive: false });
  if (!samePath(await resolvePlainPath(resolved, "评测 suite 输出目录"), resolved)) {
    throw new Error("评测 suite 输出目录经过链接或 junction，拒绝运行。");
  }
  return resolved;
}

function safeSegment(value: string): string {
  if (!/^[a-z0-9-]+$/u.test(value)) throw new Error(`评测目录片段不安全：${value}。`);
  return value;
}

function trialIdentity(result: Pick<EvaluationTrialResult, "taskId" | "arm" | "trial">): string {
  return `${result.taskId}\0${result.arm}\0${result.trial}`;
}

function publicTrialIndex(
  results: readonly EvaluationTrialResult[],
  resultHashes: ReadonlyMap<string, string>,
): readonly Record<string, unknown>[] {
  return results.map((result) => ({
    taskId: result.taskId,
    arm: result.arm,
    trial: result.trial,
    planSha256: result.planSha256,
    source: result.source,
    trialConfirmationSha256: result.trialConfirmationSha256,
    status: result.status,
    failureCode: result.failureCode,
    fixtureSha256: result.fixtureSha256,
    taskSpecSha256: result.taskSpecSha256,
    auditSha256: result.artifacts.auditSha256,
    traceSha256: result.artifacts.traceSha256,
    resultSha256: resultHashes.get(trialIdentity(result)) ?? null,
    resultPath: `trials/${result.taskId}/${result.arm}/trial-${result.trial}/artifacts/${EVALUATION_TRIAL_RESULT_FILENAME}`,
    resultIntegrityPath: `trials/${result.taskId}/${result.arm}/trial-${result.trial}/artifacts/${EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME}`,
    tracePath: `trials/${result.taskId}/${result.arm}/trial-${result.trial}/artifacts/trace.sanitized.jsonl`,
  }));
}

export async function runEvaluationSuite(
  options: RunEvaluationSuiteOptions,
): Promise<EvaluationSuiteRunResult> {
  const { plan, configuration } = await createEvaluationSuitePlan(options);
  const confirmedPlanSha256 = options.confirmRealModel;
  if (confirmedPlanSha256 !== plan.planSha256) {
    throw new Error("真实模型评测确认摘要与当前矩阵不一致；尚未读取 API Key，也未发送网络请求。");
  }
  const currentSource = await captureEvaluationSourceProvenance();
  if (!sameEvaluationSourceProvenance(plan.source, currentSource)) {
    throw new Error("评测源码来源快照已改变；尚未读取 API Key，也未发送网络请求。");
  }
  const factory = options.modelFactory ?? builtInModelFactory(
    options.profileId,
    options.environment ?? process.env,
  );
  const outputRoot = await assertNewOutputRoot(options.outputRoot);
  await Promise.all([
    fs.writeFile(path.join(outputRoot, "public-config.json"), configuration.publicConfigJson, {
      encoding: "utf8",
      flag: "wx",
    }),
    fs.writeFile(path.join(outputRoot, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);

  const results: EvaluationTrialResult[] = [];
  const resultHashes = new Map<string, string>();
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-private-"));
  try {
    for (const entry of plan.entries) {
      if (options.signal?.aborted) throw new Error("评测 suite 已取消。");
      const instance = await factory(entry);
      const relativeTrialPath = path.join(
        "trials",
        safeSegment(entry.taskId),
        safeSegment(entry.arm),
        `trial-${entry.trial}`,
      );
      const runRoot = path.join(privateRoot, relativeTrialPath);
      const publicTrialRoot = path.join(outputRoot, relativeTrialPath);
      await Promise.all([
        fs.mkdir(path.dirname(runRoot), { recursive: true }),
        fs.mkdir(publicTrialRoot, { recursive: true }),
      ]);
      const result = await runEvaluationTrial({
        ...entry,
        profileId: options.profileId,
        source: plan.source,
        publicConfigSha256: configuration.publicConfigSha256,
        confirmation: {
          planSha256: plan.planSha256,
          confirmedPlanSha256,
          trialSha256: hashEvaluationTrialConfirmation({
            planSha256: plan.planSha256,
            publicConfigSha256: configuration.publicConfigSha256,
            profileId: options.profileId,
            taskId: entry.taskId,
            arm: entry.arm,
            trial: entry.trial,
          }),
        },
        runRoot,
        artifactsRoot: path.join(publicTrialRoot, EVALUATION_ARTIFACTS_DIRECTORY),
        model: instance.model,
        modelMetrics: instance.metrics,
        signal: options.signal,
      });
      const resultPath = path.join(
        publicTrialRoot,
        EVALUATION_ARTIFACTS_DIRECTORY,
        EVALUATION_TRIAL_RESULT_FILENAME,
      );
      const verified = await readVerifiedEvaluationTrialResult(resultPath);
      if (JSON.stringify(verified.result) !== JSON.stringify(result)) {
        throw new Error(`trial ${entry.taskId}/${entry.arm}/${entry.trial} 的内存结果与落盘证据不一致。`);
      }
      results.push(verified.result);
      resultHashes.set(trialIdentity(verified.result), verified.integrity.resultSha256);
      options.onTrialCompleted?.(verified.result, results.length, plan.totalTrials);
    }
  } finally {
    await fs.rm(privateRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  const report = createEvaluationAggregateReport(configuration, plan, results);
  await Promise.all([
    writeEvaluationAggregateReport(outputRoot, report),
    fs.writeFile(path.join(outputRoot, "results-index.json"), `${JSON.stringify(publicTrialIndex(results, resultHashes), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  return { plan, configuration, trials: results, report };
}
