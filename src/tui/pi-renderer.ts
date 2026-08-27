import path from "node:path";

import {
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  Text,
  TUI,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type Terminal,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";

import type {
  CommandApprovalRequest,
  EditApprovalRequest,
  PlanApprovalRequest,
  RepairApprovalRequest,
} from "../agent/contracts.ts";
import type { AgentEvent } from "../agent/events.ts";
import { modelLabel, toolPermissionLabel, type CliArguments } from "../runtime.ts";
import { escapeMultilineTerminalText, escapeTerminalText } from "../terminal-safety.ts";
import type {
  ApprovalKind,
  SessionPhase,
  SessionViewState,
  TaskCloseoutExecutionStatus,
  TaskCloseoutGitAction,
  TaskCloseoutOutcome,
  TuiAction,
  TuiNode,
  TuiPlugin,
  TuiPluginContext,
  TuiReadModel,
  TuiSlot,
} from "./contracts.ts";
import { MAX_CONTEXT_TURNS } from "./contracts.ts";
import { createTuiReadModel } from "./read-model.ts";

const RESET = "\u001B[0m";

function color(code: number): (text: string) => string {
  return (text) => `\u001B[${code}m${text}${RESET}`;
}

const accent = color(36);
const green = color(32);
const yellow = color(33);
const red = color(31);
const muted = color(90);
const bold = (text: string): string => `\u001B[1m${text}${RESET}`;
const underline = (text: string): string => `\u001B[4m${text}${RESET}`;

const SELECT_LIST_THEME: EditorTheme["selectList"] = {
  selectedPrefix: accent,
  selectedText: accent,
  description: muted,
  scrollInfo: muted,
  noMatch: muted,
};

const EDITOR_THEME: EditorTheme = {
  borderColor: accent,
  selectList: SELECT_LIST_THEME,
};

const MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => bold(accent(text)),
  link: (text) => underline(accent(text)),
  linkUrl: muted,
  code: yellow,
  codeBlock: (text) => color(37)(text),
  codeBlockBorder: muted,
  quote: muted,
  quoteBorder: accent,
  hr: muted,
  listBullet: accent,
  bold,
  italic: (text) => `\u001B[3m${text}${RESET}`,
  strikethrough: (text) => `\u001B[9m${text}${RESET}`,
  underline,
};

/** pi-tui 全量重绘会附带 CSI 3J；这里只保留视口重绘，避免意外删除宿主终端历史。 */
export class ScrollbackPreservingTerminal implements Terminal {
  readonly #terminal: Terminal;

  constructor(terminal: Terminal) {
    this.#terminal = terminal;
  }

