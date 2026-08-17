import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Terminal } from "@mariozechner/pi-tui";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { createMiniTui, MiniTuiApp } from "../src/mini.ts";
import { parseArguments } from "../src/runtime.ts";
import { applyPatch } from "../src/tools/apply-patch.ts";
import {
  createRunProjectCheckTool,
  type ProjectCheckRunResult,
  type ProjectCheckRunner,
} from "../src/tools/run-project-check.ts";
import {
  createRunCommandTool,
  type CommandRunResult,
  type CommandRunner,
} from "../src/tools/run-command.ts";

class FakeTerminal implements Terminal {
  #onInput?: (data: string) => void;
  output = "";
  columns = 100;
  rows = 32;
  kittyProtocolActive = false;

  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  send(data: string): void {
    this.#onInput?.(data);
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B_pi:c\u0007/g, "");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 TUI 状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("mini TUI renders compact lifecycle feedback and keeps tool details collapsed by default", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-tui-"));
  const auditPath = path.join(reportDirectory, "audit.jsonl");
  const terminal = new FakeTerminal();
  try {
    const app = createMiniTui(["--workspace", process.cwd(), "--audit", auditPath], terminal);
    app.start();
    await app.submit("解释未知工具为何仍有完整的终态事件");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = stripAnsi(terminal.output);
    assert.match(output, /MiniCode/);
    assert.match(output, /工具活动已折叠/);
    assert.match(output, /只读代码侦察闭环已完成/);
    assert.doesNotMatch(output, /任务账本/);
    assert.equal(app.contextTurns, 1);

    terminal.send("\u000f");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(stripAnsi(terminal.output), /工具活动.*Ctrl\+O 折叠/);

    await app.submit("/clear");
    assert.equal(app.contextTurns, 0);
    const events = (await fs.readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(events.at(-1)?.type, "agent_completed");
    app.stop();
  } finally {
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("mini TUI intercepts Ctrl+V and inserts plain clipboard text into the editor", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-clipboard-"));
  const terminal = new FakeTerminal();
  try {
    const app = createMiniTui(
      ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
      { readClipboard: async () => "粘贴的任务文本：修复 greeting" },
    );
    app.start();
    terminal.send("\u0016");
    await waitFor(() => app.editorText === "粘贴的任务文本：修复 greeting");
    assert.equal(app.editorText, "粘贴的任务文本：修复 greeting");
    app.stop();
  } finally {
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("mini TUI lists configured Profiles and switches model without sending a request", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-profile-"));
  const auditPath = path.join(reportDirectory, "audit.jsonl");
  const terminal = new FakeTerminal();
  const originalBaseUrl = process.env.MINICODE_OPENAI_BASE_URL;
  const originalModel = process.env.MINICODE_OPENAI_MODEL;
  const originalApiKey = process.env.MINICODE_OPENAI_API_KEY;
  let app: MiniTuiApp | undefined;
  try {
    process.env.MINICODE_OPENAI_BASE_URL = "https://gateway.example/v1";
    process.env.MINICODE_OPENAI_MODEL = "test-coder";
    process.env.MINICODE_OPENAI_API_KEY = "test-key";
    app = createMiniTui(["--workspace", process.cwd(), "--audit", auditPath], terminal);
    app.start();

    await app.submit("/model");
    await waitFor(() => stripAnsi(terminal.output).includes("openai-compatible"));
    assert.match(stripAnsi(terminal.output), /openai-compatible/);
    assert.match(stripAnsi(terminal.output), /MINICODE_OPENAI_API_KEY/);

    await app.submit("/model openai");
    await waitFor(() => stripAnsi(terminal.output).includes("已切换到 OpenAI-compatible / test-coder"));
    assert.equal(app.contextTurns, 0);
    assert.match(stripAnsi(terminal.output), /后续发送给模型的会话已清空/);
  } finally {
    app?.stop();
    if (originalBaseUrl === undefined) delete process.env.MINICODE_OPENAI_BASE_URL;
    else process.env.MINICODE_OPENAI_BASE_URL = originalBaseUrl;
    if (originalModel === undefined) delete process.env.MINICODE_OPENAI_MODEL;
    else process.env.MINICODE_OPENAI_MODEL = originalModel;
    if (originalApiKey === undefined) delete process.env.MINICODE_OPENAI_API_KEY;
    else process.env.MINICODE_OPENAI_API_KEY = originalApiKey;
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("mini TUI never sends reserved approval words to the model without a pending confirmation", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-apply-guard-"));
  const terminal = new FakeTerminal();
  let app: MiniTuiApp | undefined;
  try {
    app = createMiniTui(
      ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
    );
    app.start();

    for (const input of ["APPLY", "apply", "CONTINUE", "continue", "RUN", "run", "CANCEL", "cancel"]) {
      await app.submit(input);
    }

    assert.equal(app.contextTurns, 0);
    await waitFor(() => stripAnsi(terminal.output).includes("当前没有待确认补丁"));
    assert.match(stripAnsi(terminal.output), /当前没有待确认补丁/);
    assert.match(stripAnsi(terminal.output), /当前没有待确认验证/);
    assert.match(stripAnsi(terminal.output), /当前没有待确认操作/);
  } finally {
    app?.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("验证命令在 TUI 等待精确 RUN，确认前不会启动 runner", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-command-run-"));
  const terminal = new FakeTerminal();
  let runnerCalls = 0;
  let modelCalls = 0;
  const runner: ProjectCheckRunner = {
    async run(): Promise<ProjectCheckRunResult> {
      runnerCalls += 1;
      return {
        exitCode: 0,
        durationMs: 3,
        output: "CHECK_OK",
        outputLength: 8,
        outputTruncated: false,
        timedOut: false,
      };
    },
  };
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "请求固定验证。",
          toolCalls: [{ id: "check-1", name: "run_project_check", input: { action: "test" } }],
        };
      }
      const lastMessage = request.messages.at(-1);
      assert.equal(lastMessage?.role, "tool");
      if (lastMessage?.role !== "tool") throw new Error("缺少验证工具结果。");
      assert.equal(lastMessage.status, "success");
      assert.equal(request.messages.some((message) => message.role === "user" && message.content === "RUN"), false);
      return { kind: "final", content: "验证已确认并完成。" };
    },
  };

  const options = parseArguments(["--workspace", workspace, "--audit", path.join(workspace, "audit.jsonl")]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([createRunProjectCheckTool(runner)]), {
    workspaceRoot: workspace,
    requestCommandApproval: (request) => app?.requestCommandApproval(request) ?? Promise.resolve(false),
  });
  app = new MiniTuiApp(options, terminal, agent);

  try {
    app.start();
    const task = app.submit("运行测试验证修改");
    await waitFor(() => app?.awaitingCommandApproval === true);

    const pendingOutput = stripAnsi(terminal.output);
    assert.equal(runnerCalls, 0);
    assert.match(pendingOutput, /待确认验证.*test/);
    assert.match(pendingOutput, /固定命令：npm test/);
    assert.match(pendingOutput, /工作目录：/);
    assert.match(pendingOutput, /package\.json/);
    assert.match(pendingOutput, /访问网络/);
    assert.match(pendingOutput, /等待确认：RUN \/ CANCEL/);

    await app.submit("run");
    assert.equal(app.awaitingCommandApproval, true);
    assert.equal(runnerCalls, 0);
    await waitFor(() => stripAnsi(terminal.output).includes("验证仍在等待确认"));

    await app.submit("RUN");
    await task;
    assert.equal(runnerCalls, 1);
    assert.equal(modelCalls, 2);
    assert.equal(app.contextTurns, 1);
    await waitFor(() => stripAnsi(terminal.output).includes("验证已确认并完成"));
    assert.match(stripAnsi(terminal.output), /验证已确认并完成/);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("TUI 中取消验证不会启动 runner，也不会把 CANCEL 写入模型上下文", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-command-cancel-"));
  const terminal = new FakeTerminal();
  let runnerCalls = 0;
  let modelCalls = 0;
  const runner: ProjectCheckRunner = {
    async run(): Promise<ProjectCheckRunResult> {
      runnerCalls += 1;
      throw new Error("runner must stay closed");
    },
  };
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "请求固定验证。",
          toolCalls: [{ id: "check-1", name: "run_project_check", input: { action: "check" } }],
        };
      }
      const lastMessage = request.messages.at(-1);
      assert.equal(lastMessage?.role, "tool");
      assert.equal(lastMessage?.status, "error");
      assert.equal(request.messages.some((message) => message.role === "user" && message.content === "CANCEL"), false);
      return { kind: "final", content: "验证已由用户取消。" };
    },
  };

  const options = parseArguments(["--workspace", workspace, "--audit", path.join(workspace, "audit.jsonl")]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([createRunProjectCheckTool(runner)]), {
    workspaceRoot: workspace,
    requestCommandApproval: (request) => app?.requestCommandApproval(request) ?? Promise.resolve(false),
  });
  app = new MiniTuiApp(options, terminal, agent);

  try {
    app.start();
    const task = app.submit("运行类型检查");
    await waitFor(() => app?.awaitingCommandApproval === true);
    await app.submit("CANCEL");
    await task;

    assert.equal(runnerCalls, 0);
    assert.equal(modelCalls, 2);
    assert.equal(app.contextTurns, 1);
    await waitFor(() => stripAnsi(terminal.output).includes("验证已由用户取消"));
    assert.match(stripAnsi(terminal.output), /已取消验证，固定命令未执行/);
    assert.match(stripAnsi(terminal.output), /验证已由用户取消/);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("通用受控命令在 TUI 展示风险并只接受精确 RUN", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-run-command-"));
  const terminal = new FakeTerminal();
  let runnerCalls = 0;
  let modelCalls = 0;
  const runner: CommandRunner = {
    async run(request): Promise<CommandRunResult> {
      runnerCalls += 1;
      assert.equal(request.program, "npm");
      assert.deepEqual(request.args, ["run", "check", "--", "--pretty=false"]);
      assert.equal(request.cwd, path.resolve(workspace));
      return {
        exitCode: 0,
        durationMs: 4,
        output: "COMMAND_OK",
        outputLength: 10,
        outputTruncated: false,
        timedOut: false,
      };
    },
  };
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "请求运行受控项目命令。",
          toolCalls: [{
            id: "command-1",
            name: "run_command",
            input: {
              program: "npm",
              args: ["run", "check", "--", "--pretty=false"],
              cwd: ".",
            },
          }],
        };
      }

      const lastMessage = request.messages.at(-1);
      assert.equal(lastMessage?.role, "tool");
      if (lastMessage?.role !== "tool") throw new Error("缺少受控命令工具结果。");
      assert.equal(lastMessage.status, "success");
      assert.equal(
        request.messages.some(
          (message) => message.role === "user" && (message.content === "RUN" || message.content === "run"),
        ),
        false,
      );
      return { kind: "final", content: "受控命令已确认并完成。" };
    },
  };

  const options = parseArguments(["--workspace", workspace, "--audit", path.join(workspace, "audit.jsonl")]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([createRunCommandTool(runner)]), {
    workspaceRoot: workspace,
    requestCommandApproval: (request) => app?.requestCommandApproval(request) ?? Promise.resolve(false),
  });
  app = new MiniTuiApp(options, terminal, agent);

  try {
    app.start();
    const task = app.submit("运行项目 check 命令并汇报结果");
    await waitFor(() => app?.awaitingCommandApproval === true);
    await waitFor(() => stripAnsi(terminal.output).includes("待确认命令"));

    const pendingOutput = stripAnsi(terminal.output);
    assert.equal(runnerCalls, 0);
    assert.match(pendingOutput, /待确认命令.*run_command/);
    assert.match(pendingOutput, /命令：npm "run" "check" "--" "--pretty=false"/);
    assert.ok(pendingOutput.includes(`工作目录：${path.resolve(workspace)}`));
    assert.match(pendingOutput, /风险等级：中（medium）/);
    assert.match(pendingOutput, /不是操作系统沙箱/);
    assert.match(pendingOutput, /等待确认：RUN \/ CANCEL/);

    await app.submit("run");
    assert.equal(app.awaitingCommandApproval, true);
    assert.equal(runnerCalls, 0);
    await waitFor(() => stripAnsi(terminal.output).includes("命令仍在等待确认"));

    await app.submit("RUN");
    await task;
    assert.equal(runnerCalls, 1);
    assert.equal(modelCalls, 2);
    assert.equal(app.contextTurns, 1);
    await waitFor(() => stripAnsi(terminal.output).includes("受控命令已确认并完成"));
    assert.match(stripAnsi(terminal.output), /受控命令已确认并完成/);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("guided TUI shows a plan and waits for CONTINUE before tools can run", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-guided-"));
  const terminal = new FakeTerminal();
  let app: MiniTuiApp | undefined;
  try {
    app = createMiniTui(
      ["--guided", "--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
    );
    app.start();

    const task = app.submit("解释未知工具为何仍有完整的终态事件");
    await waitFor(() => app?.awaitingPlanApproval === true);
    assert.equal(app.contextTurns, 0);
    assert.match(stripAnsi(terminal.output), /待确认计划/);
    assert.match(stripAnsi(terminal.output), /CONTINUE/);

    await app.submit("continue");
    assert.equal(app.awaitingPlanApproval, true);
    await waitFor(() => stripAnsi(terminal.output).includes("计划仍在等待确认"));
    assert.match(stripAnsi(terminal.output), /计划仍在等待确认/);

    await app.submit("CONTINUE");
    await task;
    await waitFor(() => app?.contextTurns === 1);
    await waitFor(() => stripAnsi(terminal.output).includes("只读代码侦察闭环已完成"));
    assert.match(stripAnsi(terminal.output), /只读代码侦察闭环已完成/);
  } finally {
    app?.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("编辑模式在 TUI 展示补丁，并且只有 APPLY 会写入文件", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-edit-"));
  const auditPath = path.join(workspace, "audit.jsonl");
  const targetPath = path.join(workspace, "src", "example.ts");
  const terminal = new FakeTerminal();
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, "export const value = 'before';\n", "utf8");

  let modelCalls = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "提出一个最小补丁。",
          toolCalls: [{
            id: "patch-1",
            name: "apply_patch",
            input: { path: "src/example.ts", oldText: "before", newText: "after" },
          }],
        };
      }
      assert.equal(request.messages.at(-1)?.role, "tool");
      return { kind: "final", content: "补丁已确认并写入。" };
    },
  };

  const options = parseArguments(["--workspace", workspace, "--audit", auditPath, "--mode", "edit"]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([applyPatch]), {
    workspaceRoot: workspace,
    executionMode: "apply",
    requestEditApproval: (request) => app?.requestEditApproval(request) ?? Promise.resolve(false),
  });
  app = new MiniTuiApp(options, terminal, agent);

  try {
    app.start();
    const task = app.submit("把 before 改成 after");
    await waitFor(() => stripAnsi(terminal.output).includes("待确认补丁"));
    assert.match(stripAnsi(terminal.output), /输入 APPLY/);
    assert.match(stripAnsi(terminal.output), /等待确认：APPLY \/ CANCEL/);
    assert.doesNotMatch(stripAnsi(terminal.output), /```diff/);
    assert.match(await fs.readFile(targetPath, "utf8"), /before/);

    await app.submit("apply");
    assert.equal(app.awaitingApproval, true);
    await waitFor(() => stripAnsi(terminal.output).includes("补丁仍在等待确认"));
    assert.match(stripAnsi(terminal.output), /补丁仍在等待确认/);
    assert.match(await fs.readFile(targetPath, "utf8"), /before/);

    await app.submit("APPLY");
    await task;
    await waitFor(() => stripAnsi(terminal.output).includes("补丁已确认并写入"));
    assert.match(await fs.readFile(targetPath, "utf8"), /after/);
    assert.equal(app.contextTurns, 1);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
