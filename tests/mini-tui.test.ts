import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Terminal } from "@mariozechner/pi-tui";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type {
  AgentTool,
  ChatModel,
  JsonValue,
  ModelRequest,
  ModelResponse,
  ToolExecutionOutput,
} from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { createMiniTui, MiniTuiApp } from "../src/mini.ts";
import { parseArguments } from "../src/runtime.ts";
import { applyPatch } from "../src/tools/apply-patch.ts";
import { createInspectGitTool, type GitRunner } from "../src/tools/inspect-git.ts";
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

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeTerminal implements Terminal {
  #onInput?: (data: string) => void;
  #onResize?: () => void;
  output = "";
  columns = 100;
  rows = 32;
  kittyProtocolActive = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#onInput = onInput;
    this.#onResize = onResize;
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

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.#onResize?.();
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

const REPAIR_DIRECTION = "读取失败断言对应的实现，只做最小修复，然后重新运行 test。";
const LOCAL_CONTROL_WORDS = new Set(["APPLY", "CONTINUE", "RUN", "CANCEL"]);

interface RepairTuiHarness {
  app: MiniTuiApp;
  terminal: FakeTerminal;
  modelRequests: ModelRequest[];
  readonly runnerCalls: number;
}

async function createRepairTuiHarness(workspace: string): Promise<RepairTuiHarness> {
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  const terminal = new FakeTerminal();
  const modelRequests: ModelRequest[] = [];
  let runnerCalls = 0;
  const runner: ProjectCheckRunner = {
    async run(): Promise<ProjectCheckRunResult> {
      runnerCalls += 1;
      return {
        exitCode: 1,
        durationMs: 4,
        output: "AssertionError: expected repaired value",
        outputLength: 39,
        outputTruncated: false,
        timedOut: false,
      };
    },
  };
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      modelRequests.push(request);
      switch (modelRequests.length) {
        case 1:
          assert.equal(request.phase, "execution");
          return {
            kind: "tool_calls",
            content: "先运行固定验证。",
            toolCalls: [{ id: "repair-check-1", name: "run_project_check", input: { action: "test" } }],
          };
        case 2:
          assert.equal(request.phase, "repair_planning");
          assert.equal(request.tools.length, 0);
          assert.equal(
            request.messages.some(
              (message) => message.role === "tool" && message.name === "run_project_check" && message.status === "error",
            ),
            true,
          );
          return { kind: "final", content: REPAIR_DIRECTION };
        case 3:
          assert.equal(request.phase, "execution");
          assert.equal(
            request.messages.some(
              (message) => message.role === "user" && /修复方向已由用户确认/u.test(message.content),
            ),
            true,
          );
          assertNoLocalControlWords(modelRequests);
          return { kind: "final", content: "已按确认的方向结束本次有界修复演示。" };
        default:
          throw new Error(`repair TUI 收到未预期的第 ${modelRequests.length} 次模型请求。`);
      }
    },
  };
  const options = parseArguments(["--workspace", workspace, "--audit", path.join(workspace, "audit.jsonl")]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([createRunProjectCheckTool(runner)]), {
    workspaceRoot: workspace,
    maxSteps: 3,
    enableFailureRepair: true,
    requestCommandApproval: async () => true,
    requestRepairApproval: (request) => app?.requestRepairApproval(request) ?? Promise.resolve(false),
    onEvent: (event) => app?.handleAgentEvent(event),
  });
  app = new MiniTuiApp(options, terminal, agent);
  return {
    app,
    terminal,
    modelRequests,
    get runnerCalls() {
      return runnerCalls;
    },
  };
}

function assertNoLocalControlWords(requests: readonly ModelRequest[]): void {
  for (const request of requests) {
    for (const message of request.messages) {
      if (message.role !== "user") continue;
      assert.equal(
        LOCAL_CONTROL_WORDS.has(message.content.trim().toUpperCase()),
        false,
        `本地控制词不应进入模型消息：${message.content}`,
      );
    }
  }
}

test("mini 使用普通终端历史，不进入备用屏幕或开启鼠标捕获", async () => {
  const source = await fs.readFile(new URL("../src/tui/pi-renderer.ts", import.meta.url), "utf8");

  assert.match(source, /class ScrollbackPreservingTerminal/u);
  assert.doesNotMatch(source, /\?1049[hl]/u);
  assert.doesNotMatch(source, /\?100[0236]h/u);
});