  get columns(): number { return this.#terminal.columns; }
  get rows(): number { return this.#terminal.rows; }
  get kittyProtocolActive(): boolean { return this.#terminal.kittyProtocolActive; }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.#terminal.start(onInput, onResize);
  }
  stop(): void { this.#terminal.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.#terminal.drainInput(maxMs, idleMs);
  }
  write(data: string): void { this.#terminal.write(data.replace(/\u001B\[3J/gu, "")); }
  moveBy(lines: number): void { this.#terminal.moveBy(lines); }
  hideCursor(): void { this.#terminal.hideCursor(); }
  showCursor(): void { this.#terminal.showCursor(); }
  clearLine(): void { this.#terminal.clearLine(); }
  clearFromCursor(): void { this.#terminal.clearFromCursor(); }
  clearScreen(): void { this.#terminal.clearScreen(); }
  setTitle(title: string): void { this.#terminal.setTitle(title); }
  setProgress(active: boolean): void { this.#terminal.setProgress(active); }
}

function renderLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(width, 1));
}

const SESSION_PHASE_LABELS: Record<SessionPhase, string> = {
  ready: "等待任务",
  planning: "整理计划",
  plan_pending: "等待计划确认",
  executing: "执行中",
  patch_pending: "等待补丁确认",
  verification_pending: "等待验证确认",
  command_pending: "等待命令确认",
  repair_pending: "等待修复确认",
  completed: "已完成",
  stopped: "已停止",
};

const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  plan: "计划",
  repair: "修复方向",
  patch: "补丁",
  verification: "验证",
  command: "命令",
};

function sessionPhaseBadge(phase: SessionPhase): string {
  const label = SESSION_PHASE_LABELS[phase];
  if (phase === "completed") return green(label);
  if (phase === "stopped" || phase.endsWith("_pending")) return yellow(label);
  if (phase === "planning" || phase === "executing") return accent(label);
  return muted(label);
}

function summarizeSessionPlan(plan: string): string {
  const compact = escapeTerminalText(plan).replace(/\s+/gu, " ").trim();
  if (compact.length <= 96) return compact;
  return `${compact.slice(0, 93)}...`;
}

function closeoutOutcomeLabel(outcome: TaskCloseoutOutcome): string {
  switch (outcome) {
    case "completed":
      return green("已完成");
    case "cancelled":
      return yellow("已取消");
    case "stopped":
      return yellow("未完成");
    case "failed":
      return red("失败");
  }
}

function closeoutExecutionLabel(status: TaskCloseoutExecutionStatus): string {
  switch (status) {
    case "completed":
      return "已读取";
    case "cancelled":
      return "已取消";
    case "failed":
      return "失败";
  }
}

function closeoutGitActionLabel(action: TaskCloseoutGitAction): string {
  switch (action) {
    case "status":
      return "状态";
    case "diff":
      return "差异";
    case "staged_diff":
      return "暂存差异";
  }
}

function renderCloseoutModification(closeout: NonNullable<SessionViewState["closeout"]>): string {
  if (closeout.appliedPaths.length > 0) {
    const paths = closeout.appliedPaths.slice(0, 2).map(escapeTerminalText).join("、");
    const remainder = closeout.appliedPaths.length > 2 ? ` 等 ${closeout.appliedPaths.length - 2} 个文件` : "";
    return `修改：本任务已写入 ${closeout.appliedPaths.length} 个文件：${paths}${remainder}`;
  }
  if (closeout.proposedPatchCount > 0) {
    return `修改：仅生成 ${closeout.proposedPatchCount} 个补丁预览，未写入`;
  }
  if (closeout.rejectedPatchCount > 0) return "修改：补丁未写入（未获确认）";
  return "修改：未写入补丁";
}

function renderCloseoutVerification(closeout: NonNullable<SessionViewState["closeout"]>): string {
  const verification = closeout.verification;
  if (!verification) return "验证：未请求固定验证";
  const action = escapeTerminalText(verification.action);
  const attempts = verification.attempts > 1 ? ` · 共 ${verification.attempts} 次` : "";
  const exitCode = verification.exitCode !== undefined ? ` · 退出码 ${verification.exitCode ?? "未知"}` : "";
  if (verification.status === "passed") return `验证：${action} 通过${exitCode}${attempts}`;
  if (verification.status === "not_run") {
    return `验证：${action} 未执行${verification.cancelled ? "（已取消）" : ""}${attempts}`;
  }
  if (verification.status === "cancelled") return `验证：${action} 已取消${attempts}`;
  return `验证：${action} 未通过${verification.timedOut ? "（超时）" : exitCode}${attempts}`;
}

function renderCloseoutGit(closeout: NonNullable<SessionViewState["closeout"]>): string {
  if (closeout.gitInspections.length === 0) return "Git 收口：未读取（不代表工作区干净）";
  const inspections = closeout.gitInspections
    .map((inspection) => `${closeoutGitActionLabel(inspection.action)}${closeoutExecutionLabel(inspection.status)}`)
    .join(" · ");
  return `Git 收口：${inspections}（只读；未暂存或提交）`;
}

class Header implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.#readModel();
    return [
      renderLine(`${bold(accent("◆ MiniCode"))}  ${muted("受控 Coding Agent")}  ${muted("·")} ${sessionPhaseBadge(view.session.phase)}`, width),
      renderLine(`  ${escapeTerminalText(view.chrome.modelLabel)}  ${muted("·")} ${escapeTerminalText(view.chrome.permissionLabel)}`, width),
      renderLine(`  ${muted("工作区")} ${escapeTerminalText(view.chrome.workspaceName)}  ${muted("·  滚轮浏览历史  ·  Ctrl+O 展开工具细节")}`, width),
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
    ];
  }
}

class WorkflowPresenter implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { phase, closeout } = this.#readModel().session;
    const current = phase === "planning" || phase === "plan_pending"
      ? "plan"
      : phase === "verification_pending"
        ? "verification"
        : closeout !== undefined || phase === "completed" || phase === "stopped"
          ? "closeout"
          : phase === "ready"
            ? "none"
            : "execution";
    const marker = (id: "plan" | "execution" | "verification" | "closeout", label: string): string => {
      if (current !== id) return muted(`○ ${label}`);
      if (id === "closeout" && closeout) return closeoutOutcomeLabel(closeout.outcome).replace(/已完成|已取消|未完成|失败/u, `● ${label}`);
      if (phase.endsWith("_pending")) return yellow(`● ${label}（待确认）`);
      return accent(`● ${label}`);
    };
    return [
      renderLine(
        ` ${bold(accent("工作流"))}  ${marker("plan", "计划")} ${muted("→")} ${marker("execution", "执行")} ${muted("→")} ${marker("verification", "验证")} ${muted("→")} ${marker("closeout", "收口")}`,
        width,
      ),
    ];
  }
}

class SessionPresenter implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.#readModel().session;
    const lines = [
      renderLine(
        ` ${bold(accent("会话"))}  ${muted("当前活动")} ${escapeTerminalText(view.activity)}`,
        width,
      ),
    ];
    if (view.plan !== undefined) {
      lines.push(renderLine(`  ${muted("计划")} ${summarizeSessionPlan(view.plan)}`, width));
    } else if (view.phase === "planning") {
      lines.push(renderLine(`  ${muted("计划")} 正在准备可确认的最小步骤`, width));
    }
    return lines;
  }
}

class ApprovalPresenter implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const approval = this.#readModel().session.pendingApproval;
    if (!approval) return [];
    return [
      renderLine(
        ` ${bold(yellow("待确认操作"))}  ${muted(APPROVAL_KIND_LABELS[approval.kind])}`,
        width,
      ),
      renderLine(
        `  ${yellow(approval.confirmWord)} ${muted("确认")}  ${muted("·")} ${yellow(approval.cancelWord)} ${muted("取消；控制词仅本地处理")}`,
        width,
      ),
    ];
  }
}

