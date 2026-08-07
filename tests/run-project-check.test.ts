import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import { JsonlAuditLog } from "../src/agent/events.ts";
import type {
  AgentTool,
  ChatModel,
  JsonObject,
  ModelRequest,
  ModelResponse,
  ToolExecutionResult,
} from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { FakeModel } from "../src/models/fake-model.ts";
import {
  createRunProjectCheckTool,
  type ProjectCheckRunResult,
  type ProjectCheckRunner,
  runProjectCheck,
} from "../src/tools/run-project-check.ts";

interface CheckAttempt {
  result: Awaited<ReturnType<AgentLoop["run"]>>;
  audit: Array<Record<string, unknown>>;
  rawAudit: string;
}

async function createWorkspace(scripts: Record<string, string>): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-check-"));
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "verification-fixture", private: true, scripts }, null, 2)}\n`,
    "utf8",
  );
  return workspace;
}

function scriptedCheckModel(input: JsonObject): ChatModel {
  let calls = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "tool_calls",
          content: "执行固定验证动作。",
          toolCalls: [{ id: "check-1", name: "run_project_check", input }],
        };
      }

      const toolResult = request.messages.at(-1);
      assert.equal(toolResult?.role, "tool");
      return {
        kind: "final",
        content: toolResult?.status === "success" ? "验证成功。" : "验证未通过。",
      };
    },
  };
}

async function runCheckAttempt(
  workspaceRoot: string,
  tool: AgentTool<unknown, ToolExecutionResult>,
  input: JsonObject,
): Promise<CheckAttempt> {
  const auditPath = path.join(workspaceRoot, "audit", "tool-audit.jsonl");
  const agent = new AgentLoop(scriptedCheckModel(input), new ToolRegistry([tool]), {
    workspaceRoot,
    auditLog: new JsonlAuditLog(auditPath),
  });
  const result = await agent.run("运行固定项目验证。");
  const rawAudit = await fs.readFile(auditPath, "utf8");
  return {
    result,
    rawAudit,
    audit: rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function toolResult(attempt: CheckAttempt) {
  return attempt.result.messages.find((message) => message.role === "tool");
}

function finalizedAudit(attempt: CheckAttempt) {
  return attempt.audit.findLast(
    (event) => event.type === "tool_finalized" && event.toolCallId === "check-1",
  );
}

test("固定 test 动作在工作区根目录运行，并把成功证据回填给模型", async () => {
  const workspace = await createWorkspace({ test: "node -e \"console.log('CHECK_TEST_OK')\"" });
  try {
    const attempt = await runCheckAttempt(workspace, runProjectCheck, { action: "test" });

    assert.equal(toolResult(attempt)?.status, "success");
    assert.match(toolResult(attempt)?.content ?? "", /固定命令：npm test/);
    assert.match(toolResult(attempt)?.content ?? "", /CHECK_TEST_OK/);
    assert.equal(finalizedAudit(attempt)?.action, "test");
    assert.equal(finalizedAudit(attempt)?.exitCode, 0);
    assert.equal(finalizedAudit(attempt)?.timedOut, false);
    assert.doesNotMatch(attempt.rawAudit, /CHECK_TEST_OK/);
    assert.deepEqual(
      attempt.audit.filter((event) => event.toolCallId === "check-1").map((event) => event.type),
      ["tool_call", "tool_execution_started", "policy_decision", "tool_finalized"],
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("固定 check 动作的非零退出码会成为错误终态并保留安全元数据", async () => {
  const workspace = await createWorkspace({ check: "node -e \"console.error('CHECK_FAILED'); process.exit(7)\"" });
  try {
    const attempt = await runCheckAttempt(workspace, runProjectCheck, { action: "check" });

    assert.equal(toolResult(attempt)?.status, "error");
    assert.match(toolResult(attempt)?.content ?? "", /固定验证动作失败/);
    assert.equal(finalizedAudit(attempt)?.action, "check");
    assert.equal(finalizedAudit(attempt)?.exitCode, 7);
    assert.equal(finalizedAudit(attempt)?.timedOut, false);
    assert.doesNotMatch(attempt.rawAudit, /CHECK_FAILED/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("模型不能传入任意命令或额外参数", async () => {
  const workspace = await createWorkspace({ test: "node -e \"console.log('SHOULD_NOT_RUN')\"" });
  try {
    const attempt = await runCheckAttempt(workspace, runProjectCheck, {
      action: "shell",
      command: "powershell -Command Remove-Item anything",
    });

    assert.equal(toolResult(attempt)?.status, "error");
    assert.match(toolResult(attempt)?.content ?? "", /不支持的参数：command/);
    assert.deepEqual(
      attempt.audit.filter((event) => event.toolCallId === "check-1").map((event) => event.type),
      ["tool_call", "tool_finalized"],
    );
    assert.doesNotMatch(attempt.rawAudit, /Remove-Item|powershell/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("超时与截断作为受限执行结果处理，审计不保存输出", async () => {
  const workspace = await createWorkspace({ test: "node -e \"console.log('unused')\"" });
  try {
    const output = "SENSITIVE_TEST_OUTPUT".repeat(1_000);
    const runner: ProjectCheckRunner = {
      async run(): Promise<ProjectCheckRunResult> {
        return {
          exitCode: null,
          durationMs: 60_000,
          output: output.slice(0, 12_000),
          outputLength: output.length,
          outputTruncated: true,
          timedOut: true,
        };
      },
    };
    const attempt = await runCheckAttempt(workspace, createRunProjectCheckTool(runner), { action: "test" });

    assert.equal(toolResult(attempt)?.status, "error");
    assert.match(toolResult(attempt)?.content ?? "", /超时/);
    assert.match(toolResult(attempt)?.content ?? "", /输出已截断/);
    assert.equal(finalizedAudit(attempt)?.exitCode, null);
    assert.equal(finalizedAudit(attempt)?.timedOut, true);
    assert.equal(finalizedAudit(attempt)?.outputTruncated, true);
    assert.equal(finalizedAudit(attempt)?.outputLength, output.length);
    assert.doesNotMatch(attempt.rawAudit, /SENSITIVE_TEST_OUTPUT/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("固定验证动作无法启动时仍保留动作审计和错误终态", async () => {
  const workspace = await createWorkspace({ test: "node -e \"console.log('unused')\"" });
  try {
    const runner: ProjectCheckRunner = {
      async run(): Promise<ProjectCheckRunResult> {
        throw new Error("npm CLI unavailable");
      },
    };
    const attempt = await runCheckAttempt(workspace, createRunProjectCheckTool(runner), { action: "check" });

    assert.equal(toolResult(attempt)?.status, "error");
    assert.match(toolResult(attempt)?.content ?? "", /固定验证动作无法启动/);
    assert.equal(finalizedAudit(attempt)?.action, "check");
    assert.equal(finalizedAudit(attempt)?.status, "error");
    assert.doesNotMatch(attempt.rawAudit, /npm CLI unavailable/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 只能选择固定验证动作，并基于工具结果给出结论", async () => {
  const workspace = await createWorkspace({ test: "node -e \"console.log('FAKE_MODEL_CHECK_OK')\"" });
  try {
    const result = await new AgentLoop(new FakeModel(), new ToolRegistry([runProjectCheck]), {
      workspaceRoot: workspace,
    }).run("请运行测试并汇报结果。");

    assert.match(result.answer, /受限项目验证闭环已完成/);
    assert.match(result.answer, /FAKE_MODEL_CHECK_OK/);
    assert.deepEqual(
      result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_project_check"],
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
