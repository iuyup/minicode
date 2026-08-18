import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop, type AgentLoopOptions, type AgentRunResult } from "../src/agent/agent-loop.ts";
import type {
  ChatModel,
  CommandApprovalRequest,
  JsonObject,
  ModelRequest,
  ModelResponse,
  ToolResultMessage,
} from "../src/agent/contracts.ts";
import { JsonlAuditLog } from "../src/agent/events.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { FakeModel } from "../src/models/fake-model.ts";
import {
  createSanitizedChildEnvironment,
  runBoundedProcess,
} from "../src/tools/child-process-safety.ts";
import {
  createRunCommandTool,
  type CommandRunner,
  type CommandRunRequest,
  type CommandRunResult,
} from "../src/tools/run-command.ts";

interface CommandAttempt {
  result: AgentRunResult;
  rawAudit: string;
  audit: Array<Record<string, unknown>>;
}

let auditSequence = 0;

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-command-"));
  await fs.mkdir(path.join(workspace, "packages", "app", "scripts"), { recursive: true });
  await fs.writeFile(path.join(workspace, "packages", "app", "scripts", "check.mjs"), "// fixture\n", "utf8");
  await fs.writeFile(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "command-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  return workspace;
}

function scriptedCommandModel(input: JsonObject): ChatModel {
  let calls = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "tool_calls",
          content: "请求运行受控命令。",
          toolCalls: [{ id: "command-1", name: "run_command", input }],
        };
      }

      const lastMessage = request.messages.at(-1);
      assert.equal(lastMessage?.role, "tool");
      return {
        kind: "final",
        content: lastMessage?.status === "success" ? "命令成功。" : "命令未执行或失败。",
      };
    },
  };
}