class TaskCloseoutPresenter implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const closeout = this.#readModel().session.closeout;
    if (!closeout) return [];
    const toolSummary = [
      `${closeout.successfulTools} 成功`,
      ...(closeout.failedTools > 0 ? [`${closeout.failedTools} 失败`] : []),
      ...(closeout.cancelledTools > 0 ? [`${closeout.cancelledTools} 已取消`] : []),
    ].join(" · ");
    return [
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
      renderLine(` ${bold(accent("本次任务收口"))}  ${closeoutOutcomeLabel(closeout.outcome)}`, width),
      renderLine(`  工具：${toolSummary}`, width),
      renderLine(`  ${renderCloseoutModification(closeout)}`, width),
      renderLine(`  ${renderCloseoutVerification(closeout)}`, width),
      renderLine(`  ${renderCloseoutGit(closeout)}`, width),
      renderLine(
        `  ${muted("审计目标")} ${escapeTerminalText(closeout.auditFileName)} ${muted(`· ${closeout.eventCount} 个生命周期事件`)}`,
        width,
      ),
    ];
  }
}

class ToolTimeline implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.#readModel();
    const activity = view.activity;
    if (activity.items.length === 0) return [];

    if (!view.session.activityExpanded) {
      const unsuccessfulParts = [
        ...(activity.failedCount > 0 ? [`${activity.failedCount} 次失败`] : []),
        ...(activity.cancelledCount > 0 ? [`${activity.cancelledCount} 次已取消`] : []),
      ];
      const issueSummary = unsuccessfulParts.join(" · ");
      const outcome = activity.outcome === "stopped"
        ? yellow(`任务已停止${issueSummary ? `（${issueSummary}）` : ""}`)
        : activity.outcome === "cancelled"
          ? yellow(`任务已取消${issueSummary ? `（${issueSummary}）` : ""}`)
          : activity.outcome === "completed"
            ? green(issueSummary ? `已完成（${issueSummary}）` : "成功完成")
            : issueSummary
              ? (activity.failedCount > 0 ? red(issueSummary) : yellow(issueSummary))
              : muted("进行中");
      return [renderLine(`  ${muted("工具活动已折叠")} · ${activity.finalizedCount} 次处理 · ${outcome}`, width)];
    }

    return [
      renderLine(`  ${bold(accent("工具活动"))} ${muted("Ctrl+O 折叠")}`, width),
      ...activity.items.map((item) => renderLine(`  ${muted("·")} ${item.label}`, width)),
    ];
  }
}

