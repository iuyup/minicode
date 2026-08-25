import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChatModel, ModelRequest, ModelResponse, ToolCall } from "../src/agent/contracts.ts";
import {
  EVALUATION_TRIAL_RESULT_FILENAME,
  EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME,
  hashEvaluationTrialConfirmation,
  readVerifiedEvaluationTrialResult,
  runEvaluationTrial,
  type EvaluationTrialConfirmation,
} from "../src/evals/eval-runner.ts";
import { getEvaluationTask } from "../src/evals/task-definitions.ts";
import {
  OpenAiCompatibleModel,
  type ModelCallMetric,
} from "../src/models/openai-compatible-model.ts";

class SuccessfulTrialModel implements ChatModel {
  readonly #brokenSource: string;
  readonly #expectedSource: string;
  readonly #metrics?: ModelCallMetric[];
  readonly #onFinal?: () => void;
  #toolIndex = 0;
  #callIndex = 0;

  constructor(
    brokenSource: string,
    expectedSource: string,
    metrics?: ModelCallMetric[],
    onFinal?: () => void,
  ) {
    this.#brokenSource = brokenSource;
    this.#expectedSource = expectedSource;
    this.#metrics = metrics;
    this.#onFinal = onFinal;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.#callIndex += 1;
    let response: ModelResponse;
    if (request.phase === "planning") {
      response = { kind: "final", content: "读取目标，应用最小补丁，运行固定测试。" };
    } else {
      const calls: ToolCall[] = [
        { id: "runner-read-secret-looking-id", name: "read_file", input: { path: "src/implementation.js" } },
        {
          id: "runner-patch-secret-looking-id",
          name: "apply_patch",
          input: {
            path: "src/implementation.js",
            oldText: this.#brokenSource,
            newText: this.#expectedSource,
          },
        },
        { id: "runner-test-secret-looking-id", name: "run_project_check", input: { action: "test" } },
      ];
      const call = calls[this.#toolIndex++];
      response = call
        ? { kind: "tool_calls", content: "private model text", toolCalls: [call] }
        : { kind: "final", content: "修改已完成，测试已通过。private final text" };
      if (!call) this.#onFinal?.();
    }
    this.#metrics?.push({
      callIndex: this.#callIndex,
      phase: request.phase ?? "execution",
      startedAt: "2026-08-24T00:00:00.000Z",
      latencyMs: 12,
      outcome: "success",
      errorCategory: null,
      httpStatus: null,
      finishReason: "provider-secret-finish",
      responseKind: response.kind,
      usageSource: "provider",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 120,
      ttftMs: null,
    });
    return response;
  }
}