test("npm link 的 junction 入口仍会启动 mini", async () => {
  const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-bin-link-"));
  const linkedProject = path.join(linkParent, "mini-coding-agent");
  await fs.symlink(projectRoot, linkedProject, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(linkedProject, "src", "mini.ts")], {
        cwd: linkParent,
        encoding: "utf8",
      }),
      (error: unknown) => {
        const processError = error as Error & { code?: number; stderr?: string };
        assert.equal(processError.code, 1);
        assert.match(processError.stderr ?? "", /mini 需要可交互的 TTY 终端/u);
        return true;
      },
    );
  } finally {
    await fs.rm(linkParent, { recursive: true, force: true });
  }
});

test("长会话保持原生 scrollback，clear 才显式清除当前终端历史", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-scrollback-"));
  const terminal = new FakeTerminal();
  terminal.rows = 12;
  let modelCalls = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCalls += 1;
      return {
        kind: "final",
        content: Array.from({ length: 24 }, (_, index) => `历史回答 ${modelCalls}-${index + 1}`).join("\n"),
      };
    },
  };
  const options = parseArguments(["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")]);
  const app = new MiniTuiApp(
    options,
    terminal,
    new AgentLoop(model, new ToolRegistry([]), { workspaceRoot: process.cwd() }),
  );
  try {
    app.start();
    await app.submit("第一轮长回答");
    await waitFor(() => stripAnsi(terminal.output).includes("历史回答 1-24"));

    terminal.output = "";
    await app.submit("第二轮长回答");
    await waitFor(() => stripAnsi(terminal.output).includes("历史回答 2-24"));
    assert.doesNotMatch(terminal.output, /\u001B\[3J/u);

    terminal.resize(88, 20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.doesNotMatch(terminal.output, /\u001B\[3J/u);
    assert.equal(app.contextTurns, 2);

    terminal.output = "";
    await app.submit("/clear");
    await waitFor(() =>
      terminal.output.includes("\u001B[3J") &&
      stripAnsi(terminal.output).includes("已清空会话上下文")
    );
    const clearedOutput = stripAnsi(terminal.output);
    assert.match(clearedOutput, /已清空会话上下文/);
    assert.doesNotMatch(clearedOutput, /历史回答 1-|历史回答 2-/);
    assert.equal(app.contextTurns, 0);
    assert.equal(app.sessionViewState.closeout, undefined);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

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
    assert.match(output, /会话.*当前活动/);
    assert.match(output, /工具活动已折叠/);
    assert.match(output, /本次任务收口.*已完成/);
    assert.match(output, /修改：未写入补丁/);
    assert.match(output, /验证：未请求固定验证/);
    assert.match(output, /Git 收口：未读取（不代表工作区干净）/);
    assert.match(output, /审计目标 audit\.jsonl/);
    assert.match(output, /只读代码侦察闭环已完成/);
    assert.doesNotMatch(output, /任务账本/);
    assert.equal(app.contextTurns, 1);
    assert.equal(app.sessionViewState.closeout?.outcome, "completed");
    assert.equal(app.sessionViewState.closeout?.successfulTools, 2);

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

test("默认离线 TUI 对自由输入只说明边界，不创建伪任务", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-fake-boundary-"));
  const auditPath = path.join(reportDirectory, "audit.jsonl");
  const terminal = new FakeTerminal();
  const app = createMiniTui(["--workspace", process.cwd(), "--audit", auditPath], terminal);
  try {
    app.start();
    await app.submit("你好");
    await waitFor(() => stripAnsi(terminal.output).includes("离线 FakeModel 演示"));

    const output = stripAnsi(terminal.output);
    assert.match(output, /当前是离线演示：仅支持固定示例/u);
    assert.match(output, /本次未执行工具，也没有修改文件/u);
    assert.doesNotMatch(output, /只读代码侦察闭环已完成|本次任务收口/u);
    assert.equal(app.running, false);
    assert.equal(app.contextTurns, 0);
    assert.equal(app.sessionViewState.closeout, undefined);
    await assert.rejects(fs.access(auditPath));
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("提交 /help 会保留用户输入，并以分组格式显示帮助", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-help-"));
  const terminal = new FakeTerminal();
  const app = createMiniTui(
    ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
    terminal,
  );
  try {
    app.start();
    terminal.send("/help");
    terminal.send("\r");
    await waitFor(() => stripAnsi(terminal.output).includes("命令与本地确认"));

    const output = stripAnsi(terminal.output);
    assert.match(output, /你\s+\/help/u);
    assert.match(output, /帮助\s+命令与本地确认/u);
    assert.match(output, /会话\s+\/model \[profile\]\s+查看或切换模型 Profile/u);
    assert.match(output, /浏览与输入\s+滚轮或终端滚动条\s+查看历史/u);
    assert.match(output, /本地确认（仅等待确认时有效）\s+CONTINUE\s+开始计划或继续一次有界修复/u);
    assert.match(output, /离线演示（不会自行修改文件）\s+源码查看\s+说明未知工具为何仍有完整的终态事件/u);
    assert.doesNotMatch(output, /Ctrl\+V 粘贴文本；\/model 查看或切换模型/u);
    assert.equal(app.editorText, "");
    assert.equal(app.contextTurns, 0);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("mini TUI projects phase, persistent plan, and local approval controls without owning approval decisions", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-session-view-"));
  const terminal = new FakeTerminal();
  const plan = "- 先读取目标文件\n- 再提出最小补丁";
  const app = createMiniTui(
    ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
    terminal,
  );
  try {
    app.start();
    assert.equal(app.sessionViewState.phase, "ready");
    assert.equal(app.sessionViewState.activity, "等待任务");
    assert.equal(app.sessionViewState.activityExpanded, false);

    terminal.send("\u000f");
    assert.equal(app.sessionViewState.activityExpanded, true);

    const planApproval = app.requestPlanApproval({ plan });
    assert.equal(app.sessionViewState.phase, "plan_pending");
    assert.equal(app.sessionViewState.plan, plan);
    assert.deepEqual(app.sessionViewState.pendingApproval, {
      kind: "plan",
      confirmWord: "CONTINUE",
      cancelWord: "CANCEL",
      prompt: "CONTINUE / CANCEL",
    });
    await waitFor(() => stripAnsi(terminal.output).includes("待确认操作"));
    assert.match(stripAnsi(terminal.output), /工作流.*计划（待确认）/u);

    await app.submit("CONTINUE");
    assert.equal(await planApproval, true);
    assert.equal(app.sessionViewState.phase, "executing");
    assert.equal(app.sessionViewState.plan, plan);
    assert.equal(app.sessionViewState.pendingApproval, undefined);

    const patchApproval = app.requestEditApproval({
      path: "src/example.ts",
      preview: "export const value = 'after';",
    });
    const patchView = app.sessionViewState;
    assert.equal(app.sessionViewState.phase, "patch_pending");
    assert.equal(patchView.pendingApproval?.confirmWord, "APPLY");
    await app.submit("CANCEL");
    assert.equal(await patchApproval, false);
    assert.equal(app.sessionViewState.phase, "stopped");
    assert.equal(app.sessionViewState.plan, plan);
    assert.equal(app.sessionViewState.pendingApproval, undefined);

    const verificationApproval = app.requestCommandApproval({
      kind: "verification",
      action: "test",
      command: "npm test",
      workingDirectory: process.cwd(),
      risk: "只运行固定验证命令。",
      riskLevel: "low",
    });
    const verificationView = app.sessionViewState;
    assert.equal(app.sessionViewState.phase, "verification_pending");
    assert.equal(verificationView.pendingApproval?.confirmWord, "RUN");
    await waitFor(() => stripAnsi(terminal.output).includes("验证（待确认）"));
    await app.submit("RUN");
    assert.equal(await verificationApproval, true);
    assert.equal(app.sessionViewState.phase, "executing");
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("未指定 audit 时会写入用户级目录而不是工作区 reports", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-default-audit-workspace-"));
  const localAppData = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-default-audit-user-"));
  const terminal = new FakeTerminal();
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      return { kind: "final", content: "默认审计路径验证完成。" };
    },
  };
  let app: MiniTuiApp | undefined;

  try {
    process.env.LOCALAPPDATA = localAppData;
    app = createMiniTui(["--workspace", workspace], terminal, { model });
    app.start();
    await app.submit("验证默认审计位置");

    const auditRoot = path.join(localAppData, "MiniCode", "audit");
    const auditFiles = await fs.readdir(auditRoot);
    assert.equal(auditFiles.length, 1);
    assert.match(auditFiles[0] ?? "", /^session-.*\.jsonl$/u);
    const audit = await fs.readFile(path.join(auditRoot, auditFiles[0] ?? ""), "utf8");
    assert.match(audit, /"type":"agent_completed"/u);
    await assert.rejects(fs.access(path.join(workspace, "reports")));
  } finally {
    app?.stop();
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(localAppData, { recursive: true, force: true });
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

test("Ctrl+V 在进入编辑器前转义剪贴板终端控制符", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-safe-clipboard-"));
  const terminal = new FakeTerminal();
  const rawControl = "\u001B[6n";
  let app: MiniTuiApp | undefined;
  try {
    const currentApp = createMiniTui(
      ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
      { readClipboard: async () => `first\tsecond${rawControl}` },
    );
    app = currentApp;
    currentApp.start();
    terminal.send("\u0016");
    await waitFor(() => currentApp.editorText.includes("second"));

    assert.equal(currentApp.editorText, "first    second\\u001B[6n");
    assert.doesNotMatch(terminal.output, /\u001B\[6n/u);
  } finally {
    app?.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("晚返回的剪贴板不会跨任务插入编辑器", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-late-clipboard-"));
  const terminal = new FakeTerminal();
  let clipboardCalls = 0;
  let resolveClipboard: ((value: string) => void) | undefined;
  const clipboard = new Promise<string>((resolve) => {
    resolveClipboard = resolve;
  });
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      return { kind: "final", content: "当前任务已经完成。" };
    },
  };
  const options = parseArguments([
    "--workspace",
    process.cwd(),
    "--audit",
    path.join(reportDirectory, "audit.jsonl"),
  ]);
  const app = new MiniTuiApp(
    options,
    terminal,
    new AgentLoop(model, new ToolRegistry([]), { workspaceRoot: process.cwd() }),
    {
      readClipboard: () => {
        clipboardCalls += 1;
        return clipboard;
      },
    },
  );

  try {
    app.start();
    terminal.send("\u0016");
    await waitFor(() => clipboardCalls === 1);
    await app.submit("在剪贴板返回前先完成这个任务");
    resolveClipboard?.("不应跨任务插入的旧剪贴板");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(app.editorText, "");
    assert.doesNotMatch(stripAnsi(terminal.output), /不应跨任务插入的旧剪贴板/u);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("晚返回的剪贴板不会覆盖等待期间的新键入或更新的粘贴", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-stale-paste-"));
  const terminal = new FakeTerminal();
  const resolvers: Array<(value: string) => void> = [];
  const app = createMiniTui(
    ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
    terminal,
    {
      readClipboard: () => new Promise<string>((resolve) => resolvers.push(resolve)),
    },
  );
  try {
    app.start();
    terminal.send("\u0016");
    await waitFor(() => resolvers.length === 1);
    terminal.send("fresh");
    resolvers[0]("-LATE-");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(app.editorText, "fresh");

    terminal.send("\u0016");
    terminal.send("\u0016");
    await waitFor(() => resolvers.length === 3);
    resolvers[2]("-NEW-");
    await waitFor(() => app.editorText === "fresh-NEW-");
    resolvers[1]("-OLD-");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(app.editorText, "fresh-NEW-");
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("编辑器原生输入也会把双向控制字符转成可见文本", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-safe-native-paste-"));
  const terminal = new FakeTerminal();
  const app = createMiniTui(
    ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
    terminal,
  );
  try {
    app.start();
    terminal.send("safe\u202Eevil");
    await waitFor(() => app.editorText.includes("evil"));
    assert.equal(app.editorText, "safe\\u202Eevil");
    assert.doesNotMatch(terminal.output, /\u202E/u);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("TUI 转义用户、模型、审批和未知工具中的 CSI 与 OSC", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-terminal-safety-"));
  const terminal = new FakeTerminal();
  const csi = "\u001B[6n";
  const osc = "\u001B]9;MINICODE-PWN\u0007";
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      return { kind: "final", content: `模型回答 ${osc}` };
    },
  };
  const options = parseArguments([
    "--workspace",
    process.cwd(),
    "--audit",
    path.join(reportDirectory, "audit.jsonl"),
  ]);
  const app = new MiniTuiApp(
    options,
    terminal,
    new AgentLoop(model, new ToolRegistry([]), { workspaceRoot: process.cwd() }),
  );

  try {
    app.start();
    await app.submit(`用户任务 ${csi}`);

    app.handleAgentEvent({
      type: "model_requested",
      step: 2,
      forcedToolName: `__proto__${csi}`,
    });
    app.handleAgentEvent({
      type: "tool_call",
      step: 2,
      toolCallId: "unsafe-tool",
      toolName: `constructor${osc}`,
    });
    app.handleAgentEvent({
      type: "tool_finalized",
      step: 2,
      toolCallId: "unsafe-tool",
      toolName: `constructor${osc}`,
      status: "error",
      detail: `cancelled${csi}`,
      metadata: { cancelled: true },
    });
    app.handleAgentEvent({
      type: "tool_finalized",
      step: 2,
      toolCallId: "failed-tool",
      toolName: "read_file",
      status: "error",
      detail: "ordinary failure",
    });
    app.handleAgentEvent({ type: "agent_stopped", step: 2, reason: "任务已取消。" });
    await waitFor(() => stripAnsi(terminal.output).includes("1 次失败 · 1 次已取消"));
    terminal.send("\u000f");

    const editApproval = app.requestEditApproval({
      path: `src/${csi}.ts`,
      preview: `safe line\n${osc}`,
    });
    await app.submit("CANCEL");
    assert.equal(await editApproval, false);

    const planApproval = app.requestPlanApproval({ plan: `- 计划\n- ${osc}` });
    await app.submit("CANCEL");
    assert.equal(await planApproval, false);

    const repairApproval = app.requestRepairApproval({
      failedAction: `test${csi}`,
      direction: `修复方向\n${osc}`,
      attempt: 1,
      maximumAttempts: 1,
    });
    await app.submit("CANCEL");
    assert.equal(await repairApproval, false);

    const commandApproval = app.requestCommandApproval({
      kind: "command",
      action: `run_command${csi}`,
      command: `node ${osc}`,
      workingDirectory: `C:\\safe${csi}`,
      riskLevel: "medium",
      risk: `risk ${osc}`,
    });
    await app.submit("CANCEL");
    assert.equal(await commandApproval, false);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.doesNotMatch(terminal.output, /\u001B\[6n/u);
    assert.doesNotMatch(terminal.output, /\u001B\]9;MINICODE-PWN\u0007/u);
    const output = stripAnsi(terminal.output);
    assert.match(output, /\\u001B\[6n/u);
    assert.match(output, /\\u001B\]9;MINICODE-PWN\\u0007/u);
    assert.match(output, /__proto__\\u001B\[6n/u);
    assert.match(output, /constructor\\u001B\]9;MINICODE-PWN\\u0007/u);
    assert.match(output, /任务已取消|已取消/u);
    assert.match(output, /1 次失败 · 1 次已取消/u);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("任务收口卡只渲染结构化元数据，并转义验证与审计文本", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-closeout-safe-"));
  const terminal = new FakeTerminal();
  const csi = "\u001B[6n";
  const osc = "\u001B]9;MINICODE-CLOSEOUT-PWN\u0007";
  const auditFileName = `audit-${osc}.jsonl`;
  let modelCalls = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "运行固定验证。",
          toolCalls: [{ id: "unsafe-closeout-check", name: "run_project_check", input: {} }],
        };
      }
      return { kind: "final", content: "已完成。" };
    },
  };
  const verificationTool: AgentTool<JsonValue, ToolExecutionOutput> = {
    name: "run_project_check",
    description: "测试专用验证工具。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, value: {} }),
    async execute(): Promise<ToolExecutionOutput> {
      return {
        content: `CLOSEOUT_DETAIL_SHOULD_NOT_RENDER${csi}${osc}`,
        metadata: { action: `test${csi}`, exitCode: 0 },
      };
    },
  };
  const options = parseArguments([
    "--workspace",
    process.cwd(),
    "--audit",
    path.join(reportDirectory, auditFileName),
  ]);
  let app: MiniTuiApp | undefined;
  const agent = new AgentLoop(model, new ToolRegistry([verificationTool]), {
    workspaceRoot: process.cwd(),
    onEvent: (event) => app?.handleAgentEvent(event),
  });
  app = new MiniTuiApp(options, terminal, agent);

  try {
    app.start();
    await app.submit("运行安全的收口卡验证");
    await waitFor(() => stripAnsi(terminal.output).includes("本次任务收口"));

    assert.doesNotMatch(terminal.output, /\u001B\[6n/u);
    assert.doesNotMatch(terminal.output, /\u001B\]9;MINICODE-CLOSEOUT-PWN\u0007/u);
    const output = stripAnsi(terminal.output);
    assert.match(output, /验证：test\\u001B\[6n 通过.*退出码 0/u);
    assert.match(output, /审计目标 audit-\\u001B\]9;MINICODE-CLOSEOUT-PWN\\u0007\.jsonl/u);
    assert.doesNotMatch(output, /CLOSEOUT_DETAIL_SHOULD_NOT_RENDER/u);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("Windows 剪贴板只启动绝对系统 PowerShell 并限制环境与输出", async () => {
  const source = await fs.readFile(new URL("../src/mini.ts", import.meta.url), "utf8");

  assert.match(source, /System32[\s\S]*WindowsPowerShell[\s\S]*v1\.0[\s\S]*powershell\.exe/u);
  assert.doesNotMatch(source, /execFileAsync\(\s*["']powershell\.exe["']/u);
  assert.match(source, /WINDOWS_SYSTEM_ROOT = "C:\\\\Windows"/u);
  assert.doesNotMatch(source, /process\.env\.(?:SystemRoot|WINDIR)/u);
  assert.match(source, /timeout:\s*CLIPBOARD_TIMEOUT_MS/u);
  assert.match(source, /maxBuffer:\s*\(MAX_CLIPBOARD_CHARACTERS \+ 1\) \* 4/u);
  assert.match(source, /env:\s*\{ SystemRoot: systemRoot, WINDIR: systemRoot \}/u);
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
    assert.match(stripAnsi(terminal.output), /远程数据提示/);
    assert.match(stripAnsi(terminal.output), /目录\/搜索结果、源码片段、Git/);
    assert.match(stripAnsi(terminal.output), /状态或差异/);
    assert.match(stripAnsi(terminal.output), /编辑参数和获准进程输出/);
    assert.match(stripAnsi(terminal.output), /MINICODE_ALLOW_INSECURE_HTTP=1/);
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
    assert.match(stripAnsi(terminal.output), /当前没有待确认计划或修复方向/);
    assert.match(stripAnsi(terminal.output), /当前没有待确认验证/);
    assert.match(stripAnsi(terminal.output), /当前没有待确认操作/);
  } finally {
    app?.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("修复方向面板只接受精确 CONTINUE，错误输入保持等待且控制词不进入模型", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-repair-continue-"));
  const harness = await createRepairTuiHarness(workspace);
  try {
    harness.app.start();
    const task = harness.app.submit("运行测试，并在真实失败后提出一次有界修复方向");
    await waitFor(() => harness.app.awaitingRepairApproval);
    await waitFor(() => stripAnsi(harness.terminal.output).includes("待确认修复方向"));

    const pendingOutput = stripAnsi(harness.terminal.output);
    assert.equal(harness.runnerCalls, 1);
    assert.equal(harness.modelRequests.length, 2);
    assert.match(pendingOutput, /待确认修复方向.*test/u);
    assert.match(pendingOutput, /修复尝试：1 \/ 1/u);
    assert.match(pendingOutput, new RegExp(REPAIR_DIRECTION, "u"));
    assert.match(pendingOutput, /后续补丁仍需 APPLY，复验仍需 RUN/u);
    assert.match(pendingOutput, /等待确认：CONTINUE \/ CANCEL/u);

    await harness.app.submit("continue");
    assert.equal(harness.app.awaitingRepairApproval, true);
    assert.equal(harness.modelRequests.length, 2);
    await harness.app.submit("请先解释失败原因");
    assert.equal(harness.app.awaitingRepairApproval, true);
    assert.equal(harness.modelRequests.length, 2);
    await waitFor(() => stripAnsi(harness.terminal.output).includes("修复方向仍在等待确认"));

    await harness.app.submit("CONTINUE");
    await task;

    assert.equal(harness.app.awaitingRepairApproval, false);
    assert.equal(harness.modelRequests.length, 3);
    assert.equal(harness.app.contextTurns, 1);
    await waitFor(
      () => stripAnsi(harness.terminal.output).includes("修复尚未完成成功复验"),
      2_000,
    );
    assert.match(stripAnsi(harness.terminal.output), /修复方向已确认，正在进行一次有界修复/u);
    assert.match(stripAnsi(harness.terminal.output), /修复尚未完成成功复验，任务以未完成状态停止/u);
    assert.doesNotMatch(stripAnsi(harness.terminal.output), /已按确认的方向结束本次有界修复演示/u);
    assertNoLocalControlWords(harness.modelRequests);
  } finally {
    harness.app.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("CANCEL 会闭锁后续修复，且不会把取消词发送给模型", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-repair-cancel-"));
  const harness = await createRepairTuiHarness(workspace);
  try {
    harness.app.start();
    const task = harness.app.submit("运行测试，并在失败后等待我决定是否修复");
    await waitFor(() => harness.app.awaitingRepairApproval);

    await harness.app.submit("CANCEL");
    await task;

    assert.equal(harness.app.awaitingRepairApproval, false);
    assert.equal(harness.runnerCalls, 1);
    assert.equal(harness.modelRequests.length, 2);
    assert.equal(harness.app.contextTurns, 1);
    await waitFor(() => stripAnsi(harness.terminal.output).includes("已停止后续修复"));
    const output = stripAnsi(harness.terminal.output);
    assert.match(output, /已停止后续修复，当前工作区保持现状/u);
    assert.match(output, /用户未确认修复方向，未继续修改文件或运行验证/u);
    assert.match(output, /本次任务收口.*未完成/u);
    assert.match(output, /修改：未写入补丁/u);
    const closeout = harness.app.sessionViewState.closeout;
    assert.ok(closeout);
    assert.equal(closeout.outcome, "stopped");
    assert.equal(closeout.appliedPaths.length, 0);
    assert.equal(closeout.verification?.status, "failed");
    assertNoLocalControlWords(harness.modelRequests);
  } finally {
    harness.app.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("stop 会把待确认修复按拒绝收口且不再请求模型", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-repair-stop-"));
  const harness = await createRepairTuiHarness(workspace);
  try {
    harness.app.start();
    const task = harness.app.submit("运行测试，并在失败后等待修复确认");
    await waitFor(() => harness.app.awaitingRepairApproval);

    harness.app.stop();
    await task;

    assert.equal(harness.app.awaitingRepairApproval, false);
    assert.equal(harness.runnerCalls, 1);
    assert.equal(harness.modelRequests.length, 2);
    assert.equal(harness.app.contextTurns, 0);
    assertNoLocalControlWords(harness.modelRequests);
  } finally {
    harness.app.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("运行中 Ctrl+C 会取消忽略 signal 的模型请求且不追加晚回答", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-cancel-model-"));
  const terminal = new FakeTerminal();
  let modelCalls = 0;
  let resolveModel: ((response: ModelResponse) => void) | undefined;
  let exits = 0;
  const model: ChatModel = {
    complete(_request, signal): Promise<ModelResponse> {
      modelCalls += 1;
      assert.ok(signal);
      return new Promise((resolve) => {
        resolveModel = resolve;
      });
    },
  };
  const options = parseArguments([
    "--workspace",
    process.cwd(),
    "--audit",
    path.join(reportDirectory, "audit.jsonl"),
  ]);
  const app = new MiniTuiApp(
    options,
    terminal,
    new AgentLoop(model, new ToolRegistry([]), { workspaceRoot: process.cwd() }),
    { onExit: () => { exits += 1; } },
  );

  try {
    app.start();
    const task = app.submit("等待一个不会自行结束的模型");
    await waitFor(() => modelCalls === 1 && app.running);
    terminal.send("\u0003");
    await task;

    assert.equal(app.running, false);
    assert.equal(app.awaitingApproval, false);
    assert.equal(app.contextTurns, 0);
    assert.equal(exits, 0);
    await waitFor(() => stripAnsi(terminal.output).includes("当前任务已取消"));
    assert.match(stripAnsi(terminal.output), /当前任务已取消/u);

    resolveModel?.({ kind: "final", content: "不应出现的晚回答" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.doesNotMatch(stripAnsi(terminal.output), /不应出现的晚回答/u);
    assert.equal(app.contextTurns, 0);

    terminal.send("\u0003");
    assert.equal(exits, 1);
  } finally {
    app.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});

test("运行中 Ctrl+C 会同时关闭待确认修复", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-cancel-approval-"));
  const harness = await createRepairTuiHarness(workspace);
  try {
    harness.app.start();
    const task = harness.app.submit("运行测试，并在修复确认处等待取消");
    await waitFor(() => harness.app.awaitingRepairApproval);

    harness.terminal.send("\u0003");
    await task;

    assert.equal(harness.app.awaitingRepairApproval, false);
    assert.equal(harness.app.running, false);
    assert.equal(harness.app.contextTurns, 0);
    assert.equal(harness.runnerCalls, 1);
    assert.equal(harness.modelRequests.length, 2);
    await waitFor(() => stripAnsi(harness.terminal.output).includes("正在取消当前任务"));
    assert.match(stripAnsi(harness.terminal.output), /正在取消当前任务/u);
  } finally {
    harness.app.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("验证命令在 TUI 等待精确 RUN，确认前不会启动 runner", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-command-run-"));
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
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
    await waitFor(() => stripAnsi(terminal.output).includes("待确认验证"));

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
    const output = stripAnsi(terminal.output);
    assert.match(output, /验证已确认并完成/);
    assert.match(output, /本次任务收口.*已完成/);
    assert.match(output, /验证：test 通过.*退出码 0/);
    const closeout = app.sessionViewState.closeout;
    assert.ok(closeout);
    assert.equal(closeout.verification?.status, "passed");
    assert.equal(closeout.verification?.attempts, 1);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("TUI 中取消验证不会启动 runner，也不会把 CANCEL 写入模型上下文", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-command-cancel-"));
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { check: "tsc -p tsconfig.json" } }),
    "utf8",
  );
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
    const output = stripAnsi(terminal.output);
    assert.match(output, /已取消验证，固定命令未执行/);
    assert.match(output, /验证已由用户取消/);
    assert.match(output, /本次任务收口.*已完成/);
    assert.match(output, /验证：check 未执行（已取消）/);
    const closeout = app.sessionViewState.closeout;
    assert.ok(closeout);
    assert.equal(closeout.verification?.status, "not_run");
    assert.equal(closeout.verification?.cancelled, true);
    assert.equal(closeout.appliedPaths.length, 0);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("通用受控命令在 TUI 展示风险并只接受精确 RUN", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-run-command-"));
  await fs.writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { check: "tsc -p tsconfig.json" } }),
    "utf8",
  );
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

test("只读 Git 检查在 TUI 中直接执行，不进入 RUN 确认状态", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-git-"));
  await fs.mkdir(path.join(workspace, ".git"));
  const terminal = new FakeTerminal();
  let modelCalls = 0;
  let mainCalls = 0;
  let approvalCalls = 0;
  const runner: GitRunner = {
    async run(request) {
      const result = (output: string, exitCode: number | null = 0) => ({
        exitCode,
        durationMs: 3,
        output,
        outputLength: output.length,
        outputTruncated: false,
        timedOut: false,
      });
      if (request.args.length === 1 && request.args[0] === "--version") return result("git version 2.55.0\n");
      if (request.args.includes("rev-parse")) return result(`${workspace}\n`);
      if (request.args.includes("config")) return result("", 1);
      mainCalls += 1;
      return result("## main\n M src/example.ts\n");
    },
  };
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "读取固定 Git 状态。",
          toolCalls: [{ id: "git-status-1", name: "inspect_git", input: { action: "status" } }],
        };
      }
      const lastMessage = request.messages.at(-1);
      assert.equal(lastMessage?.role, "tool");
      assert.equal(lastMessage?.role === "tool" ? lastMessage.status : undefined, "success");
      return { kind: "final", content: "Git 状态已读取；没有执行暂存或提交。" };
    },
  };
  const options = parseArguments(["--workspace", workspace, "--audit", path.join(workspace, "audit.jsonl")]);
  const agent = new AgentLoop(model, new ToolRegistry([createInspectGitTool(runner)]), {
    workspaceRoot: workspace,
    requestCommandApproval: async () => {
      approvalCalls += 1;
      return true;
    },
  });
  const app = new MiniTuiApp(options, terminal, agent);
  try {
    app.start();
    await app.submit("查看 Git 状态");
    await waitFor(() => stripAnsi(terminal.output).includes("Git 状态已读取"));
    assert.equal(mainCalls, 1);
    assert.equal(approvalCalls, 0);
    assert.equal(app.awaitingCommandApproval, false);
    const output = stripAnsi(terminal.output);
    assert.match(output, /Git 状态已读取；没有执行暂存或提交/);
    assert.match(output, /本次任务收口.*已完成/);
    assert.match(output, /修改：未写入补丁/);
    assert.match(output, /验证：未请求固定验证/);
    assert.match(output, /Git 收口：状态已读取（只读；未暂存或提交）/);
    assert.match(output, /审计目标 audit\.jsonl/);
    assert.deepEqual(app.sessionViewState.closeout?.gitInspections, [{ action: "status", status: "completed" }]);
    assert.doesNotMatch(output, /待确认命令|等待确认：RUN \/ CANCEL/);
  } finally {
    app.stop();
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

test("TUI pauses its loading animation while an approval waits, then resumes after a decision", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-loader-"));
  const terminal = new FakeTerminal();
  let resumeExecution: (() => void) | undefined;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.phase === "planning") {
        return { kind: "final", content: "先等待计划确认，再给出结论。" };
      }
      return new Promise<ModelResponse>((resolve) => {
        resumeExecution = () => resolve({ kind: "final", content: "确认后的任务已完成。" });
      });
    },
  };
  let app: MiniTuiApp | undefined;
  try {
    app = createMiniTui(
      ["--guided", "--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
      { model },
    );
    app.start();

    const task = app.submit("等待我确认计划");
    await waitFor(() => app?.awaitingPlanApproval === true);
    assert.equal(app.loading, false, "等待用户决定时不应继续显示任务执行动画");

    await app.submit("CONTINUE");
    await waitFor(() => resumeExecution !== undefined);
    assert.equal(app.loading, true, "用户作出决定后，任务继续执行时应恢复动画");

    resumeExecution?.();
    await task;
    assert.equal(app.loading, false, "任务收口后必须停止动画");
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
    const output = stripAnsi(terminal.output);
    assert.match(output, /本次任务收口.*已完成/);
    assert.match(output, /修改：本任务已写入 1 个文件：src\/example\.ts/);
    assert.deepEqual(app.sessionViewState.closeout?.appliedPaths, ["src/example.ts"]);
  } finally {
    app?.stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
