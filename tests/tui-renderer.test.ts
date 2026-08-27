import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Text, type Terminal, visibleWidth } from "@mariozechner/pi-tui";

import { PiTuiRenderer, renderCloseoutSummary, renderFooterStatus } from "../src/tui/pi-renderer.ts";
import type { SessionViewState, TaskCloseoutView, TuiPlugin } from "../src/tui/contracts.ts";
import { parseArguments } from "../src/runtime.ts";

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
    if (Date.now() >= deadline) throw new Error("等待 TUI 渲染超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function initialState(): SessionViewState {
  return {
    phase: "ready",
    activity: "等待任务",
    contextTurns: 0,
    activityExpanded: false,
  };
}

const SHORT_WORKSPACE_PATH = process.platform === "win32" ? "C:\\minicode" : "/minicode";

test("内建 TUI 插件按稳定键和固定槽位挂载，空闲时保持紧凑", async () => {
  const terminal = new FakeTerminal();
  let state = initialState();
  const renderer = new PiTuiRenderer({
    options: parseArguments([
      "--workspace",
      SHORT_WORKSPACE_PATH,
      "--audit",
      path.join(SHORT_WORKSPACE_PATH, "audit.jsonl"),
    ]),
    terminal,
    viewState: () => state,
    callbacks: {
      onAction: () => assert.fail("纯展示刷新不应发出输入动作"),
      normalizeInput: (text) => text,
    },
  });

  try {
    renderer.start();
    const expectedKeys = [
      "core.header",
      "core.spacer",
      "core.workflow",
      "core.session",
      "core.transcript",
      "core.activity",
      "core.closeout",
      "core.approval",
      "core.composer",
      "core.footer",
    ];
    assert.deepEqual(renderer.mountedNodeKeys, expectedKeys);
    assert.equal(new Set(renderer.mountedNodeKeys).size, expectedKeys.length);
    await waitFor(() => stripAnsi(terminal.output).includes("MiniCode"));
    assert.match(terminal.output, /\u001B\[38;2;109;40;217m/u);
    assert.match(stripAnsi(terminal.output), /MiniCode/u);
    assert.doesNotMatch(stripAnsi(terminal.output), /受控 Coding Agent|工作流|当前活动|工具活动已折叠/u);
    assert.doesNotMatch(stripAnsi(terminal.output), /输入一个代码任务，Enter 发送，Shift\+Enter 换行。/u);
    assert.doesNotMatch(stripAnsi(terminal.output), /\/help · Ctrl\+V 粘贴 · Ctrl\+C 退出 · 上下文/u);
    assert.ok(stripAnsi(terminal.output).includes(SHORT_WORKSPACE_PATH));
    assert.match(stripAnsi(terminal.output), /FakeModel（离线）/u);

    state = {
      ...state,
      phase: "plan_pending",
      activity: "等待计划确认",
      pendingApproval: { kind: "plan", confirmWord: "CONTINUE", cancelWord: "CANCEL", prompt: "CONTINUE / CANCEL" },
    };
    renderer.requestRender();

    assert.deepEqual(renderer.mountedNodeKeys, expectedKeys);
    await waitFor(() => stripAnsi(terminal.output).includes("计划待确认"));
    assert.match(stripAnsi(terminal.output), /计划待确认.*CONTINUE.*CANCEL/u);
  } finally {
    renderer.stop();
  }
});

test("底栏只显示实际远程模型名，窄窗口优先保留模型", async () => {
  const workspacePath = SHORT_WORKSPACE_PATH;
  const terminal = new FakeTerminal();
  terminal.columns = 80;
  const renderer = new PiTuiRenderer({
    options: parseArguments([
      "--workspace",
      workspacePath,
      "--audit",
      path.join(workspacePath, "audit.jsonl"),
      "--model",
      "deepseek",
      "--deepseek-model",
      "deepseek-v4-flash",
    ]),
    terminal,
    viewState: initialState,
    callbacks: {
      onAction: () => assert.fail("纯展示刷新不应发出输入动作"),
      normalizeInput: (text) => text,
    },
  });

  try {
    renderer.start();
    await waitFor(() => stripAnsi(terminal.output).includes("deepseek-v4-flash"));
    const output = stripAnsi(terminal.output);
    assert.match(output, /✦ MiniCode.*DeepSeek \/ deepseek-v4-flash/u);

    const footer = stripAnsi(renderFooterStatus(workspacePath, "deepseek-v4-flash", 80));
    assert.ok(footer.includes(workspacePath));
    assert.ok(footer.endsWith("deepseek-v4-flash"));
    assert.doesNotMatch(footer, /DeepSeek\s*\//u);
    assert.equal(visibleWidth(footer), 80);

    const narrowFooter = stripAnsi(renderFooterStatus(
      "C:\\very-long-workspace-path\\with\\many\\segments",
      "deepseek-v4-flash",
      24,
    ));
    assert.ok(narrowFooter.endsWith("deepseek-v4-flash"));
    assert.doesNotMatch(narrowFooter, /DeepSeek\s*\//u);
    assert.ok(visibleWidth(narrowFooter) <= 24);
  } finally {
    renderer.stop();
  }
});

test("流式回答复用可变草稿，终态定稿或撤回都不遗留终端控制序列", async () => {
  const terminal = new FakeTerminal();
  const renderer = new PiTuiRenderer({
    options: parseArguments(["--workspace", process.cwd(), "--audit", path.join(process.cwd(), "audit.jsonl")]),
    terminal,
    viewState: initialState,
    callbacks: {
      onAction: () => assert.fail("展示草稿不应发出输入动作"),
      normalizeInput: (text) => text,
    },
  });

  try {
    renderer.start();
    renderer.appendUser("展示流式回答");
    renderer.appendStreamingAnswerDelta("第一段");
    renderer.appendStreamingAnswerDelta("\u001B");
    renderer.appendStreamingAnswerDelta("[6n 第二段");
    await waitFor(() => stripAnsi(terminal.output).includes("第一段"));
    assert.equal(renderer.hasStreamingAnswer, true);
    assert.doesNotMatch(terminal.output, /\u001B\[6n/u);
    assert.match(stripAnsi(terminal.output), /\\u001B\[6n/u);

    renderer.finalizeStreamingAnswer("最终回答");
    await waitFor(() => stripAnsi(terminal.output).includes("最终回答"));
    assert.equal(renderer.hasStreamingAnswer, false);

    renderer.appendStreamingAnswerDelta("待撤回的半截回答");
    assert.equal(renderer.hasStreamingAnswer, true);
    renderer.discardStreamingAnswer();
    assert.equal(renderer.hasStreamingAnswer, false);
  } finally {
    renderer.stop();
  }
});

test("收口摘要保持低强调、留白，并在窄终端保留完整事实", () => {
  const closeout: TaskCloseoutView = {
    outcome: "completed",
    eventCount: 34,
    successfulTools: 6,
    failedTools: 5,
    cancelledTools: 0,
    appliedPaths: [],
    proposedPatchCount: 0,
    rejectedPatchCount: 0,
    gitInspections: [],
    auditFileName: "audit.jsonl",
  };

  const wide = renderCloseoutSummary(closeout, 100);
  assert.deepEqual(wide.map(stripAnsi), [
    " ✓ 已结束 · 工具 6 成功 / 5 失败 · 未写入 · 未运行验证",
    "",
  ]);
  assert.match(wide[0] ?? "", /\u001B\[90m/u);
  assert.doesNotMatch(wide[0] ?? "", /\u001B\[1m/u);
  assert.doesNotMatch(stripAnsi(wide.join("\n")), /Git|审计|事件/u);

  const narrow = renderCloseoutSummary(closeout, 31).map(stripAnsi);
  assert.deepEqual(narrow, [
    " ✓ 已结束",
    "   工具 6 成功 / 5 失败",
    "   未写入 · 未运行验证",
    "",
  ]);
  for (const line of narrow) assert.ok(visibleWidth(line) <= 31);
});

test("组件插件只读取冻结展示模型，更新不会重复创建稳定键组件", () => {
  const terminal = new FakeTerminal();
  let state = initialState();
  let nodeCalls = 0;
  let createCalls = 0;
  let inputActions = 0;
  let latestCloseout: SessionViewState["closeout"];
  const plugin: TuiPlugin = {
    id: "test.probe",
    nodes: (context) => {
      nodeCalls += 1;
      const view = context.readModel();
      assert.equal(Object.isFrozen(view), true);
      assert.equal(Object.isFrozen(view.session), true);
      assert.equal(Object.isFrozen(view.activity.items), true);
      assert.equal("events" in view, false);
      latestCloseout = view.session.closeout;
      return [{
        key: "test.probe",
        slot: "header",
        revision: String(view.revision),
        create: () => {
          createCalls += 1;
          return new Text("probe", 0, 1);
        },
      }];
    },
  };
  const renderer = new PiTuiRenderer({
    options: parseArguments(["--workspace", process.cwd(), "--audit", path.join(process.cwd(), "audit.jsonl")]),
    terminal,
    viewState: () => state,
    callbacks: {
      onAction: () => { inputActions += 1; },
      normalizeInput: (text) => text,
    },
    plugins: [plugin],
  });

  try {
    renderer.start();
    renderer.setActivityEvents([{
      type: "tool_finalized",
      step: 1,
      toolCallId: "secret-detail",
      toolName: "read_file",
      status: "success",
      detail: "SECRET_TOOL_DETAIL",
    }]);
    state = {
      ...state,
      phase: "stopped",
      activity: "正在执行\u001B[6n",
      closeout: {
        outcome: "stopped",
        eventCount: 1,
        successfulTools: 1,
        failedTools: 0,
        cancelledTools: 0,
        appliedPaths: ["src/\u001B[6n.ts"],
        proposedPatchCount: 0,
        rejectedPatchCount: 0,
        gitInspections: [],
        auditFileName: "audit-\u001B]9;PLUGIN-PWN\u0007.jsonl",
      },
    };
    renderer.requestRender();

    assert.equal(createCalls, 1);
    assert.ok(nodeCalls >= 2);
    assert.equal(inputActions, 0);
    assert.equal(Object.isFrozen(latestCloseout), true);
    assert.equal(Object.isFrozen(latestCloseout?.appliedPaths), true);
    assert.doesNotMatch(latestCloseout?.auditFileName ?? "", /\u001B/u);
    assert.match(latestCloseout?.auditFileName ?? "", /\\u001B/u);
    assert.doesNotMatch(stripAnsi(terminal.output), /SECRET_TOOL_DETAIL/u);
    assert.ok(renderer.mountedNodeKeys.includes("test.probe"));
    assert.ok(renderer.mountedNodeKeys.includes("core.approval"));
    assert.ok(renderer.mountedNodeKeys.includes("core.composer"));
    assert.equal(new Set(renderer.mountedNodeKeys).size, renderer.mountedNodeKeys.length);
  } finally {
    renderer.stop();
  }
});

test("失效的展示插件降级为本地提示，不会发出控制动作", async () => {
  const terminal = new FakeTerminal();
  let actionCount = 0;
  const renderer = new PiTuiRenderer({
    options: parseArguments(["--workspace", process.cwd(), "--audit", path.join(process.cwd(), "audit.jsonl")]),
    terminal,
    viewState: initialState,
    callbacks: {
      onAction: () => { actionCount += 1; },
      normalizeInput: (text) => text,
    },
    plugins: [
      {
        id: "test.node-error",
        nodes: () => {
          throw new Error("plugin must not control the agent");
        },
      },
      {
        id: "test.render-error",
        nodes: (context) => [{
          key: "test.render-error",
          slot: "header",
          revision: String(context.readModel().revision),
          create: () => ({
            invalidate(): void {},
            render(): string[] {
              throw new Error("plugin render must not control the agent");
            },
          }),
        }],
      },
    ],
  });

  try {
    renderer.start();
    await waitFor(() => stripAnsi(terminal.output).includes("一个 TUI 组件未能显示"));
    assert.match(stripAnsi(terminal.output), /一个 TUI 组件未能显示/u);
    assert.equal(actionCount, 0);
  } finally {
    renderer.stop();
  }
});
