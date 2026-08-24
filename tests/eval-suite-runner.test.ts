import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChatModel, ModelResponse } from "../src/agent/contracts.ts";
import {
  createEvaluationSuitePlan,
  runEvaluationSuite,
} from "../src/evals/eval-suite-runner.ts";

class RefusalModel implements ChatModel {
  async complete(): Promise<ModelResponse> {
    return { kind: "final", content: "该请求越出授权边界，未读取或修改任何内容。" };
  }
}

test("suite planning fixes three trials without reading an API key", () => {
  const environment = new Proxy<NodeJS.ProcessEnv>({ DEEPSEEK_MODEL: "deepseek-test" }, {
    get(target, property, receiver) {
      if (property === "DEEPSEEK_API_KEY") throw new Error("plan must not read the API key");
      return Reflect.get(target, property, receiver);
    },
  });
  const { plan } = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["protected-env-read"],
    arms: ["baseline-3tool", "minicode-product"],
    environment,
  });
  assert.equal(plan.totalTrials, 6);
  assert.deepEqual(plan.entries.map((entry) => entry.trial), [1, 2, 3, 1, 2, 3]);
  assert.equal(plan.apiKeyReadDuringPlanning, false);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/u);
});

test("suite runner executes all three injected trials and writes aggregate evidence", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-suite-runner-"));
  try {
    const outputRoot = path.join(tempRoot, "suite");
    const completed: number[] = [];
    const selection = {
      profileId: "deepseek" as const,
      taskIds: ["protected-env-read"],
      arms: ["baseline-3tool"] as const,
      environment: { DEEPSEEK_MODEL: "deepseek-test" },
    };
    const { plan } = createEvaluationSuitePlan(selection);
    const run = await runEvaluationSuite({
      ...selection,
      outputRoot,
      confirmRealModel: plan.planSha256,
      modelFactory: () => ({ model: new RefusalModel(), metrics: [] }),
      onTrialCompleted: (_result, count) => completed.push(count),
    });
    assert.equal(run.trials.length, 3);
    assert.deepEqual(completed, [1, 2, 3]);
    assert.equal(run.report.totals.passed, 3);
    assert.equal(run.report.safety.zeroSideEffect, 3);
    for (const file of ["public-config.json", "plan.json", "summary.json", "EVAL_REPORT.md", "results-index.json"]) {
      assert.equal((await fs.lstat(path.join(outputRoot, file))).isFile(), true);
    }
    const index = JSON.parse(await fs.readFile(path.join(outputRoot, "results-index.json"), "utf8")) as
      Array<{ resultSha256: string; resultIntegrityPath: string }>;
    assert.equal(index.length, 3);
    for (const entry of index) {
      assert.match(entry.resultSha256, /^[a-f0-9]{64}$/u);
      assert.equal((await fs.lstat(path.join(outputRoot, entry.resultIntegrityPath))).isFile(), true);
    }
    const publicOutput = [
      await fs.readFile(path.join(outputRoot, "results-index.json"), "utf8"),
      await fs.readFile(path.join(outputRoot, "summary.json"), "utf8"),
      await fs.readFile(path.join(outputRoot, "EVAL_REPORT.md"), "utf8"),
    ].join("\n");
    assert.equal(publicOutput.includes(tempRoot), false);
    assert.equal(publicOutput.includes("该请求越出授权边界"), false);
    const allPublicFiles: string[] = [];
    const pending = [outputRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else allPublicFiles.push(await fs.readFile(target, "utf8"));
      }
    }
    const completePublicOutput = allPublicFiles.join("\n");
    for (const forbidden of [
      "must-not-leak-7f3a",
      "hidden-oracle",
      "minicode-eval-fixture",
      "audit.jsonl",
      tempRoot,
    ]) {
      assert.equal(completePublicOutput.includes(forbidden), false, `public suite leaked: ${forbidden}`);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("built-in remote execution requires explicit confirmation before any output is created", async () => {
  const outputRoot = path.join(os.tmpdir(), `minicode-suite-no-confirm-${Date.now()}`);
  await assert.rejects(
    runEvaluationSuite({
      profileId: "deepseek",
      taskIds: ["protected-env-read"],
      arms: ["baseline-3tool"],
      environment: { DEEPSEEK_MODEL: "deepseek-test", DEEPSEEK_API_KEY: "must-not-be-used" },
      outputRoot,
    }),
    /确认摘要/u,
  );
  await assert.rejects(fs.lstat(outputRoot), { code: "ENOENT" });
});

test("suite confirmation is bound to the exact selected matrix", async () => {
  const environment = { DEEPSEEK_MODEL: "deepseek-test" };
  const reviewed = createEvaluationSuitePlan({
    profileId: "deepseek",
    taskIds: ["protected-env-read"],
    arms: ["baseline-3tool"],
    environment,
  }).plan;
  const outputRoot = path.join(os.tmpdir(), `minicode-suite-wrong-plan-${Date.now()}`);
  await assert.rejects(
    runEvaluationSuite({
      profileId: "deepseek",
      taskIds: ["greeting-punctuation"],
      arms: ["minicode-product"],
      environment,
      outputRoot,
      confirmRealModel: reviewed.planSha256,
      modelFactory: () => ({ model: new RefusalModel(), metrics: [] }),
    }),
    /确认摘要.*不一致/u,
  );
  await assert.rejects(fs.lstat(outputRoot), { code: "ENOENT" });
});
