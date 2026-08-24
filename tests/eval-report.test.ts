import assert from "node:assert/strict";
import test from "node:test";

import { createEvaluationAggregateReport, renderEvaluationReportMarkdown } from "../src/evals/eval-report.ts";
import { evaluationTaskSpecSha256 } from "../src/evals/eval-fixture.ts";
import {
  hashEvaluationTrialConfirmation,
  type EvaluationTrialResult,
} from "../src/evals/eval-runner.ts";
import { createEvaluationSuitePlan } from "../src/evals/eval-suite-runner.ts";
import { EVALUATION_SUITE_VERSION, getEvaluationTask } from "../src/evals/task-definitions.ts";

function trial(overrides: Partial<EvaluationTrialResult> & Pick<EvaluationTrialResult, "taskId" | "category" | "flow" | "arm" | "trial">): EvaluationTrialResult {
  const task = getEvaluationTask(overrides.taskId);
  if (!task) throw new Error(`unknown task fixture: ${overrides.taskId}`);
  const planSha256 = overrides.planSha256 ?? "d".repeat(64);
  const publicConfigSha256 = overrides.publicConfigSha256 ?? "c".repeat(64);
  const profileId = overrides.profileId ?? "deepseek";
  return {
    schemaVersion: 1,
    suite: { id: "minicode-js-v1", version: EVALUATION_SUITE_VERSION },
    fixtureSha256: "f".repeat(64),
    taskSpecSha256: evaluationTaskSpecSha256(task),
    status: "passed",
    durationMs: 100,
    timedOut: false,
    agentCompleted: true,
    model: {
      calls: 2,
      succeeded: 2,
      failed: 0,
      errorCategories: {
        auth: 0,
        payment: 0,
        rate_limit: 0,
        request: 0,
        provider: 0,
        network: 0,
        timeout: 0,
        cancelled: 0,
        response_validation: 0,
        unknown: 0,
      },
      httpStatusCounts: {},
      latencyMs: 80,
      usageStatus: "provider",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      totalTokens: 150,
      ttftStatus: "unavailable_non_streaming",
    },
    tools: {
      requested: 3,
      finalized: 3,
      succeeded: 3,
      failed: 0,
      byName: { read_file: { requested: 1, finalized: 1, succeeded: 1, failed: 0 } },
    },
    repair: { proposed: 0, approved: 0 },
    grade: {
      taskId: overrides.taskId,
      category: overrides.category,
      passed: true,
      primaryFailure: null,
      flags: {
        repositoryReadable: true,
        headUnchanged: true,
        branchUnchanged: true,
        indexUnchanged: true,
        gitConfigUnchanged: true,
        diffWithinAllowlist: true,
        workspaceClean: overrides.category === "safety",
        externalFilesUnchanged: true,
        forbiddenArtifactsAbsent: true,
        secretSentinelsAbsent: true,
        noIllegalSuccessfulTools: true,
        evidenceConsistent: true,
        hiddenOraclePassed: true,
        successfulVerificationObserved: true,
        failureRepairProtocolSatisfied: true,
        falseSuccessDetected: false,
        agentCompleted: true,
      },
      metrics: {
        taskId: overrides.taskId,
        category: overrides.category,
        flow: overrides.flow,
        changedFiles: [],
        eventCount: 5,
        auditEventCount: 5,
        messageCount: 5,
        answerLength: 10,
        verificationAttempts: 1,
        successfulVerifications: 1,
        externalFilesChecked: 0,
        forbiddenArtifactsFound: [],
        leakedSecretCount: 0,
        illegalSuccessfulTools: [],
        oracleExecuted: overrides.category === "functional",
        oracleExitCode: overrides.category === "functional" ? 0 : null,
        oracleDurationMs: 10,
        oracleTimedOut: false,
        oracleOutputTruncated: false,
        oraclePermissionModelEnabled: overrides.category === "functional",
      },
    },
    failureCode: null,
    artifacts: { auditSha256: "a".repeat(64), traceSha256: "b".repeat(64) },
    ...overrides,
    profileId,
    publicConfigSha256,
    planSha256,
    trialConfirmationSha256: hashEvaluationTrialConfirmation({
      planSha256,
      publicConfigSha256,
      profileId,
      taskId: overrides.taskId,
      arm: overrides.arm,
      trial: overrides.trial,
    }),
  };
}

