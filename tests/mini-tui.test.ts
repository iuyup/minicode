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

test("mini TUI never sends APPLY to the model when no patch is awaiting confirmation", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-mini-apply-guard-"));
  const terminal = new FakeTerminal();
  let app: MiniTuiApp | undefined;
  try {
    app = createMiniTui(
      ["--workspace", process.cwd(), "--audit", path.join(reportDirectory, "audit.jsonl")],
      terminal,
    );
    app.start();

    await app.submit("APPLY");

    assert.equal(app.contextTurns, 0);
    await waitFor(() => stripAnsi(terminal.output).includes("当前没有待确认补丁"));
    assert.match(stripAnsi(terminal.output), /当前没有待确认补丁/);
  } finally {
    app?.stop();
    await fs.rm(reportDirectory, { recursive: true, force: true });
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