class Footer implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.#readModel().session;
    const activity = view.pendingApproval
      ? yellow(`等待确认：${view.pendingApproval.prompt}`)
      : view.phase === "planning" || view.phase === "executing"
        ? yellow("执行中")
        : view.phase === "stopped"
          ? yellow("已停止")
          : green("可输入");
    return [
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
      renderLine(
        ` ${activity}  ${muted(`上下文 ${view.contextTurns} / ${MAX_CONTEXT_TURNS}`)}  ${muted("滚轮历史 · Ctrl+V 粘贴 · /help · /clear · /details · /exit")}`,
        width,
      ),
    ];
  }
}

const SLOT_ORDER: readonly TuiSlot[] = [
  "header",
  "spacer",
  "workflow",
  "session",
  "transcript",
  "activity",
  "closeout",
  "approval",
  "composer",
  "footer",
];

const SLOT_INDEX = new Map(SLOT_ORDER.map((slot, index) => [slot, index]));

interface MountedNode {
  readonly component: Component;
  revision: string;
}

/** 外加展示节点的渲染故障只能降级为本地文案，不能影响控制器或 AgentLoop。 */
class SafePluginComponent implements Component {
  readonly #component: Component;

  constructor(component: Component) {
    this.#component = component;
  }

  invalidate(): void {
    try {
      this.#component.invalidate();
    } catch {
      // 外加展示插件的失效通知不能改变任务执行。
    }
  }

  render(width: number): string[] {
    try {
      return this.#component.render(width);
    } catch {
      return [renderLine(muted("  一个 TUI 组件未能显示。"), width)];
    }
  }
}

/** 稳定键组件编排器：只挂载一次，之后仅令既有组件失效重绘。 */
class KeyedTuiComposer {
  readonly #tui: TUI;
  readonly #plugins: readonly TuiPlugin[];
  readonly #mounted = new Map<string, MountedNode>();
  #mountedOrder: readonly string[] = [];

  constructor(tui: TUI, plugins: readonly TuiPlugin[]) {
    this.#tui = tui;
    this.#plugins = plugins;
    const pluginIds = new Set<string>();
    for (const plugin of plugins) {
      if (pluginIds.has(plugin.id)) throw new Error(`重复的 TUI 插件标识：${plugin.id}`);
      pluginIds.add(plugin.id);
    }
  }

  get nodeKeys(): readonly string[] {
    return this.#mountedOrder;
  }

  mount(context: TuiPluginContext): void {
    const nodes = this.collectNodes(context);
    this.#mountedOrder = nodes.map((node) => node.key);
    for (const node of nodes) {
      const component = this.createComponent(node);
      this.#mounted.set(node.key, { component, revision: node.revision });
      this.#tui.addChild(component);
    }
  }

