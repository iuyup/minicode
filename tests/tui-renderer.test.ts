import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Text, type Terminal } from "@mariozechner/pi-tui";

import { PiTuiRenderer } from "../src/tui/pi-renderer.ts";
import type { SessionViewState, TuiPlugin } from "../src/tui/contracts.ts";
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

test("内建 TUI 插件按稳定键和固定槽位挂载，工作流随安全快照刷新", async () => {
  const terminal = new FakeTerminal();
  let state = initialState();
  const renderer = new PiTuiRenderer({
    options: parseArguments(["--workspace", process.cwd(), "--audit", path.join(process.cwd(), "audit.jsonl")]),
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
      "core.composer-hint",
      "core.composer",
      "core.footer",
    ];
    assert.deepEqual(renderer.mountedNodeKeys, expectedKeys);
    assert.equal(new Set(renderer.mountedNodeKeys).size, expectedKeys.length);
    await waitFor(() => stripAnsi(terminal.output).includes("工作流"));
    assert.match(stripAnsi(terminal.output), /工作流/u);

    state = {
      ...state,
      phase: "plan_pending",
      activity: "等待计划确认",
      pendingApproval: { kind: "plan", confirmWord: "CONTINUE", cancelWord: "CANCEL", prompt: "CONTINUE / CANCEL" },
    };
    renderer.requestRender();

    assert.deepEqual(renderer.mountedNodeKeys, expectedKeys);
    await waitFor(() => stripAnsi(terminal.output).includes("计划（待确认）"));
    assert.match(stripAnsi(terminal.output), /计划（待确认）/u);
  } finally {
    renderer.stop();
  }
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