test("aggregate report separates effectiveness, safety, repair, usage, cost, and failures", () => {
  const { configuration, plan } = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["duration-remainder", "protected-env-read"],
    arms: ["minicode-3tool"],
    environment: { DEEPSEEK_MODEL: "deepseek-test" },
    pricing: {
      snapshotId: "price-2026-08-24",
      profileId: "deepseek",
      model: "deepseek-test",
      effectiveAt: "2026-08-24T00:00:00Z",
      currency: "USD",
      inputUsdPerMillionTokens: 1,
      cachedInputUsdPerMillionTokens: 0.2,
      outputUsdPerMillionTokens: 2,
    },
  });
  const functional = [1, 2, 3].map((trialNumber) => trial({
    taskId: "duration-remainder",
    category: "functional",
    flow: "failure_repair",
    arm: "minicode-3tool",
    trial: trialNumber,
    publicConfigSha256: configuration.publicConfigSha256,
    planSha256: plan.planSha256,
    repair: { proposed: 1, approved: 1 },
  }));
  const safety = [1, 2, 3].map((trialNumber) => trial({
    taskId: "protected-env-read",
    category: "safety",
    flow: "boundary",
    arm: "minicode-3tool",
    trial: trialNumber,
    publicConfigSha256: configuration.publicConfigSha256,
    planSha256: plan.planSha256,
  }));
  safety[0] = {
    ...safety[0],
    status: "failed",
    failureCode: "secret_leaked",
    grade: {
      ...safety[0].grade!,
      passed: false,
      primaryFailure: { code: "secret_leaked", message: "redacted" },
      flags: { ...safety[0].grade!.flags, secretSentinelsAbsent: false },
    },
  };

  const report = createEvaluationAggregateReport(
    configuration,
    plan,
    [...functional, ...safety],
    "2026-08-24T01:00:00Z",
  );
  assert.equal(report.totals.passed, 5);
  assert.equal(report.totals.rate, 0.833333);
  assert.equal(report.hiddenOracle.passed, 3);
  assert.equal(report.safety.secretLeakFailures, 1);
  assert.equal(report.repair.proposals, 3);
  assert.equal(report.tools.requested, 18);
  assert.equal(report.tokens.totalTokens, 900);
  assert.equal(report.cost.status, "exact");
  assert.equal(report.cost.measuredUsd, 0.001104);
  assert.equal(report.validity.status, "scorable");
  assert.equal(report.validity.capabilityScoreValid, true);
  assert.equal(report.modelErrors.total, 0);
  assert.deepEqual(report.failures, { secret_leaked: 1 });
  const markdown = renderEvaluationReportMarkdown(report);
  assert.match(markdown, /Strict results/u);
  assert.match(markdown, /secret_leaked/u);
  assert.match(markdown, /does not claim OS sandboxing/u);
});

test("aggregate report rejects mixed configurations and duplicate trials", () => {
  const { configuration, plan } = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["greeting-punctuation"],
    arms: ["baseline-3tool"],
    environment: { DEEPSEEK_MODEL: "deepseek-test" },
  });
  const results = [1, 2, 3].map((trialNumber) => trial({
    taskId: "greeting-punctuation",
    category: "functional",
    flow: "direct",
    arm: "baseline-3tool",
    trial: trialNumber,
    publicConfigSha256: configuration.publicConfigSha256,
    planSha256: plan.planSha256,
  }));
  assert.throws(
    () => createEvaluationAggregateReport(configuration, plan, [
      { ...results[0], publicConfigSha256: "0".repeat(64) },
      results[1],
      results[2],
    ]),
    /配置摘要不匹配/u,
  );
  assert.throws(
    () => createEvaluationAggregateReport(configuration, plan, [results[0], results[0], results[2]]),
    /重复 trial/u,
  );
  assert.throws(
    () => createEvaluationAggregateReport(configuration, plan, results.slice(0, 2)),
    /结果数量.*不完整/u,
  );
  assert.throws(
    () => createEvaluationAggregateReport(configuration, plan, [
      { ...results[0], category: "safety", flow: "boundary" },
      results[1],
      results[2],
    ]),
    /内置任务定义不匹配/u,
  );
});

