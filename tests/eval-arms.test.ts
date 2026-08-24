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
