import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ChatModel,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../src/agent/contracts.ts";
import { createEvaluationArmAgent } from "../src/evals/eval-arms.ts";
import { EVALUATION_ARMS, type EvaluationArm } from "../src/evals/eval-config.ts";
import { prepareEvaluationFixture } from "../src/evals/eval-fixture.ts";

class SuccessfulEvaluationModel implements ChatModel {
  readonly #brokenSource: string;
  readonly #expectedSource: string;
  #toolIndex = 0;

  constructor(brokenSource: string, expectedSource: string) {
    this.#brokenSource = brokenSource;
    this.#expectedSource = expectedSource;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.phase === "planning") {
      return { kind: "final", content: "读取目标，应用最小补丁，运行固定测试。" };
    }
    const calls: ToolCall[] = [
      { id: "eval-read", name: "read_file", input: { path: "src/implementation.js" } },
      {
        id: "eval-patch",
        name: "apply_patch",
        input: {
          path: "src/implementation.js",
          oldText: this.#brokenSource,
          newText: this.#expectedSource,
        },
      },
      { id: "eval-test", name: "run_project_check", input: { action: "test" } },
    ];
    const call = calls[this.#toolIndex];
    this.#toolIndex += 1;
    return call
      ? { kind: "tool_calls", content: "", toolCalls: [call] }
      : { kind: "final", content: "修改已完成，npm test 已通过；未提交。" };
  }
}

class OutOfAllowlistModel implements ChatModel {
  #callIndex = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.phase === "planning") {
      return { kind: "final", content: "尝试修改 package.json。" };
    }
    this.#callIndex += 1;
    if (this.#callIndex === 1) {
      return {
        kind: "tool_calls",
        content: "",
        toolCalls: [{ id: "read-package", name: "read_file", input: { path: "package.json" } }],
      };
    }
    if (this.#callIndex === 2) {
      return {
        kind: "tool_calls",
        content: "",
        toolCalls: [{
          id: "patch-package",
          name: "apply_patch",
          input: { path: "package.json", oldText: "\"private\": true", newText: "\"private\": false" },
        }],
      };
    }
    return { kind: "final", content: "修改未获批准，任务未完成。" };
  }
}

class PatchWithoutTestModel implements ChatModel {
  readonly #brokenSource: string;
  readonly #expectedSource: string;
  #callIndex = 0;

  constructor(brokenSource: string, expectedSource: string) {
    this.#brokenSource = brokenSource;
    this.#expectedSource = expectedSource;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.phase === "planning") {
      return { kind: "final", content: "读取目标并应用最小补丁。" };
    }
    this.#callIndex += 1;
    if (this.#callIndex === 1) {
      return {
        kind: "tool_calls",
        content: "",
        toolCalls: [{ id: "unverified-read", name: "read_file", input: { path: "src/implementation.js" } }],
      };
    }
    if (this.#callIndex === 2) {
      return {
        kind: "tool_calls",
        content: "",
        toolCalls: [{
          id: "unverified-patch",
          name: "apply_patch",
          input: {
            path: "src/implementation.js",
            oldText: this.#brokenSource,
            newText: this.#expectedSource,
          },
        }],
      };
    }
    assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
    assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
    return { kind: "final", content: "补丁已经完成。" };
  }
}

class InitialFailureRepairEvaluationModel implements ChatModel {
  readonly #brokenSource: string;
  readonly #expectedSource: string;
  readonly #expectsGitCloseout: boolean;
  #executionCallCount = 0;

  constructor(brokenSource: string, expectedSource: string, expectsGitCloseout: boolean) {
    this.#brokenSource = brokenSource;
    this.#expectedSource = expectedSource;
    this.#expectsGitCloseout = expectsGitCloseout;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.phase === "planning") {
      return { kind: "final", content: "先复现失败，再给出最小修复方向并完成验证。" };
    }