async function runCommandAttempt(
  workspaceRoot: string,
  input: JsonObject,
  runner?: CommandRunner,
  requestCommandApproval: AgentLoopOptions["requestCommandApproval"] | null = async () => true,
): Promise<CommandAttempt> {
  auditSequence += 1;
  const auditPath = path.join(workspaceRoot, "audit", `run-command-${auditSequence}.jsonl`);
  const agent = new AgentLoop(
    scriptedCommandModel(input),
    new ToolRegistry([runner ? createRunCommandTool(runner) : createRunCommandTool()]),
    {
      workspaceRoot,
      auditLog: new JsonlAuditLog(auditPath),
      ...(requestCommandApproval ? { requestCommandApproval } : {}),
    },
  );
  const result = await agent.run("运行一条受控项目命令。");
  const rawAudit = await fs.readFile(auditPath, "utf8");
  return {
    result,
    rawAudit,
    audit: rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

test("默认 runner 在 Windows 通过当前 Node 与 npm-cli.js 启动受控程序", async () => {
  const workspace = await createWorkspace();
  const previousNpmExecPath = process.env.npm_execpath;
  const fakeNpmDirectory = path.join(workspace, "npm");
  const fakeNpmExecPath = path.join(fakeNpmDirectory, "bin", "npm-cli.js");
  const fakeMarker = path.join(workspace, "fake-npm-ran.txt");
  try {
    await fs.mkdir(path.dirname(fakeNpmExecPath), { recursive: true });
    await fs.writeFile(path.join(fakeNpmDirectory, "package.json"), JSON.stringify({ name: "npm" }), "utf8");
    await fs.writeFile(fakeNpmExecPath, "require('node:fs').writeFileSync('fake-npm-ran.txt', 'bad');\n", "utf8");
    process.env.npm_execpath = fakeNpmExecPath;
    const nodeAttempt = await runCommandAttempt(
      workspace,
      { program: "node", args: ["--version"], cwd: "." },
    );
    assert.equal(toolResult(nodeAttempt)?.status, "success");
    assert.match(toolResult(nodeAttempt)?.content ?? "", /v\d+\.\d+\.\d+/);

    const npmAttempt = await runCommandAttempt(
      workspace,
      { program: "npm", args: ["--version"], cwd: "." },
    );
    assert.equal(toolResult(npmAttempt)?.status, "success");
    assert.match(toolResult(npmAttempt)?.content ?? "", /\d+\.\d+\.\d+/);
    assert.equal(finalizedAudit(npmAttempt)?.riskLevel, "low");
    await assert.rejects(fs.access(fakeMarker));
  } finally {
    if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecPath;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 在编辑工具集中可离线演示 npm 版本命令确认闭环", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  const runner: CommandRunner = {
    async run(request): Promise<CommandRunResult> {
      runnerCalls += 1;
      assert.equal(request.program, "npm");
      assert.deepEqual(request.args, ["--version"]);
      assert.equal(request.cwd, await fs.realpath(workspace));
      return successfulResult("10.9.0");
    },
  };
  try {
    const result = await new AgentLoop(
      new FakeModel(),
      new ToolRegistry([createRunCommandTool(runner)]),
      { workspaceRoot: workspace, requestCommandApproval: async () => true },
    ).run("请查看 npm --version 并汇报。");

    assert.equal(runnerCalls, 1);
    assert.match(result.answer, /受控命令闭环已完成/);
    assert.match(result.answer, /10\.9\.0/);
    assert.deepEqual(
      result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_command"],
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("真实超时会终止直接 Node 进程并进入进程树清理路径", async () => {
  const workspace = await createWorkspace();
  const markerPath = path.join(workspace, "late-marker.txt");
  const parentPath = path.join(workspace, "timeout-parent.mjs");
  try {
    await fs.writeFile(
      parentPath,
      "import fs from 'node:fs/promises'; import process from 'node:process'; setTimeout(() => void fs.writeFile('late-marker.txt', 'late', 'utf8'), 700); setTimeout(() => process.exit(0), 1500);\n",
      "utf8",
    );

    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [parentPath],
      cwd: workspace,
      env: createSanitizedChildEnvironment(),
      action: "timeout_tree_test",
      startFailureLabel: "超时树测试",
      timeoutMs: 100,
      maxOutputChars: 1_000,
    });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(fs.access(markerPath));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("进程输出使用流式 UTF-8 解码，不会在 chunk 边界产生替换字符", async () => {
  const workspace = await createWorkspace();
  const scriptPath = path.join(workspace, "split-utf8.mjs");
  try {
    await fs.writeFile(
      scriptPath,
      "process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xb8, 0xad])), 20);\n",
      "utf8",
    );
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: workspace,
      env: createSanitizedChildEnvironment(),
      action: "utf8_stream_test",
      startFailureLabel: "UTF-8 流测试",
      timeoutMs: 2_000,
      maxOutputChars: 100,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "中");
    assert.equal(result.outputLength, 1);
    assert.equal(result.outputTruncated, false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("进程输出达到上限后仍准确记录完整长度与截断状态", async () => {
  const workspace = await createWorkspace();
  const scriptPath = path.join(workspace, "bounded-output.mjs");
  try {
    await fs.writeFile(scriptPath, "process.stdout.write('x'.repeat(100));\n", "utf8");
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: workspace,
      env: createSanitizedChildEnvironment(),
      action: "bounded_output_test",
      startFailureLabel: "输出上限测试",
      timeoutMs: 2_000,
      maxOutputChars: 10,
    });

    assert.equal(result.output, "x".repeat(10));
    assert.equal(result.outputLength, 100);
    assert.equal(result.outputTruncated, true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("AbortSignal 会取消进程树并返回明确的 cancelled 状态", async () => {
  const workspace = await createWorkspace();
  const markerPath = path.join(workspace, "cancelled-late-marker.txt");
  const scriptPath = path.join(workspace, "cancel-parent.mjs");
  const controller = new AbortController();
  try {
    await fs.writeFile(
      scriptPath,
      "import fs from 'node:fs/promises'; setTimeout(() => void fs.writeFile('cancelled-late-marker.txt', 'late'), 700); setTimeout(() => process.exit(0), 1500);\n",
      "utf8",
    );
    setTimeout(() => controller.abort(), 100);
    const result = await runBoundedProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: workspace,
      env: createSanitizedChildEnvironment(),
      action: "cancel_tree_test",
      startFailureLabel: "取消树测试",
      timeoutMs: 2_000,
      maxOutputChars: 1_000,
      signal: controller.signal,
    });

    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(fs.access(markerPath));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function toolResult(attempt: CommandAttempt): ToolResultMessage | undefined {
  return attempt.result.messages.find(
    (message): message is ToolResultMessage => message.role === "tool" && message.name === "run_command",
  );
}

function lifecycle(attempt: CommandAttempt): string[] {
  return attempt.result.events
    .filter((event) => "toolCallId" in event && event.toolCallId === "command-1")
    .map((event) => event.type);
}

function finalizedAudit(attempt: CommandAttempt): Record<string, unknown> | undefined {
  return attempt.audit.findLast(
    (event) => event.type === "tool_finalized" && event.toolCallId === "command-1",
  );
}

function successfulResult(output = "COMMAND_OK"): CommandRunResult {
  return {
    exitCode: 0,
    durationMs: 4,
    output,
    outputLength: output.length,
    outputTruncated: false,
    timedOut: false,
  };
}

function assertAuditOmits(attempt: CommandAttempt, values: readonly string[]): void {
  for (const value of values) {
    assert.equal(attempt.rawAudit.includes(value), false, `审计不应包含：${value}`);
    const jsonEscaped = value.replaceAll("\\", "\\\\");
    assert.equal(attempt.rawAudit.includes(jsonEscaped), false, `审计不应包含 JSON 转义值：${value}`);
  }
}

test("合法 RUN 将 program、args、cwd 与脱敏 env 分离，Shell 元字符保持字面参数", async () => {
  const workspace = await createWorkspace();
  const nestedCwd = path.join(workspace, "packages", "app");
  const secretName = "MINICODE_RUN_COMMAND_TEST_SECRET";
  const secretValue = "SENSITIVE_ENV_VALUE_7A49";
  const previousSecret = process.env[secretName];
  process.env[secretName] = secretValue;
  const args = [
    "scripts/check.mjs",
    "SENSITIVE_ARG_MARKER alpha beta",
    "&&",
    "|",
    ">",
    "$(echo not-a-shell)",
  ];
  let runnerCalls = 0;
  let receivedRequest: CommandRunRequest | undefined;
  let approvalRequest: CommandApprovalRequest | undefined;
  const output = "SENSITIVE_COMMAND_OUTPUT_2C91";
  const runner: CommandRunner = {
    async run(request): Promise<CommandRunResult> {
      runnerCalls += 1;
      receivedRequest = request;
      return successfulResult(output);
    },
  };

  try {
    const attempt = await runCommandAttempt(
      workspace,
      { program: "node.exe", args, cwd: "packages/app" },
      runner,
      async (request) => {
        approvalRequest = request;
        return true;
      },
    );

    assert.equal(runnerCalls, 1);
    assert.ok(receivedRequest);
    assert.equal(receivedRequest.program, "node");
    assert.deepEqual(receivedRequest.args, args);
    assert.equal(receivedRequest.cwd, await fs.realpath(nestedCwd));
    assert.equal(receivedRequest.env[secretName], undefined);
    assert.equal(Object.values(receivedRequest.env).includes(secretValue), false);
    assert.equal("shell" in receivedRequest, false);

    assert.ok(approvalRequest);
    assert.equal(approvalRequest.kind, "command");
    assert.equal(approvalRequest.action, "run_command");
    assert.equal(approvalRequest.workingDirectory, await fs.realpath(nestedCwd));
    assert.equal(approvalRequest.riskLevel, "medium");
    assert.equal(
      approvalRequest.command,
      ["node", ...args.map((argument) => JSON.stringify(argument))].join(" "),
    );
    assert.match(approvalRequest.risk, /不是操作系统沙箱/);

    assert.equal(toolResult(attempt)?.status, "success");
    assert.match(toolResult(attempt)?.content ?? "", /SENSITIVE_COMMAND_OUTPUT_2C91/);
    assert.deepEqual(lifecycle(attempt), [
      "tool_call",
      "command_approval_requested",
      "command_approval_decision",
      "tool_execution_started",
      "policy_decision",
      "tool_finalized",
    ]);
    assert.equal(finalizedAudit(attempt)?.riskLevel, "medium");
    assert.equal(finalizedAudit(attempt)?.exitCode, 0);
    assert.equal(
      attempt.audit.find((event) => event.type === "command_approval_decision")?.commandDecision,
      "approved",
    );
    assertAuditOmits(attempt, [
      "scripts/check.mjs",
      "SENSITIVE_ARG_MARKER",
      "$(echo not-a-shell)",
      workspace,
      output,
      secretName,
      secretValue,
    ]);
  } finally {
    if (previousSecret === undefined) {
      delete process.env[secretName];
    } else {
      process.env[secretName] = previousSecret;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("CANCEL、缺少确认回调和确认异常都保持零执行且不泄露确认异常", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      throw new Error("runner must stay closed");
    },
  };
  const input = {
    program: "npm",
    args: ["test", "--", "SENSITIVE_CANCEL_ARG_3B20"],
    cwd: ".",
  } satisfies JsonObject;

  try {
    const cancelled = await runCommandAttempt(workspace, input, runner, async () => false);
    assert.equal(toolResult(cancelled)?.status, "error");
    assert.match(toolResult(cancelled)?.content ?? "", /用户已取消受控命令/);
    assert.deepEqual(lifecycle(cancelled), [
      "tool_call",
      "command_approval_requested",
      "command_approval_decision",
      "tool_finalized",
    ]);
    assert.equal(finalizedAudit(cancelled)?.riskLevel, "medium");
    assert.equal(
      cancelled.audit.find((event) => event.type === "command_approval_decision")?.commandDecision,
      "rejected",
    );

    const missingCallback = await runCommandAttempt(workspace, input, runner, null);
    assert.equal(toolResult(missingCallback)?.status, "error");
    assert.match(toolResult(missingCallback)?.content ?? "", /未配置本地命令确认/);
    assert.equal(lifecycle(missingCallback).includes("tool_execution_started"), false);

    const approvalError = await runCommandAttempt(workspace, input, runner, async () => {
      throw new Error("SENSITIVE_APPROVAL_ERROR_5F88");
    });
    assert.equal(toolResult(approvalError)?.status, "error");
    assert.match(toolResult(approvalError)?.content ?? "", /本地命令确认不可用/);
    assert.doesNotMatch(toolResult(approvalError)?.content ?? "", /SENSITIVE_APPROVAL_ERROR/);
    assert.equal(lifecycle(approvalError).includes("tool_execution_started"), false);

    assert.equal(runnerCalls, 0);
    for (const attempt of [cancelled, missingCallback, approvalError]) {
      assertAuditOmits(attempt, ["SENSITIVE_CANCEL_ARG_3B20", workspace]);
    }
    assertAuditOmits(approvalError, ["SENSITIVE_APPROVAL_ERROR_5F88"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("未知程序、Git 与 Shell 在确认前被策略阻断", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  let approvalCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      return successfulResult();
    },
  };
  const cases = [
    { program: "python", args: ["SENSITIVE_UNKNOWN_1"], marker: "SENSITIVE_UNKNOWN_1" },
    { program: "git", args: ["commit", "-m", "SENSITIVE_GIT_2"], marker: "SENSITIVE_GIT_2" },
    { program: "cmd.exe", args: ["/c", "del", "SENSITIVE_CMD_3"], marker: "SENSITIVE_CMD_3" },
    { program: "powershell", args: ["-Command", "Remove-Item SENSITIVE_PS_4"], marker: "SENSITIVE_PS_4" },
  ];

  try {
    for (const blockedCase of cases) {
      const attempt = await runCommandAttempt(
        workspace,
        { program: blockedCase.program, args: blockedCase.args, cwd: "." },
        runner,
        async () => {
          approvalCalls += 1;
          return true;
        },
      );

      assert.equal(toolResult(attempt)?.status, "error");
      assert.match(toolResult(attempt)?.content ?? "", /程序不在第一版允许列表/);
      assert.deepEqual(lifecycle(attempt), ["tool_call", "policy_decision", "tool_finalized"]);
      assert.equal(
        attempt.audit.find((event) => event.type === "policy_decision")?.decision,
        "blocked",
      );
      assert.equal(lifecycle(attempt).includes("command_approval_requested"), false);
      assert.equal(lifecycle(attempt).includes("tool_execution_started"), false);
      assertAuditOmits(attempt, [blockedCase.marker, workspace]);
    }

    assert.equal(approvalCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Node eval、npm 全局参数和 publish 在确认前被策略阻断", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  let approvalCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      return successfulResult();
    },
  };
  const cases = [
    {
      input: { program: "node", args: ["-e", "console.log('SENSITIVE_EVAL_1')"], cwd: "." },
      message: /Node 的 eval\/print/,
      marker: "SENSITIVE_EVAL_1",
    },
    {
      input: { program: "npm", args: ["install", "--global", "SENSITIVE_GLOBAL_2"], cwd: "." },
      message: /npm 全局操作/,
      marker: "SENSITIVE_GLOBAL_2",
    },
    {
      input: { program: "npm", args: ["install", "--global=true", "SENSITIVE_GLOBAL_TRUE_2B"], cwd: "." },
      message: /npm 全局操作/,
      marker: "SENSITIVE_GLOBAL_TRUE_2B",
    },
    {
      input: { program: "npm", args: ["install", "-g=true", "SENSITIVE_SHORT_GLOBAL_2C"], cwd: "." },
      message: /npm 全局操作/,
      marker: "SENSITIVE_SHORT_GLOBAL_2C",
    },
    {
      input: { program: "npm", args: ["publish", "--tag", "SENSITIVE_PUBLISH_3"], cwd: "." },
      message: /npm 动作不在第一版允许列表/,
      marker: "SENSITIVE_PUBLISH_3",
    },
    {
      input: { program: "node", args: ["--import=data:text/javascript,SENSITIVE_IMPORT_4"], cwd: "." },
      message: /工作区相对脚本作为第一个参数/,
      marker: "SENSITIVE_IMPORT_4",
    },
    {
      input: { program: "node", args: ["--require=../../SENSITIVE_REQUIRE_5.cjs", "script.mjs"], cwd: "." },
      message: /工作区相对脚本作为第一个参数/,
      marker: "SENSITIVE_REQUIRE_5",
    },
    {
      input: { program: "node", args: ["../../../SENSITIVE_OUTSIDE_6.mjs"], cwd: "packages/app" },
      message: /Node 入口脚本必须是工作目录中已存在/,
      marker: "SENSITIVE_OUTSIDE_6",
    },
    {
      input: { program: "node", args: [path.resolve(workspace, "..", "SENSITIVE_ABSOLUTE_7.mjs")], cwd: "." },
      message: /Node 入口脚本必须是工作区相对路径/,
      marker: "SENSITIVE_ABSOLUTE_7",
    },
  ];

  try {
    for (const blockedCase of cases) {
      const attempt = await runCommandAttempt(workspace, blockedCase.input, runner, async () => {
        approvalCalls += 1;
        return true;
      });

      assert.equal(toolResult(attempt)?.status, "error");
      assert.match(toolResult(attempt)?.content ?? "", blockedCase.message);
      assert.deepEqual(lifecycle(attempt), ["tool_call", "policy_decision", "tool_finalized"]);
      assert.equal(
        attempt.audit.find((event) => event.type === "policy_decision")?.decision,
        "blocked",
      );
      assertAuditOmits(attempt, [blockedCase.marker, workspace]);
    }

    assert.equal(approvalCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Node 入口后的参数和 npm 双横线后的参数不会被误判为运行时覆盖", async () => {
  const workspace = await createWorkspace();
  const observed: CommandRunRequest[] = [];
  const runner: CommandRunner = {
    async run(request): Promise<CommandRunResult> {
      observed.push(request);
      return successfulResult();
    },
  };
  try {
    const nodeAttempt = await runCommandAttempt(
      workspace,
      { program: "node", args: ["packages/app/scripts/check.mjs", "-e", "--print"], cwd: "." },
      runner,
    );
    const npmAttempt = await runCommandAttempt(
      workspace,
      { program: "npm", args: ["run", "build", "--", "--prefix", "script-value"], cwd: "." },
      runner,
    );

    assert.equal(toolResult(nodeAttempt)?.status, "success");
    assert.equal(toolResult(npmAttempt)?.status, "success");
    assert.deepEqual(observed[0]?.args, ["packages/app/scripts/check.mjs", "-e", "--print"]);
    assert.deepEqual(observed[1]?.args, ["run", "build", "--", "--prefix", "script-value"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("绝对、越界和文件型 cwd 在确认前被路径策略阻断", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  let approvalCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      return successfulResult();
    },
  };
  const cwdCases = [workspace, "../outside", "package.json"];

  try {
    for (const cwd of cwdCases) {
      const attempt = await runCommandAttempt(
        workspace,
        { program: "node", args: ["--version"], cwd },
        runner,
        async () => {
          approvalCalls += 1;
          return true;
        },
      );

      assert.equal(toolResult(attempt)?.status, "error");
      assert.match(toolResult(attempt)?.content ?? "", /工作目录未通过工作区路径策略/);
      assert.deepEqual(lifecycle(attempt), ["tool_call", "policy_decision", "tool_finalized"]);
      assert.equal(
        attempt.audit.find((event) => event.type === "policy_decision")?.decision,
        "blocked",
      );
      assert.equal(lifecycle(attempt).includes("command_approval_requested"), false);
      assert.equal(lifecycle(attempt).includes("tool_execution_started"), false);
      assertAuditOmits(attempt, [workspace]);
    }

    assert.equal(approvalCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("审批期间 cwd 失效会在执行期二次校验中记录 blocked 且保持零进程", async () => {
  const workspace = await createWorkspace();
  const nestedCwd = path.join(workspace, "packages", "app");
  let runnerCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      return successfulResult();
    },
  };
  try {
    const attempt = await runCommandAttempt(
      workspace,
      { program: "npm", args: ["--version"], cwd: "packages/app" },
      runner,
      async () => {
        await fs.rm(nestedCwd, { recursive: true, force: true });
        return true;
      },
    );

    assert.equal(runnerCalls, 0);
    assert.equal(toolResult(attempt)?.status, "error");
    assert.match(toolResult(attempt)?.content ?? "", /工作目录未通过工作区路径策略/);
    assert.deepEqual(lifecycle(attempt), [
      "tool_call",
      "command_approval_requested",
      "command_approval_decision",
      "tool_execution_started",
      "policy_decision",
      "tool_finalized",
    ]);
    assert.equal(
      attempt.audit.find((event) => event.type === "policy_decision")?.decision,
      "blocked",
    );
    assertAuditOmits(attempt, [workspace]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("控制字符和模型提供的 env 在参数校验阶段被拒绝", async () => {
  const workspace = await createWorkspace();
  let runnerCalls = 0;
  let approvalCalls = 0;
  const runner: CommandRunner = {
    async run(): Promise<CommandRunResult> {
      runnerCalls += 1;
      return successfulResult();
    },
  };
  const cases: Array<{ input: JsonObject; message: RegExp; marker: string }> = [
    {
      input: { program: "node\n", args: ["--version"], cwd: "." },
      message: /program 必须是简短的程序名/,
      marker: "node\n",
    },
    {
      input: { program: "node", args: ["script.mjs\u001B[31m"], cwd: "." },
      message: /args 不能包含换行、终端控制或双向文本控制字符/,
      marker: "\u001B[31m",
    },
    {
      input: { program: "node", args: ["script.mjs\u009B31m"], cwd: "." },
      message: /双向文本控制字符/,
      marker: "\u009B31m",
    },
    {
      input: { program: "node", args: ["safe\u202Egpj.mjs"], cwd: "." },
      message: /双向文本控制字符/,
      marker: "\u202E",
    },
    {
      input: { program: "node", args: ["safe\u200F.mjs"], cwd: "." },
      message: /双向文本控制字符/,
      marker: "\u200F",
    },
    {
      input: { program: "node", args: ["--version"], cwd: ".\nspoof" },
      message: /cwd 必须是 500 字符以内/,
      marker: "spoof",
    },
    {
      input: {
        program: "node",
        args: ["--version"],
        cwd: ".",
        env: { MINICODE_SECRET: "SENSITIVE_MODEL_ENV_6D33" },
      },
      message: /不支持的参数：env/,
      marker: "SENSITIVE_MODEL_ENV_6D33",
    },
  ];

  try {
    for (const invalidCase of cases) {
      const attempt = await runCommandAttempt(workspace, invalidCase.input, runner, async () => {
        approvalCalls += 1;
        return true;
      });

      assert.equal(toolResult(attempt)?.status, "error");
      assert.match(toolResult(attempt)?.content ?? "", invalidCase.message);
      assert.deepEqual(lifecycle(attempt), ["tool_call", "tool_finalized"]);
      assertAuditOmits(attempt, [invalidCase.marker, workspace]);
    }

    assert.equal(approvalCalls, 0);
    assert.equal(runnerCalls, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("非零退出、超时、取消和截断形成安全终态，审计只保留元数据", async () => {
  const workspace = await createWorkspace();
  const cases = [
    {
      result: {
        exitCode: 7,
        durationMs: 11,
        output: "SENSITIVE_NONZERO_OUTPUT_A1",
        outputLength: 27,
        outputTruncated: false,
        timedOut: false,
        cancelled: false,
      } satisfies CommandRunResult,
      status: "error",
      message: /受控命令失败/,
    },
    {
      result: {
        exitCode: null,
        durationMs: 60_000,
        output: "SENSITIVE_TIMEOUT_OUTPUT_B2",
        outputLength: 27,
        outputTruncated: false,
        timedOut: true,
        cancelled: false,
      } satisfies CommandRunResult,
      status: "error",
      message: /受控命令超时/,
    },
    {
      result: {
        exitCode: null,
        durationMs: 21,
        output: "SENSITIVE_CANCELLED_OUTPUT_B3",
        outputLength: 29,
        outputTruncated: false,
        timedOut: false,
        cancelled: true,
      } satisfies CommandRunResult,
      status: "error",
      message: /受控命令已取消/,
    },
    {
      result: {
        exitCode: 0,
        durationMs: 12,
        output: "SENSITIVE_TRUNCATED_OUTPUT_C3",
        outputLength: 50_000,
        outputTruncated: true,
        timedOut: false,
        cancelled: false,
      } satisfies CommandRunResult,
      status: "success",
      message: /输出已截断/,
    },
  ] as const;

  try {
    for (const commandCase of cases) {
      let runnerCalls = 0;
      const runner: CommandRunner = {
        async run(): Promise<CommandRunResult> {
          runnerCalls += 1;
          return commandCase.result;
        },
      };
      const attempt = await runCommandAttempt(
        workspace,
        { program: "npm", args: ["test", "--", "SENSITIVE_RESULT_ARG_D4"], cwd: "." },
        runner,
      );

      assert.equal(runnerCalls, 1);
      assert.equal(toolResult(attempt)?.status, commandCase.status);
      assert.match(toolResult(attempt)?.content ?? "", commandCase.message);
      assert.equal(finalizedAudit(attempt)?.exitCode, commandCase.result.exitCode);
      assert.equal(finalizedAudit(attempt)?.durationMs, commandCase.result.durationMs);
      assert.equal(finalizedAudit(attempt)?.outputLength, commandCase.result.outputLength);
      assert.equal(finalizedAudit(attempt)?.outputTruncated, commandCase.result.outputTruncated);
      assert.equal(finalizedAudit(attempt)?.timedOut, commandCase.result.timedOut);
      assert.equal(finalizedAudit(attempt)?.cancelled, commandCase.result.cancelled);
      assert.equal(finalizedAudit(attempt)?.riskLevel, "medium");
      assertAuditOmits(attempt, [
        commandCase.result.output,
        "SENSITIVE_RESULT_ARG_D4",
        workspace,
      ]);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