  refresh(context: TuiPluginContext): void {
    if (this.#mounted.size === 0) return;
    const nodes = this.collectNodes(context);
    const expected = this.#mountedOrder;
    if (nodes.length !== expected.length || nodes.some((node, index) => node.key !== expected[index])) {
      // 插件结构只能在启动时确定；状态变化时不允许把内容插入审批或输入区域。
      for (const mounted of this.#mounted.values()) mounted.component.invalidate();
      return;
    }
    for (const node of nodes) {
      const mounted = this.#mounted.get(node.key);
      if (!mounted || mounted.revision === node.revision) continue;
      mounted.revision = node.revision;
      mounted.component.invalidate();
    }
  }

  private collectNodes(context: TuiPluginContext): readonly TuiNode[] {
    const nodes: TuiNode[] = [];
    const keys = new Set<string>();
    for (const plugin of this.#plugins) {
      let pluginNodes: readonly TuiNode[];
      try {
        pluginNodes = plugin.nodes(context);
      } catch {
        pluginNodes = [this.failureNode(plugin.id, context.readModel().revision)];
      }
      for (const node of pluginNodes) {
        if (keys.has(node.key) || !SLOT_INDEX.has(node.slot)) {
          nodes.push(this.failureNode(`invalid-${nodes.length}`, context.readModel().revision));
          continue;
        }
        keys.add(node.key);
        nodes.push(node);
      }
    }
    return nodes
      .map((node, index) => ({ node, index }))
      .sort((left, right) => {
        const slotDifference = (SLOT_INDEX.get(left.node.slot) ?? Number.MAX_SAFE_INTEGER) -
          (SLOT_INDEX.get(right.node.slot) ?? Number.MAX_SAFE_INTEGER);
        return slotDifference === 0 ? left.index - right.index : slotDifference;
      })
      .map(({ node }) => node);
  }

  private createComponent(node: TuiNode): Component {
    try {
      const component = node.create();
      return node.key.startsWith("core.") ? component : new SafePluginComponent(component);
    } catch {
      return new Text(muted("  一个 TUI 组件未能显示。"), 0, 1);
    }
  }

  private failureNode(suffix: string, revision: number): TuiNode {
    return {
      key: `core.plugin-failure.${suffix}`,
      revision: String(revision),
      slot: "activity",
      create: () => new Text(muted("  一个 TUI 组件未能显示。"), 0, 1),
    };
  }
}

function stableNode(
  key: string,
  slot: TuiSlot,
  context: TuiPluginContext,
  create: () => Component,
): TuiNode {
  return {
    key,
    slot,
    revision: String(context.readModel().revision),
    create,
  };
}

/** 内建插件固定槽位组合；没有运行时磁盘、网络或命令加载入口。 */
export function createCoreTuiPlugins(): readonly TuiPlugin[] {
  return [
    {
      id: "core.header",
      nodes: (context) => [
        stableNode("core.header", "header", context, () => new Header(context.readModel)),
        stableNode("core.spacer", "spacer", context, () => new Text("", 0, 1)),
      ],
    },
    {
      id: "core.workflow",
      nodes: (context) => [
        stableNode("core.workflow", "workflow", context, () => new WorkflowPresenter(context.readModel)),
      ],
    },
    {
      id: "core.session",
      nodes: (context) => [
        stableNode("core.session", "session", context, () => new SessionPresenter(context.readModel)),
      ],
    },
    {
      id: "core.transcript",
      nodes: (context) => [
        stableNode("core.transcript", "transcript", context, () => context.transcript),
      ],
    },
    {
      id: "core.activity",
      nodes: (context) => [
        stableNode("core.activity", "activity", context, () => context.activity),
      ],
    },
    {
      id: "core.closeout",
      nodes: (context) => [
        stableNode("core.closeout", "closeout", context, () => new TaskCloseoutPresenter(context.readModel)),
      ],
    },
    {
      id: "core.approval",
      nodes: (context) => [
        stableNode("core.approval", "approval", context, () => new ApprovalPresenter(context.readModel)),
      ],
    },
    {
      id: "core.composer",
      nodes: (context) => [stableNode("core.composer", "composer", context, () => context.composer)],
    },
    {
      id: "core.footer",
      nodes: (context) => [
        stableNode("core.footer", "footer", context, () => new Footer(context.readModel)),
      ],
    },
  ];
}

export interface PiTuiRendererCallbacks {
  readonly onAction: (action: TuiAction) => void;
  readonly normalizeInput: (text: string) => string;
}

export interface PiTuiRendererOptions {
  readonly options: CliArguments;
  readonly terminal: Terminal;
  readonly viewState: () => SessionViewState;
  readonly callbacks: PiTuiRendererCallbacks;
  readonly plugins?: readonly TuiPlugin[];
}

/**
 * Pi 终端适配器。它只负责展示、编辑器和受限输入意图；不持有 AgentLoop、审批 resolver 或 AbortController。
 */
export class PiTuiRenderer {
  readonly #options: CliArguments;
  readonly #terminal: Terminal;
  readonly #viewState: () => SessionViewState;
  readonly #callbacks: PiTuiRendererCallbacks;
  readonly #tui: TUI;
  readonly #transcript = new Container();
  readonly #activity = new Container();
  readonly #timeline: ToolTimeline;
  readonly #loader: Loader;
  readonly #editor: Editor;
  readonly #composer: KeyedTuiComposer;
  #events: readonly AgentEvent[] = [];
  #loading = false;
  #activityExpanded = false;
  #revision = 0;
  #started = false;
  #stopped = false;

  constructor(options: PiTuiRendererOptions) {
    this.#options = options.options;
    this.#terminal = options.terminal;
    this.#viewState = options.viewState;
    this.#callbacks = options.callbacks;
    this.#tui = new TUI(new ScrollbackPreservingTerminal(this.#terminal), true);
    this.#timeline = new ToolTimeline(() => this.readModel());
    this.#loader = new Loader(this.#tui, accent, muted, "等待任务");
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1, autocompleteMaxVisible: 6 });
    this.#editor.onSubmit = (text) => {
      this.#callbacks.onAction({ type: "submit", text });
    };
    this.#editor.onChange = (text) => {
      const normalized = this.#callbacks.normalizeInput(text);
      if (normalized !== text) this.#editor.setText(normalized);
    };
    this.#tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.#callbacks.onAction({ type: "interrupt" });
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        this.#callbacks.onAction({ type: "toggle_activity" });
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("v"))) {
        this.#callbacks.onAction({ type: "paste" });
        return { consume: true };
      }
      return undefined;
    });
    this.#composer = new KeyedTuiComposer(
      this.#tui,
      [...createCoreTuiPlugins(), ...(options.plugins ?? [])],
    );
  }

  get editorText(): string {
    return this.#editor.getExpandedText();
  }

  get editorSubmitDisabled(): boolean {
    return this.#editor.disableSubmit;
  }

  get activityExpanded(): boolean {
    return this.#activityExpanded;
  }

  get loading(): boolean {
    return this.#loading;
  }

  get mountedNodeKeys(): readonly string[] {
    return this.#composer.nodeKeys;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#terminal.setTitle("MiniCode");
    this.#composer.mount(this.pluginContext());
    this.#tui.setFocus(this.#editor);
    this.#tui.start();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#loader.stop();
    this.#tui.stop();
  }

  setEditorText(text: string): void {
    this.#editor.setText(text);
  }

  setEditorSubmitDisabled(disabled: boolean): void {
    this.#editor.disableSubmit = disabled;
  }

  insertTextAtCursor(text: string): void {
    this.#editor.insertTextAtCursor(text);
  }

  focusEditor(): void {
    this.#tui.setFocus(this.#editor);
  }

  setLoaderMessage(message: string): void {
    this.#loader.setMessage(escapeTerminalText(message));
    this.requestRender();
  }

  startLoader(): void {
    this.#loading = true;
    this.#loader.start();
    this.refreshActivity();
  }

  stopLoader(): void {
    this.#loading = false;
    this.#loader.stop();
    this.refreshActivity();
  }

  setActivityEvents(events: readonly AgentEvent[]): void {
    this.#events = [...events];
    this.refreshActivity();
  }

  toggleActivity(): void {
    this.#activityExpanded = !this.#activityExpanded;
    this.requestRender();
  }

  clearTranscript(): void {
    this.#transcript.clear();
    this.requestRender();
  }

  clearScrollback(): void {
    this.#terminal.write("\u001B[3J");
  }

  appendWelcome(mode: string, remoteDataNotice?: string): void {
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))} ${muted(escapeMultilineTerminalText(mode))}`, 1, 0));
    if (remoteDataNotice !== undefined) {
      this.#transcript.addChild(new Text(
        yellow(`  ${escapeMultilineTerminalText(remoteDataNotice)}`),
        1,
        0,
      ));
    }
    this.#transcript.addChild(new Text(muted("  鼠标滚轮或终端滚动条可查看历史；支持 Ctrl+V 粘贴，工具细节默认折叠。"), 1, 1));
    this.requestRender();
  }

  appendUser(input: string): void {
    this.#transcript.addChild(new Text(`${bold(green("你"))}`, 1, 0));
    this.#transcript.addChild(new Text(escapeMultilineTerminalText(input), 2, 1));
    this.requestRender();
  }

  appendAnswer(answer: string): void {
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))}`, 1, 0));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(answer),
      2,
      1,
      MARKDOWN_THEME,
    ));
    this.requestRender();
  }

  appendHelp(includeOfflineExamples: boolean): void {
    const appendSection = (title: string, entries: readonly (readonly [string, string])[]): void => {
      this.#transcript.addChild(new Text(
        [
          bold(accent(title)),
          ...entries.map(([command, description]) => `  ${yellow(command)}  ${muted(description)}`),
        ].join("\n"),
        2,
        1,
      ));
    };

    this.#transcript.addChild(new Text(
      `${bold(accent("帮助"))}  ${muted("命令与本地确认")}`,
      1,
      0,
    ));
    appendSection("会话", [
      ["/model [profile]", "查看或切换模型 Profile"],
      ["/status", "查看当前配置"],
      ["/details 或 Ctrl+O", "展开或折叠工具活动"],
      ["/clear", "清空会话与当前终端历史"],
      ["/exit", "退出"],
    ]);
    appendSection("浏览与输入", [
      ["滚轮或终端滚动条", "查看历史"],
      ["Ctrl+V", "粘贴文本"],
    ]);
    appendSection("本地确认（仅等待确认时有效）", [
      ["CONTINUE", "开始计划或继续一次有界修复"],
      ["APPLY", "写入已预览的补丁"],
      ["RUN", "执行固定验证或受控命令"],
      ["CANCEL", "取消当前确认"],
    ]);
    if (includeOfflineExamples) {
      appendSection("离线演示（不会自行修改文件）", [
        ["源码查看", "说明未知工具为何仍有完整的终态事件"],
        ["Git 查看", "请查看 Git status 和未暂存 diff 并汇报"],
        ["测试", "运行测试并汇报结果"],
        ["编辑模式", "请查看 npm --version 并汇报"],
      ]);
    }
    this.requestRender();
  }

  appendNotice(message: string, tone: "accent" | "success" | "warning" | "error" | "muted"): void {
    const painter = {
      accent,
      success: green,
      warning: yellow,
      error: red,
      muted,
    }[tone];
    this.#transcript.addChild(new Text(
      painter(`  ${escapeMultilineTerminalText(message)}`),
      1,
      1,
    ));
    this.requestRender();
  }

  showEditApproval(request: EditApprovalRequest): void {
    this.#transcript.addChild(new Text(
      `${bold(yellow("待确认补丁"))} ${escapeTerminalText(request.path)}`,
      1,
      0,
    ));
    this.#transcript.addChild(new Text(
      color(37)(escapeMultilineTerminalText(request.preview)),
      2,
      1,
    ));
    this.appendNotice("补丁尚未写入。请准确输入 APPLY 并按 Enter 写入；输入 CANCEL 取消；其他输入会保留当前待确认补丁。", "warning");
    this.setEditorText("");
    this.setEditorSubmitDisabled(false);
    this.focusEditor();
  }

  showPlanApproval(request: PlanApprovalRequest): void {
    this.#transcript.addChild(new Text(bold(yellow("待确认计划")), 1, 0));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(request.plan),
      2,
      1,
      MARKDOWN_THEME,
    ));
    this.appendNotice("计划尚未执行。请准确输入 CONTINUE 开始；输入 CANCEL 取消。", "warning");
    this.setEditorText("");
    this.setEditorSubmitDisabled(false);
    this.focusEditor();
  }

  showRepairApproval(request: RepairApprovalRequest): void {
    this.#transcript.addChild(new Text(
      `${bold(yellow("待确认修复方向"))} ${escapeTerminalText(request.failedAction)}`,
      1,
      0,
    ));
    this.#transcript.addChild(new Text(
      muted(`修复尝试：${request.attempt} / ${request.maximumAttempts}`),
      2,
      0,
    ));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(request.direction),
      2,
      1,
      MARKDOWN_THEME,
    ));
    this.appendNotice(
      "修复尚未开始。请准确输入 CONTINUE 允许一次有界修复；输入 CANCEL 停止后续修复并保留当前工作区。后续补丁仍需 APPLY，复验仍需 RUN。",
      "warning",
    );
    this.setEditorText("");
    this.setEditorSubmitDisabled(false);
    this.focusEditor();
  }

  showCommandApproval(request: CommandApprovalRequest): void {
    const isVerification = request.kind === "verification";
    const title = isVerification ? "待确认验证" : "待确认命令";
    const commandLabel = isVerification ? "固定命令" : "命令";
    const riskLabel = { low: "低", medium: "中", high: "高" }[request.riskLevel];
    this.#transcript.addChild(new Text(`${bold(yellow(title))} ${escapeTerminalText(request.action)}`, 1, 0));
    this.#transcript.addChild(new Text(
      [
        `${commandLabel}：${escapeTerminalText(request.command)}`,
        `工作目录：${escapeTerminalText(request.workingDirectory)}`,
        `风险等级：${riskLabel}（${request.riskLevel}）`,
        `风险：${escapeTerminalText(request.risk)}`,
      ].join("\n"),
      2,
      1,
    ));
    this.appendNotice(
      isVerification
        ? "命令尚未执行。请准确输入 RUN 并按 Enter 执行；输入 CANCEL 取消；其他输入会保留当前待确认验证。"
        : "进程尚未启动。请准确输入 RUN 并按 Enter 执行；输入 CANCEL 取消；其他输入会保留当前待确认命令。",
      "warning",
    );
    this.setEditorText("");
    this.setEditorSubmitDisabled(false);
    this.focusEditor();
  }

  requestRender(full = false): void {
    this.#revision += 1;
    this.#composer.refresh(this.pluginContext());
    this.#tui.requestRender(full);
  }

  private refreshActivity(): void {
    this.#activity.clear();
    if (this.#loading) this.#activity.addChild(this.#loader);
    this.#activity.addChild(this.#timeline);
    this.requestRender();
  }

  private pluginContext(): TuiPluginContext {
    return {
      readModel: () => this.readModel(),
      transcript: this.#transcript,
      activity: this.#activity,
      composer: this.#editor,
    };
  }

  private readModel(): TuiReadModel {
    return createTuiReadModel(
      {
        ...this.#viewState(),
        activityExpanded: this.#activityExpanded,
      },
      this.#events,
      this.#revision,
      {
        workspaceName: path.basename(this.#options.workspaceRoot) || this.#options.workspaceRoot,
        modelLabel: modelLabel(this.#options),
        permissionLabel: toolPermissionLabel(this.#options),
      },
    );
  }
}