async function mutateAuditAfterGraderRead(runRoot: string): Promise<boolean> {
  const graderRoot = path.join(runRoot, "grader");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const attempts = await fs.readdir(graderRoot, { withFileTypes: true });
      for (const attempt of attempts) {
        if (!attempt.isDirectory() || !attempt.name.startsWith("attempt-")) continue;
        const files = await fs.readdir(path.join(graderRoot, attempt.name));
        if (files.includes("hidden-oracle-output.txt") || files.includes("public-test-output.txt")) {
          await fs.appendFile(
            path.join(runRoot, "audit.jsonl"),
            `${JSON.stringify({ type: "agent_stopped", step: 999 })}\n`,
            "utf8",
          );
          return true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

class ThrowingModel implements ChatModel {
  async complete(): Promise<ModelResponse> {
    throw new Error("provider-private-error-body");
  }
}

class PartialUsageThenErrorModel implements ChatModel {
  readonly #metrics: ModelCallMetric[];
  #calls = 0;

  constructor(metrics: ModelCallMetric[]) {
    this.#metrics = metrics;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.#calls += 1;
    if (this.#calls === 1) {
      this.#metrics.push({
        callIndex: 1,
        phase: request.phase ?? "execution",
        startedAt: "2026-08-24T00:00:00.000Z",
        latencyMs: 999,
        outcome: "success",
        errorCategory: null,
        httpStatus: null,
        finishReason: "stop",
        responseKind: "tool_calls",
        usageSource: "provider",
        inputTokens: 50,
        cachedInputTokens: null,
        outputTokens: 10,
        totalTokens: 60,
        ttftMs: null,
      });
      return {
        kind: "tool_calls",
        content: "private first-call content",
        toolCalls: [{
          id: "partial-usage-read",
          name: "read_file",
          input: { path: "src/implementation.js" },
        }],
      };
    }
    throw new Error("private second-call failure");
  }
}

const PLAN_SHA256 = "c".repeat(64);
const TEST_SOURCE = {
  schemaVersion: 1 as const,
  sourceCommit: "a".repeat(40),
  dirty: false,
  dirtyStateSha256: "b".repeat(64),
};

function confirmation(
  taskId: string,
  arm: "baseline-3tool",
  trial: number,
  publicConfigSha256: string,
): EvaluationTrialConfirmation {
  return {
    planSha256: PLAN_SHA256,
    confirmedPlanSha256: PLAN_SHA256,
    trialSha256: hashEvaluationTrialConfirmation({
      planSha256: PLAN_SHA256,
      publicConfigSha256,
      profileId: "deepseek",
      taskId,
      arm,
      trial,
    }),
  };
}

test("runEvaluationTrial writes a strict grade and content-free public artifacts", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-runner-"));
  try {
    const task = getEvaluationTask("greeting-punctuation");
    if (!task || task.category !== "functional") throw new Error("需要功能题。 ");
    const metrics: ModelCallMetric[] = [{
      callIndex: 1,
      phase: "execution",
      startedAt: "2026-08-24T00:00:00.000Z",
      latencyMs: 12,
      outcome: "success",
      errorCategory: null,
      httpStatus: null,
      finishReason: "provider-secret-finish",
      responseKind: "tool_calls",
      usageSource: "provider",
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      totalTokens: 120,
      ttftMs: null,
    }];
    const result = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256: "a".repeat(64),
      confirmation: confirmation(task.id, "baseline-3tool", 1, "a".repeat(64)),
      runRoot: path.join(tempRoot, "run"),
      model: new SuccessfulTrialModel(
        task.workspaceFiles[task.targetPath],
        task.expectedSource,
        metrics,
      ),
      modelMetrics: metrics,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.grade?.passed, true);
    assert.equal(result.planSha256, PLAN_SHA256);
    assert.deepEqual(result.source, TEST_SOURCE);
    assert.equal(
      result.trialConfirmationSha256,
      confirmation(task.id, "baseline-3tool", 1, "a".repeat(64)).trialSha256,
    );
    assert.equal(result.artifacts.auditSha256, result.grade?.evidence?.auditSha256);
    assert.equal(result.model.calls, 4);
    assert.equal(result.model.totalTokens, 480);
    assert.equal(result.tools.requested, 3);
    assert.equal(result.tools.succeeded, 3);
    assert.equal(result.artifacts.auditSha256?.length, 64);
    assert.equal(result.artifacts.traceSha256.length, 64);

    const artifactsRoot = path.join(tempRoot, "run", "artifacts");
    const trace = await fs.readFile(path.join(artifactsRoot, "trace.sanitized.jsonl"), "utf8");
    const resultPath = path.join(artifactsRoot, EVALUATION_TRIAL_RESULT_FILENAME);
    const persisted = await fs.readFile(resultPath, "utf8");
    for (const forbidden of [
      "private model text",
      "private final text",
      "runner-read-secret-looking-id",
      "provider-secret-finish",
      task.expectedSource,
      tempRoot,
    ]) {
      assert.equal(trace.includes(forbidden), false, `trace leaked: ${forbidden}`);
      assert.equal(persisted.includes(forbidden), false, `result leaked: ${forbidden}`);
    }
    assert.match(trace, /toolCallIdSha256/u);
    assert.equal(trace.includes("src/implementation.js"), false);
    assert.equal("graderArtifactsDirectory" in (result.grade ?? {}), false);
    const verified = await readVerifiedEvaluationTrialResult(resultPath);
    assert.deepEqual(verified.result, result);
    assert.equal(verified.integrity.resultSha256.length, 64);
    const sidecar = await fs.readFile(
      path.join(artifactsRoot, EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME),
      "utf8",
    );
    assert.match(sidecar, /"resultSha256": "[a-f0-9]{64}"/u);
    await assert.rejects(fs.lstat(path.join(tempRoot, "run", "audit.jsonl")), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(tempRoot, "run", "grader")), { code: "ENOENT" });

    await fs.appendFile(resultPath, " ", "utf8");
    await assert.rejects(readVerifiedEvaluationTrialResult(resultPath), /完整性/u);
    const identityTamper = JSON.parse(persisted) as Record<string, unknown>;
    identityTamper.taskId = "slug-whitespace";
    const identityTamperContents = `${JSON.stringify(identityTamper, null, 2)}\n`;
    const identityTamperSha256 = createHash("sha256")
      .update(identityTamperContents, "utf8")
      .digest("hex");
    await Promise.all([
      fs.writeFile(resultPath, identityTamperContents, "utf8"),
      fs.writeFile(
        path.join(artifactsRoot, EVALUATION_TRIAL_RESULT_INTEGRITY_FILENAME),
        `${JSON.stringify({
          schemaVersion: 1,
          algorithm: "sha256",
          resultFile: EVALUATION_TRIAL_RESULT_FILENAME,
          resultSha256: identityTamperSha256,
        }, null, 2)}\n`,
        "utf8",
      ),
    ]);
    await assert.rejects(readVerifiedEvaluationTrialResult(resultPath), /确认摘要/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runEvaluationTrial rejects non-formal trial numbers and oversized timeouts before writing", async () => {
  const task = getEvaluationTask("greeting-punctuation");
  if (!task || task.category !== "functional") throw new Error("需要功能题。 ");
  const base = {
    taskId: task.id,
    arm: "baseline-3tool" as const,
    profileId: "deepseek" as const,
    source: TEST_SOURCE,
    publicConfigSha256: "b".repeat(64),
    confirmation: confirmation(task.id, "baseline-3tool", 1, "b".repeat(64)),
    runRoot: path.join(os.tmpdir(), `minicode-invalid-runner-${Date.now()}`),
    model: new SuccessfulTrialModel(task.workspaceFiles[task.targetPath], task.expectedSource),
  };
  await assert.rejects(runEvaluationTrial({ ...base, trial: 0 }), /trial/u);
  await assert.rejects(runEvaluationTrial({ ...base, trial: 1, timeoutMs: 180_001 }), /超时/u);
  await assert.rejects(runEvaluationTrial({ ...base, trial: 2 }), /确认摘要/u);
  const { confirmation: _confirmation, ...withoutConfirmation } = base;
  await assert.rejects(
    runEvaluationTrial({
      ...withoutConfirmation,
      trial: 1,
    } as unknown as Parameters<typeof runEvaluationTrial>[0]),
    /plan 绑定摘要/u,
  );
});