    this.#executionCallCount += 1;
    if (this.#executionCallCount === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
      assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
      return {
        kind: "tool_calls",
        content: "先运行失败用例。",
        toolCalls: [{ id: "failure-initial-test", name: "run_project_check", input: { action: "test" } }],
      };
    }
    if (this.#executionCallCount === 2) {
      assert.equal(request.phase, "repair_planning");
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "读取实现，把 attemptNumber 改为从 1 计数，再运行 test。" };
    }
    if (this.#executionCallCount === 3) {
      return {
        kind: "tool_calls",
        content: "读取目标源码。",
        toolCalls: [{ id: "failure-read", name: "read_file", input: { path: "src/implementation.js" } }],
      };
    }
    if (this.#executionCallCount === 4) {
      return {
        kind: "tool_calls",
        content: "应用最小修复。",
        toolCalls: [{
          id: "failure-patch",
          name: "apply_patch",
          input: {
            path: "src/implementation.js",
            oldText: this.#brokenSource,
            newText: this.#expectedSource,
          },
        }],
      };
    }
    if (this.#executionCallCount === 5) {
      assert.equal(request.tools.some((tool) => tool.name === "run_project_check"), true);
      if (this.#expectsGitCloseout) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
      }
      return {
        kind: "tool_calls",
        content: "复验修复。",
        toolCalls: [{ id: "failure-retest", name: "run_project_check", input: { action: "test" } }],
      };
    }
    if (!this.#expectsGitCloseout) {
      assert.equal(this.#executionCallCount, 6);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "初始失败已复现，修复后的 test 已通过。" };
    }
    if (this.#executionCallCount === 6 || this.#executionCallCount === 7) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
      return {
        kind: "tool_calls",
        content: "收集只读 Git 证据。",
        toolCalls: [{ id: `failure-git-${this.#executionCallCount}`, name: "inspect_git", input: {} }],
      };
    }
    assert.equal(this.#executionCallCount, 8);
    assert.deepEqual(request.tools, []);
    return { kind: "final", content: "初始失败已复现，修复后的 test 已通过。" };
  }
}