test("grading errors and unavailable provider usage are not reported as safety violations or exact cost", () => {
  const { configuration, plan } = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["protected-env-read"],
    arms: ["baseline-3tool"],
    environment: { DEEPSEEK_MODEL: "deepseek-test" },
    pricing: {
      snapshotId: "price-2026-08-24",
      profileId: "deepseek",
      model: "deepseek-test",
      effectiveAt: "2026-08-24T00:00:00Z",
      currency: "USD",
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 2,
    },
  });
  const results = [1, 2, 3].map((trialNumber) => trial({
    taskId: "protected-env-read",
    category: "safety",
    flow: "boundary",
    arm: "baseline-3tool",
    trial: trialNumber,
    publicConfigSha256: configuration.publicConfigSha256,
    planSha256: plan.planSha256,
    status: "grading_error",
    failureCode: "grading_error",
    agentCompleted: false,
    grade: null,
    model: {
      calls: 1,
      succeeded: 0,
      failed: 1,
      errorCategories: {
        auth: 0,
        payment: 0,
        rate_limit: 0,
        request: 0,
        provider: 0,
        network: 0,
        timeout: 0,
        cancelled: 0,
        response_validation: 0,
        unknown: 1,
      },
      httpStatusCounts: {},
      latencyMs: 10,
      usageStatus: "unavailable",
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      ttftStatus: "unavailable_non_streaming",
    },
  }));

  const report = createEvaluationAggregateReport(configuration, plan, results);
  assert.equal(report.safety.secretLeakFailures, 0);
  assert.equal(report.safety.illegalToolSuccessFailures, 0);
  assert.equal(report.tokens.status, "unavailable");
  assert.equal(report.tokens.measuredTrials, 0);
  assert.equal(report.tokens.cachedInputTokens, null);
  assert.equal(report.cost.status, "unavailable");
  assert.equal(report.cost.measuredUsd, null);
  assert.equal(report.validity.status, "not_scorable");
  assert.equal(report.validity.capabilityScoreValid, false);
});

test("first-call infrastructure failures are explicitly not a capability score", () => {
  const { configuration, plan } = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["greeting-punctuation"],
    arms: ["baseline-3tool"],
    environment: { DEEPSEEK_MODEL: "deepseek-test" },
  });
  const results = [1, 2, 3].map((trialNumber) => trial({
    taskId: "greeting-punctuation",
    category: "functional",
    flow: "direct",
    arm: "baseline-3tool",
    trial: trialNumber,
    publicConfigSha256: configuration.publicConfigSha256,
    planSha256: plan.planSha256,
    status: "agent_error",
    failureCode: "agent_error",
    agentCompleted: false,
    grade: null,
    model: {
      calls: 1,
      succeeded: 0,
      failed: 1,
      errorCategories: {
        auth: 1,
        payment: 0,
        rate_limit: 0,
        request: 0,
        provider: 0,
        network: 0,
        timeout: 0,
        cancelled: 0,
        response_validation: 0,
        unknown: 0,
      },
      httpStatusCounts: { 401: 1 },
      latencyMs: 10,
      usageStatus: "unavailable",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      ttftStatus: "unavailable_non_streaming",
    },
  }));

  const report = createEvaluationAggregateReport(configuration, plan, results);
  assert.deepEqual(report.validity, {
    status: "infrastructure_failure",
    scorableTrials: 0,
    totalTrials: 3,
    capabilityScoreValid: false,
  });
  assert.equal(report.totals.passed, 0);
  assert.deepEqual(report.failures, { agent_error: 3 });
  assert.equal(report.modelErrors.total, 3);
  assert.equal(report.modelErrors.byCategory.auth, 3);
  assert.deepEqual(report.modelErrors.httpStatusCounts, { 401: 3 });
  const markdown = renderEvaluationReportMarkdown(report);
  assert.match(markdown, /infrastructure_failure/u);
  assert.match(markdown, /not a capability score/u);
  assert.match(markdown, /auth=3/u);
  assert.match(markdown, /401=3/u);
});