test("runEvaluationTrial publishes only bounded model error diagnostics", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-agent-error-"));
  try {
    const task = getEvaluationTask("greeting-punctuation");
    if (!task) throw new Error("需要评测题。");
    const publicConfigSha256 = "d".repeat(64);
    const metrics: ModelCallMetric[] = [];
    const privateBody = "provider-private-error-body";
    const result = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256,
      confirmation: confirmation(task.id, "baseline-3tool", 1, publicConfigSha256),
      runRoot: path.join(tempRoot, "run"),
      model: new OpenAiCompatibleModel({
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        providerName: "Test provider",
        onCallMetric: (metric) => metrics.push(metric),
        fetchImplementation: async () => new Response(
          JSON.stringify({ error: { message: privateBody } }),
          { status: 401, headers: { "content-type": "application/json", "x-private": privateBody } },
        ),
      }),
      modelMetrics: metrics,
    });
    assert.equal(result.status, "agent_error");
    assert.equal(result.failureCode, "agent_error");
    assert.equal(result.grade, null);
    assert.equal(result.model.calls, 1);
    assert.equal(result.model.failed, 1);
    assert.equal(result.model.errorCategories.auth, 1);
    assert.equal(result.model.errorCategories.unknown, 0);
    assert.deepEqual(result.model.httpStatusCounts, { 401: 1 });
    assert.equal(result.model.inputTokens, null);
    assert.equal(result.model.outputTokens, null);
    const persisted = await fs.readFile(
      path.join(tempRoot, "run", "artifacts", EVALUATION_TRIAL_RESULT_FILENAME),
      "utf8",
    );
    const trace = await fs.readFile(
      path.join(tempRoot, "run", "artifacts", "trace.sanitized.jsonl"),
      "utf8",
    );
    for (const publicArtifact of [persisted, trace]) {
      assert.equal(publicArtifact.includes(privateBody), false);
      assert.equal(publicArtifact.includes("example.test"), false);
      assert.equal(publicArtifact.includes("test-key"), false);
    }
    assert.match(trace, /"errorCategory":"auth"/u);
    assert.match(trace, /"httpStatus":401/u);
    assert.match(trace, /"stopReasonCode":"model_request_failed"/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("partial provider usage never counts an unavailable call as zero tokens", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-partial-usage-"));
  try {
    const task = getEvaluationTask("greeting-punctuation");
    if (!task) throw new Error("需要评测题。");
    const publicConfigSha256 = "2".repeat(64);
    const metrics: ModelCallMetric[] = [];
    const result = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256,
      confirmation: confirmation(task.id, "baseline-3tool", 1, publicConfigSha256),
      runRoot: path.join(tempRoot, "run"),
      model: new PartialUsageThenErrorModel(metrics),
      modelMetrics: metrics,
    });
    assert.equal(result.status, "agent_error");
    assert.equal(result.model.calls, 2);
    assert.equal(result.model.succeeded, 1);
    assert.equal(result.model.failed, 1);
    assert.equal(result.model.usageStatus, "partial");
    assert.equal(result.model.inputTokens, null);
    assert.equal(result.model.cachedInputTokens, null);
    assert.equal(result.model.outputTokens, null);
    assert.equal(result.model.totalTokens, null);
    assert.notEqual(result.model.latencyMs, 999);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runEvaluationTrial gives timeout and cancellation priority and leaves grade null", async () => {
  const task = getEvaluationTask("greeting-punctuation");
  if (!task) throw new Error("需要评测题。");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-stop-"));
  try {
    const timeoutConfigSha256 = "e".repeat(64);
    const timedOut = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256: timeoutConfigSha256,
      confirmation: confirmation(task.id, "baseline-3tool", 1, timeoutConfigSha256),
      runRoot: path.join(tempRoot, "timeout"),
      model: new ThrowingModel(),
      timeoutMs: 1,
    });
    assert.equal(timedOut.status, "timed_out");
    assert.equal(timedOut.failureCode, "wall_clock_timeout");
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.grade, null);

    const cancellationConfigSha256 = "f".repeat(64);
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    const cancelled = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256: cancellationConfigSha256,
      confirmation: confirmation(task.id, "baseline-3tool", 1, cancellationConfigSha256),
      runRoot: path.join(tempRoot, "cancelled"),
      model: new ThrowingModel(),
      signal: controller.signal,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failureCode, "evaluation_cancelled");
    assert.equal(cancelled.timedOut, false);
    assert.equal(cancelled.grade, null);
    assert.equal(cancelled.model.calls, 0);
    const persisted = await fs.readFile(
      path.join(tempRoot, "cancelled", "artifacts", EVALUATION_TRIAL_RESULT_FILENAME),
      "utf8",
    );
    assert.equal(persisted.includes("private cancellation reason"), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("runEvaluationTrial rejects an audit replaced after the grader evidence read", async () => {
  const task = getEvaluationTask("greeting-punctuation");
  if (!task || task.category !== "functional") throw new Error("需要功能题。");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-audit-race-"));
  const runRoot = path.join(tempRoot, "run");
  let mutation: Promise<boolean> | undefined;
  try {
    const publicConfigSha256 = "1".repeat(64);
    const model = new SuccessfulTrialModel(
      task.workspaceFiles[task.targetPath],
      task.expectedSource,
      undefined,
      () => {
        mutation = mutateAuditAfterGraderRead(runRoot);
      },
    );
    const result = await runEvaluationTrial({
      taskId: task.id,
      arm: "baseline-3tool",
      trial: 1,
      profileId: "deepseek",
      source: TEST_SOURCE,
      publicConfigSha256,
      confirmation: confirmation(task.id, "baseline-3tool", 1, publicConfigSha256),
      runRoot,
      model,
    });
    assert.equal(await mutation, true);
    assert.equal(result.status, "grading_error");
    assert.equal(result.failureCode, "grading_error");
    assert.equal(result.grade, null);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
