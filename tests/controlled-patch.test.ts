import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import { JsonlAuditLog } from "../src/agent/events.ts";
import type { ChatModel, JsonObject, ModelRequest, ModelResponse, ToolExecutionMode } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { applyPatch } from "../src/tools/apply-patch.ts";

const TARGET_PATH = "src/example.ts";
const ORIGINAL_SOURCE = "export const message = 'before-value';\n";

interface PatchAttempt {
  result: Awaited<ReturnType<AgentLoop["run"]>>;
  audit: Array<Record<string, unknown>>;
  rawAudit: string;
}

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-patch-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, TARGET_PATH), ORIGINAL_SOURCE, "utf8");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=before-value\n", "utf8");
  return workspace;
}

function scriptedPatchModel(input: JsonObject): ChatModel {
  let calls = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "tool_calls",
          content: "请求受控补丁。",
          toolCalls: [{ id: "patch-1", name: "apply_patch", input }],
        };
      }

      const toolResult = request.messages.at(-1);
      assert.equal(toolResult?.role, "tool");
      return {
        kind: "final",
        content: toolResult?.status === "success" ? "补丁流程完成。" : "补丁流程被安全拒绝。",
      };
    },
  };
}

async function runPatchAttempt(
  workspaceRoot: string,
  input: JsonObject,
  executionMode: ToolExecutionMode,
  requestEditApproval?: (request: { path: string; preview: string }) => Promise<boolean>,
): Promise<PatchAttempt> {
  const auditPath = path.join(workspaceRoot, "audit", "tool-audit.jsonl");
  const agent = new AgentLoop(scriptedPatchModel(input), new ToolRegistry([applyPatch]), {
    workspaceRoot,
    executionMode,
    requestEditApproval,
    auditLog: new JsonlAuditLog(auditPath),
  });
  const result = await agent.run("修改一个已确认的问题。");
  const rawAudit = await fs.readFile(auditPath, "utf8");
  return {
    result,
    rawAudit,
    audit: rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function lifecycle(audit: Array<Record<string, unknown>>): unknown[] {
  return audit.filter((event) => event.toolCallId === "patch-1").map((event) => event.type);
}

function finalStatus(audit: Array<Record<string, unknown>>): unknown {
  return audit.findLast((event) => event.type === "tool_finalized" && event.toolCallId === "patch-1")?.status;
}

test("propose 模式只返回预览，不写入文件", async () => {
  const workspace = await createWorkspace();
  try {
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
      "propose",
    );

    assert.equal(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), ORIGINAL_SOURCE);
    const toolResult = attempt.result.messages.find((message) => message.role === "tool");
    assert.equal(toolResult?.status, "success");
    assert.match(toolResult?.content ?? "", /补丁预览，未写入文件/);
    assert.deepEqual(lifecycle(attempt.audit), ["tool_call", "tool_execution_started", "policy_decision", "tool_finalized"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("apply 模式只有确认后才原子写入，并且审计不保存补丁文本", async () => {
  const workspace = await createWorkspace();
  try {
    let requestedPreview = "";
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
      "apply",
      async (request) => {
        requestedPreview = request.preview;
        return true;
      },
    );

    assert.match(requestedPreview, /--- src\/example.ts/);
    assert.match(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), /after-value/);
    assert.doesNotMatch(attempt.rawAudit, /before-value|after-value/);
    assert.deepEqual(lifecycle(attempt.audit), [
      "tool_call",
      "tool_execution_started",
      "policy_decision",
      "edit_approval_requested",
      "edit_approval_decision",
      "tool_finalized",
    ]);
    assert.equal(finalStatus(attempt.audit), "success");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("oldText 不匹配时不会请求确认，也不会修改文件", async () => {
  const workspace = await createWorkspace();
  try {
    let askedForApproval = false;
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "missing-value", newText: "after-value" },
      "apply",
      async () => {
        askedForApproval = true;
        return true;
      },
    );

    assert.equal(askedForApproval, false);
    assert.equal(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), ORIGINAL_SOURCE);
    assert.equal(attempt.result.messages.find((message) => message.role === "tool")?.status, "error");
    assert.deepEqual(lifecycle(attempt.audit), ["tool_call", "tool_execution_started", "policy_decision", "tool_finalized"]);
    assert.equal(finalStatus(attempt.audit), "error");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("受保护路径会被策略拒绝并写入阻断审计", async () => {
  const workspace = await createWorkspace();
  try {
    let askedForApproval = false;
    const attempt = await runPatchAttempt(
      workspace,
      { path: ".env", oldText: "SECRET=before-value", newText: "SECRET=after-value" },
      "apply",
      async () => {
        askedForApproval = true;
        return true;
      },
    );

    assert.equal(askedForApproval, false);
    assert.equal(await fs.readFile(path.join(workspace, ".env"), "utf8"), "SECRET=before-value\n");
    const policyDecision = attempt.audit.find((event) => event.type === "policy_decision");
    assert.equal(policyDecision?.decision, "blocked");
    assert.equal(attempt.result.messages.find((message) => message.role === "tool")?.status, "error");
    assert.doesNotMatch(attempt.rawAudit, /SECRET=before-value|SECRET=after-value/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("用户拒绝确认时保持原文件，并产生错误终态", async () => {
  const workspace = await createWorkspace();
  try {
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
      "apply",
      async () => false,
    );

    assert.equal(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), ORIGINAL_SOURCE);
    assert.equal(attempt.result.messages.find((message) => message.role === "tool")?.status, "error");
    assert.deepEqual(lifecycle(attempt.audit), [
      "tool_call",
      "tool_execution_started",
      "policy_decision",
      "edit_approval_requested",
      "edit_approval_decision",
      "tool_finalized",
    ]);
    assert.equal(finalStatus(attempt.audit), "error");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("apply_patch 拒绝非法 UTF-8 且保持原始字节不变", async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, TARGET_PATH);
  const invalidBytes = Buffer.from([0x62, 0x65, 0x66, 0x6f, 0x72, 0x65, 0x80, 0x76, 0x61, 0x6c, 0x75, 0x65]);
  try {
    await fs.writeFile(targetPath, invalidBytes);
    let askedForApproval = false;
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before", newText: "after" },
      "apply",
      async () => {
        askedForApproval = true;
        return true;
      },
    );

    assert.equal(askedForApproval, false);
    assert.deepEqual(await fs.readFile(targetPath), invalidBytes);
    const toolResult = attempt.result.messages.find((message) => message.role === "tool");
    assert.equal(toolResult?.status, "error");
    assert.match(toolResult?.content ?? "", /不是有效 UTF-8 文本/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("apply_patch 严格解码后仍保留原文件的 UTF-8 BOM", async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, TARGET_PATH);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  try {
    await fs.writeFile(targetPath, Buffer.concat([bom, Buffer.from(ORIGINAL_SOURCE, "utf8")]));
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
      "apply",
      async () => true,
    );

    const updatedBytes = await fs.readFile(targetPath);
    assert.equal(attempt.result.messages.find((message) => message.role === "tool")?.status, "success");
    assert.deepEqual(updatedBytes.subarray(0, 3), bom);
    assert.match(updatedBytes.subarray(3).toString("utf8"), /after-value/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("APPLY 返回后若任务已取消，原子写入不会开始", async () => {
  const workspace = await createWorkspace();
  const controller = new AbortController();
  try {
    await assert.rejects(
      applyPatch.execute(
        { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
        {
          task: "取消补丁",
          step: 1,
          workspaceRoot: workspace,
          executionMode: "apply",
          signal: controller.signal,
          requestEditApproval: async () => {
            controller.abort();
            return true;
          },
        },
      ),
      /补丁写入已取消/,
    );
    assert.equal(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), ORIGINAL_SOURCE);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("apply_patch 原子替换后保留 POSIX 文件 mode", { skip: process.platform === "win32" }, async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, TARGET_PATH);
  try {
    await fs.chmod(targetPath, 0o751);
    const attempt = await runPatchAttempt(
      workspace,
      { path: TARGET_PATH, oldText: "before-value", newText: "after-value" },
      "apply",
      async () => true,
    );

    assert.equal(attempt.result.messages.find((message) => message.role === "tool")?.status, "success");
    assert.equal((await fs.stat(targetPath)).mode & 0o777, 0o751);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("编辑约束会拒绝未先读取目标文件的补丁", async () => {
  const workspace = await createWorkspace();
  try {
    let askedForApproval = false;
    const agent = new AgentLoop(
      scriptedPatchModel({ path: TARGET_PATH, oldText: "before-value", newText: "after-value" }),
      new ToolRegistry([applyPatch]),
      {
        workspaceRoot: workspace,
        executionMode: "apply",
        requireReadBeforeEdit: true,
        requestEditApproval: async () => {
          askedForApproval = true;
          return true;
        },
      },
    );

    const result = await agent.run("修改一个尚未读取的文件。");
    const toolResult = result.messages.find((message) => message.role === "tool");
    assert.equal(toolResult?.status, "error");
    assert.match(toolResult?.content ?? "", /修改前必须先用 read_file 成功读取目标文件/);
    assert.equal(askedForApproval, false);
    assert.equal(await fs.readFile(path.join(workspace, TARGET_PATH), "utf8"), ORIGINAL_SOURCE);
    assert.equal(result.events.some((event) => event.type === "tool_execution_started"), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