test("all evaluation arms use the generated fixture and complete the same three-tool repair", async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-arms-"));
  try {
    for (const arm of EVALUATION_ARMS) {
      await context.test(arm, async () => {
        const fixture = await prepareEvaluationFixture({
          taskId: "greeting-punctuation",
          runRoot: path.join(tempRoot, arm),
        });
        if (fixture.task.category !== "functional") throw new Error("测试任务必须是功能题。");
        const brokenSource = fixture.task.workspaceFiles[fixture.task.targetPath];
        if (brokenSource === undefined) throw new Error("缺少初始源码。");
        const result = await (await createEvaluationArmAgent({
          arm: arm as EvaluationArm,
          fixture,
          auditPath: path.join(fixture.runRoot, "audit.jsonl"),
          profileId: "deepseek",
          model: new SuccessfulEvaluationModel(brokenSource, fixture.task.expectedSource),
        })).run(fixture.task.prompt);

        assert.equal(
          await fs.readFile(path.join(fixture.workspaceRoot, "src", "implementation.js"), "utf8"),
          fixture.task.expectedSource,
        );
        assert.equal(result.events.at(-1)?.type, "agent_completed");
        const patchIndex = result.events.findIndex(
          (event) => event.type === "tool_finalized" && event.toolCallId === "eval-patch" && event.status === "success",
        );
        const testIndex = result.events.findIndex(
          (event) => event.type === "tool_finalized" && event.toolCallId === "eval-test" && event.status === "success",
        );
        const completedIndex = result.events.findIndex((event) => event.type === "agent_completed");
        assert.ok(patchIndex >= 0 && patchIndex < testIndex);
        assert.ok(testIndex < completedIndex);
        assert.equal(
          result.events.some((event) =>
            event.type === "command_approval_decision" && event.decision === "approved"),
          true,
        );
      });
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("the product evaluation arm stops when a successful patch skips its required test", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-post-patch-test-"));
  try {
    const fixture = await prepareEvaluationFixture({
      taskId: "greeting-punctuation",
      runRoot: path.join(tempRoot, "run"),
    });
    if (fixture.task.category !== "functional") throw new Error("测试任务必须是功能题。");
    const brokenSource = fixture.task.workspaceFiles[fixture.task.targetPath];
    if (brokenSource === undefined) throw new Error("缺少初始源码。");
    const result = await (await createEvaluationArmAgent({
      arm: "minicode-product",
      fixture,
      auditPath: path.join(fixture.runRoot, "audit.jsonl"),
      profileId: "deepseek",
      model: new PatchWithoutTestModel(brokenSource, fixture.task.expectedSource),
    })).run(fixture.task.prompt);

    assert.match(result.answer, /补丁尚未通过后续 run_project_check\(test\) 验证/);
    assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
    assert.equal(result.events.at(-1)?.type, "agent_stopped");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("guided evaluation arms force a real initial failure before one approved repair", async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-initial-failure-"));
  try {
    for (const arm of ["minicode-3tool", "minicode-product"] as const) {
      await context.test(arm, async () => {
        const fixture = await prepareEvaluationFixture({
          taskId: "retry-attempt-number",
          runRoot: path.join(tempRoot, arm),
        });
        if (fixture.task.category !== "functional" || fixture.task.flow !== "failure_repair") {
          throw new Error("测试任务必须要求失败修复流程。");
        }
        const brokenSource = fixture.task.workspaceFiles[fixture.task.targetPath];
        if (brokenSource === undefined) throw new Error("缺少初始源码。");
        const result = await (await createEvaluationArmAgent({
          arm,
          fixture,
          auditPath: path.join(fixture.runRoot, "audit.jsonl"),
          profileId: "deepseek",
          model: new InitialFailureRepairEvaluationModel(
            brokenSource,
            fixture.task.expectedSource,
            arm === "minicode-product",
          ),
        })).run(fixture.task.prompt);

        assert.equal(
          await fs.readFile(path.join(fixture.workspaceRoot, "src", "implementation.js"), "utf8"),
          fixture.task.expectedSource,
        );
        const initialFailureIndex = result.events.findIndex(
          (event) => event.type === "tool_finalized" &&
            event.toolCallId === "failure-initial-test" &&
            event.status === "error",
        );
        const repairProposedIndex = result.events.findIndex((event) => event.type === "repair_proposed");
        const repairApprovedIndex = result.events.findIndex(
          (event) => event.type === "repair_decision" && event.decision === "approved",
        );
        const patchIndex = result.events.findIndex(
          (event) => event.type === "tool_finalized" &&
            event.toolCallId === "failure-patch" && event.status === "success",
        );
        const retestIndex = result.events.findIndex(
          (event) => event.type === "tool_finalized" &&
            event.toolCallId === "failure-retest" && event.status === "success",
        );
        assert.ok(initialFailureIndex >= 0 && initialFailureIndex < repairProposedIndex);
        assert.ok(repairProposedIndex < repairApprovedIndex && repairApprovedIndex < patchIndex);
        assert.ok(patchIndex < retestIndex);
        assert.equal(result.events.at(-1)?.type, "agent_completed");
      });
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fixture auto-approval rejects a patch outside the task allowlist", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-allowlist-"));
  try {
    const fixture = await prepareEvaluationFixture({
      taskId: "greeting-punctuation",
      runRoot: path.join(tempRoot, "run"),
    });
    const packageBefore = await fs.readFile(path.join(fixture.workspaceRoot, "package.json"), "utf8");
    const result = await (await createEvaluationArmAgent({
      arm: "minicode-3tool",
      fixture,
      auditPath: path.join(fixture.runRoot, "audit.jsonl"),
      profileId: "deepseek",
      model: new OutOfAllowlistModel(),
    })).run(fixture.task.prompt);

    assert.equal(await fs.readFile(path.join(fixture.workspaceRoot, "package.json"), "utf8"), packageBefore);
    assert.equal(
      result.events.some((event) => event.type === "edit_approval_decision" && event.decision === "rejected"),
      true,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("evaluation auto-approval refuses audit files inside the agent workspace", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-audit-boundary-"));
  try {
    const fixture = await prepareEvaluationFixture({
      taskId: "greeting-punctuation",
      runRoot: path.join(tempRoot, "run"),
    });
    await assert.rejects(
      createEvaluationArmAgent({
        arm: "baseline-3tool",
        fixture,
        auditPath: path.join(fixture.workspaceRoot, "audit.jsonl"),
        profileId: "deepseek",
        model: new OutOfAllowlistModel(),
      }),
      /workspace 外/u,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
