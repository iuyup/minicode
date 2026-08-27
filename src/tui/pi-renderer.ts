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
  visibleWidth,
} from "@mariozechner/pi-tui";

import type {
  CommandApprovalRequest,
  EditApprovalRequest,
  PlanApprovalRequest,
  RepairApprovalRequest,
} from "../agent/contracts.ts";
import type { AgentEvent } from "../agent/events.ts";
import { activeModelName, modelLabel, toolPermissionLabel, type CliArguments } from "../runtime.ts";
import { escapeMultilineTerminalText, escapeTerminalText } from "../terminal-safety.ts";
import type {
  ApprovalKind,
  SessionPhase,
  SessionViewState,
  TaskCloseoutOutcome,
  TaskCloseoutView,
  TuiAction,
  TuiNode,
  TuiPlugin,
  TuiPluginContext,
  TuiReadModel,
  TuiSlot,
} from "./contracts.ts";
import { createTuiReadModel } from "./read-model.ts";

const RESET = "\u001B[0m";

function color(code: number | string): (text: string) => string {
  return (text) => `\u001B[${code}m${text}${RESET}`;
}

// 3A：固定深紫 #6D28D9，避免 ANSI 主题映射改变产品强调色。
const accent = color("38;2;109;40;217");
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
  borderColor: muted,
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

function compactPermissionLabel(permissionLabel: string): string {
  switch (permissionLabel) {
    case "离线演示（不可自主改代码）":
      return "离线，不改文件";
    case "受控编辑（逐次确认）":
      return "编辑需确认";
    case "引导式受控编辑":
      return "引导式编辑";
    case "引导式只读":
      return "引导式只读";
    default:
      return permissionLabel;
  }
}

function isTransientPhase(phase: SessionPhase): boolean {
  return phase !== "ready" && phase !== "completed" && phase !== "stopped";
}

function closeoutOutcomeLabel(outcome: TaskCloseoutOutcome): string {
  switch (outcome) {
    case "completed":
      return "已结束";
    case "cancelled":
      return "已取消";
    case "stopped":
      return "已停止";
    case "failed":
      return "未完成";
  }
}

function renderCloseoutModification(closeout: TaskCloseoutView): string {
  if (closeout.appliedPaths.length > 0) {
    return `写入 ${closeout.appliedPaths.length} 个文件`;
  }
  if (closeout.proposedPatchCount > 0) {
    return `预览 ${closeout.proposedPatchCount} 个补丁`;
  }
  return "未写入";
}

function renderCloseoutVerification(closeout: TaskCloseoutView): string {
  const verification = closeout.verification;
  if (!verification) return "未运行验证";
  const action = escapeTerminalText(verification.action);
  const attempts = verification.attempts > 1 ? ` ×${verification.attempts}` : "";
  if (verification.status === "passed") return `验证 ${action} ✓${attempts}`;
  if (verification.status === "not_run") {
    return `未运行验证${verification.cancelled ? "（已取消）" : ""}${attempts}`;
  }
  if (verification.status === "cancelled") return `验证 ${action} 已取消${attempts}`;
  return `验证 ${action} 未通过${verification.timedOut ? "（超时）" : ""}${attempts}`;
}

function outcomeMark(outcome: TaskCloseoutOutcome): string {
  switch (outcome) {
    case "completed":
      return green("✓");
    case "cancelled":
    case "stopped":
      return yellow("•");
    case "failed":
      return red("×");
  }
}

function renderCloseoutToolSummary(closeout: TaskCloseoutView): string {
  const outcomes = [`工具 ${closeout.successfulTools} 成功`];
  if (closeout.failedTools > 0) outcomes.push(`${closeout.failedTools} 失败`);
  if (closeout.cancelledTools > 0) outcomes.push(`${closeout.cancelledTools} 已取消`);
  return outcomes.join(" / ");
}

/**
 * 任务结束后的低强调摘要。末尾一行空白把它与新的输入框明确分隔开，
 * 但不把 Git、审计文件名等追溯信息挤进主阅读流。
 */
export function renderCloseoutSummary(closeout: TaskCloseoutView, width: number): readonly string[] {
  const outcome = closeoutOutcomeLabel(closeout.outcome);
  const tools = renderCloseoutToolSummary(closeout);
  const changes = renderCloseoutModification(closeout);
  const verification = renderCloseoutVerification(closeout);
  const summary = ` ${outcomeMark(closeout.outcome)} ${muted(`${outcome} · ${tools} · ${changes} · ${verification}`)}`;
  const primaryLine = ` ${outcomeMark(closeout.outcome)} ${muted(`${outcome} · ${tools}`)}`;
  const detailLine = `   ${muted(`${changes} · ${verification}`)}`;

  if (visibleWidth(summary) <= width) {
    return [renderLine(summary, width), renderLine("", width)];
  }

  if (visibleWidth(primaryLine) <= width && visibleWidth(detailLine) <= width) {
    return [
      renderLine(primaryLine, width),
      renderLine(detailLine, width),
      renderLine("", width),
    ];
  }

  return [
    renderLine(` ${outcomeMark(closeout.outcome)} ${muted(outcome)}`, width),
    renderLine(`   ${muted(tools)}`, width),
    renderLine(detailLine, width),
    renderLine("", width),
  ];
}

class Header implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.#readModel();
    const phase = view.session.phase;
    const phaseBadge = isTransientPhase(phase)
      ? ` ${muted("·")} ${sessionPhaseBadge(phase)}`
      : "";
    return [
      renderLine(
        ` ${bold(accent("✦ MiniCode"))} ${muted("·")} ${escapeTerminalText(view.chrome.workspaceName)} ${muted("·")} ${escapeTerminalText(view.chrome.modelLabel)} ${muted("·")} ${muted(compactPermissionLabel(view.chrome.permissionLabel))}${phaseBadge}`,
        width,
      ),
    ];
  }
}

class WorkflowPresenter implements Component {
  invalidate(): void {}

  render(_width: number): string[] {
    // 阶段状态只在执行或确认时靠近输入区出现，避免空闲页变成仪表盘。
    return [];
  }
}

class SessionPresenter implements Component {
  invalidate(): void {}

  render(_width: number): string[] {
    // Loader、工具摘要和确认卡会在需要时给出状态；这里不常驻重复会话信息。
    return [];
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
        ` ${yellow("⚠")} ${bold(yellow(`${APPROVAL_KIND_LABELS[approval.kind]}待确认`))}  ${yellow(approval.confirmWord)} ${muted("确认")} ${muted("·")} ${yellow(approval.cancelWord)} ${muted("取消")}`,
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
    return [...renderCloseoutSummary(closeout, width)];
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
      // 默认视图只保留 Loader 与最终收口；工具详情由用户按需展开。
      return [];
    }

    return [
      renderLine(`  ${bold(accent("工具详情"))} ${muted("· Ctrl+O 收起")}`, width),
      ...activity.items.map((item) => renderLine(`  ${muted("↳")} ${item.label}`, width)),
    ];
  }
}

/** 每轮输入前的弱分隔线，只服务于阅读节奏，不承载任何状态或控制语义。 */
class TranscriptTurnDivider implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    const dashCount = Math.max(width - 2, 1);
    return [renderLine(` ${muted("┄".repeat(dashCount))}`, width)];
  }
}

/** 输入区下方的固定状态行：路径靠左，实际调用模型靠右。 */
export function renderFooterStatus(workspacePath: string, modelName: string, width: number): string {
  const safeWorkspacePath = escapeTerminalText(workspacePath);
  const safeModelName = escapeTerminalText(modelName);
  const contentWidth = Math.max(width - 1, 1);
  const modelWidth = visibleWidth(safeModelName);

  // 窄终端优先保留当前模型；正常宽度下路径靠左、模型靠右。
  if (modelWidth >= contentWidth) {
    return renderLine(accent(truncateToWidth(safeModelName, contentWidth)), width);
  }

  const workspaceWidth = Math.max(contentWidth - modelWidth - 1, 1);
  const displayedPath = truncateToWidth(safeWorkspacePath, workspaceWidth);
  const gap = Math.max(contentWidth - visibleWidth(displayedPath) - modelWidth, 1);
  return renderLine(` ${muted(displayedPath)}${" ".repeat(gap)}${accent(safeModelName)}`, width);
}

class Footer implements Component {
  readonly #readModel: () => TuiReadModel;

  constructor(readModel: () => TuiReadModel) {
    this.#readModel = readModel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const chrome = this.#readModel().chrome;
    return [renderFooterStatus(chrome.workspacePath, chrome.modelName, width)];
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
        stableNode("core.workflow", "workflow", context, () => new WorkflowPresenter()),
      ],
    },
    {
      id: "core.session",
      nodes: (context) => [
        stableNode("core.session", "session", context, () => new SessionPresenter()),
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

/** `/model` 面板需要展示的公开 Profile 摘要；不包含 base URL、API Key 或请求内容。 */
export interface TuiModelProfileView {
  readonly id: string;
  readonly label: string;
  readonly readiness: string;
  readonly current: boolean;
  readonly ready: boolean;
}

/** 模型切换后的公开展示摘要；不包含 base URL、API Key 或请求内容。 */
export interface TuiModelSwitchSummary {
  readonly profileLabel?: string;
  readonly modelName: string;
  readonly remoteWorkspacePath?: string;
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
  #hasUserInput = false;
  #streamingAnswerHeader?: Text;
  #streamingAnswer?: Markdown;
  #streamingAnswerText = "";
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

  /** 仅供流式展示回归测试读取；不暴露原始模型文本。 */
  get hasStreamingAnswer(): boolean {
    return this.#streamingAnswer !== undefined;
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
    this.#streamingAnswerHeader = undefined;
    this.#streamingAnswer = undefined;
    this.#streamingAnswerText = "";
    this.#hasUserInput = false;
    this.requestRender();
  }

  clearScrollback(): void {
    this.#terminal.write("\u001B[3J");
  }

  appendWelcome(mode: string, remoteWorkspacePath?: string): void {
    this.#transcript.addChild(new Text(
      `${accent("✦")} ${escapeMultilineTerminalText(mode)}`,
      1,
      1,
    ));
    if (remoteWorkspacePath !== undefined) this.appendRemoteDataNotice(remoteWorkspacePath);
    this.requestRender();
  }

  appendUser(input: string): void {
    const lines = escapeMultilineTerminalText(input).split("\n");
    const hasPreviousTurn = this.#hasUserInput;
    if (hasPreviousTurn) this.#transcript.addChild(new TranscriptTurnDivider());
    this.#transcript.addChild(new Text(
      [
        `${bold(accent("❯"))} ${lines[0] ?? ""}`,
        ...lines.slice(1).map((line) => `  ${line}`),
      ].join("\n"),
      hasPreviousTurn ? 0 : 1,
      1,
    ));
    this.#hasUserInput = true;
    this.requestRender();
  }

  appendAnswer(answer: string): void {
    this.discardStreamingAnswer();
    this.#transcript.addChild(new Text(`${accent("✦")} ${muted("MiniCode")}`, 1, 0));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(answer),
      2,
      1,
      MARKDOWN_THEME,
    ));
    this.requestRender();
  }

  /**
   * 追加临时回答草稿。始终重新转义完整累计文本，防止跨网络分片的控制序列进入终端。
   */
  appendStreamingAnswerDelta(delta: string): void {
    if (delta === "") return;
    if (!this.#streamingAnswer) {
      this.#streamingAnswerHeader = new Text(`${accent("✦")} ${muted("MiniCode")}`, 1, 0);
      this.#streamingAnswer = new Markdown("", 2, 1, MARKDOWN_THEME);
      this.#transcript.addChild(this.#streamingAnswerHeader);
      this.#transcript.addChild(this.#streamingAnswer);
    }
    this.#streamingAnswerText += delta;
    this.#streamingAnswer.setText(escapeMultilineTerminalText(this.#streamingAnswerText));
    // pi-tui 自带小窗口合并；每个 token 无需重新编排插件树。
    this.#tui.requestRender();
  }

  /** 用 AgentLoop 已接纳的最终回答定稿；无流时自动沿用一次性回答。 */
  finalizeStreamingAnswer(answer: string): void {
    if (!this.#streamingAnswer) {
      this.appendAnswer(answer);
      return;
    }
    this.#streamingAnswerText = answer;
    this.#streamingAnswer.setText(escapeMultilineTerminalText(answer));
    this.#streamingAnswerHeader = undefined;
    this.#streamingAnswer = undefined;
    this.requestRender();
  }

  /** 工具调用、校验拒绝、取消或错误时移除尚未被 AgentLoop 接纳的临时回答。 */
  discardStreamingAnswer(): void {
    if (!this.#streamingAnswerHeader && !this.#streamingAnswer) {
      this.#streamingAnswerText = "";
      return;
    }
    if (this.#streamingAnswerHeader) this.#transcript.removeChild(this.#streamingAnswerHeader);
    if (this.#streamingAnswer) this.#transcript.removeChild(this.#streamingAnswer);
    this.#streamingAnswerHeader = undefined;
    this.#streamingAnswer = undefined;
    this.#streamingAnswerText = "";
    this.requestRender();
  }

  appendHelp(includeOfflineExamples: boolean): void {
    this.#transcript.addChild(new Text(bold("命令"), 1, 0));
    this.#transcript.addChild(new Text(
      [
        `  ${yellow("/model [profile]")}  ${muted("查看或切换模型")}`,
        `  ${yellow("/status")}           ${muted("查看当前配置与审计")}`,
        `  ${yellow("/details")}${muted(" / Ctrl+O")}  ${muted("展开工具过程")}`,
        `  ${yellow("/clear")}            ${muted("清空会话与终端历史")}`,
        `  ${yellow("/exit")}             ${muted("退出")}`,
        "",
        `  ${muted("仅在提示时确认：")} ${yellow("CONTINUE")} ${yellow("APPLY")} ${yellow("RUN")} ${yellow("CANCEL")}`,
        ...(includeOfflineExamples
          ? [`  ${muted("离线示例：查看源码 · 查看 Git status · 运行测试")}`]
          : []),
      ].join("\n"),
      1,
      1,
    ));
    this.requestRender();
  }

  /** 用独立面板呈现 Profile，避免把列表、配置和安全说明挤进通用通知。 */
  appendModelProfiles(profiles: readonly TuiModelProfileView[]): void {
    const safeProfiles = profiles.map((profile) => ({
      id: escapeTerminalText(profile.id),
      label: escapeTerminalText(profile.label),
      readiness: escapeTerminalText(profile.readiness),
      current: profile.current,
      ready: profile.ready,
    }));
    const profileLines = safeProfiles.flatMap((profile, index) => {
      const marker = profile.current ? accent("● 当前") : muted("○ 可选");
      const readiness = profile.ready ? green(profile.readiness) : yellow(profile.readiness);
      return [
        `  ${marker}  ${yellow(profile.id)}`,
        `      ${profile.label} ${muted("·")} ${readiness}`,
        ...(index < safeProfiles.length - 1 ? [""] : []),
      ];
    });
    this.#transcript.addChild(new Text(
      [
        bold(accent("模型 Profile")),
        "",
        ...profileLines,
        "",
        bold(accent("切换")),
        `  ${yellow("/model <profile>")}  ${muted("切换；会清空后续发送给模型的会话上下文。")}`,
        "",
        bold(accent("OpenAI-compatible 配置")),
        `  ${muted("BASE URL")}  ${yellow("MINICODE_OPENAI_BASE_URL")}`,
        `  ${muted("MODEL")}     ${yellow("MINICODE_OPENAI_MODEL")}`,
        `  ${muted("API KEY")}   ${yellow("MINICODE_OPENAI_API_KEY")}`,
        "",
        bold(accent("连接限制")),
        `  ${muted("默认仅 HTTPS 或本机回环 HTTP。")}`,
        `  ${yellow("MINICODE_ALLOW_INSECURE_HTTP=1")} ${muted("会放行其他明文 HTTP；可能暴露密钥和正文。")}`,
      ].join("\n"),
      1,
      1,
    ));
    this.requestRender();
  }

  /** 固定结构的切换摘要，避免用两段自动折行的通用通知表达状态与数据边界。 */
  appendModelSwitchSummary(summary: TuiModelSwitchSummary): void {
    const profileLabel = summary.profileLabel === undefined
      ? undefined
      : escapeTerminalText(summary.profileLabel);
    const modelName = escapeTerminalText(summary.modelName);
    const identity = profileLabel === undefined ? accent(modelName) : `${muted(profileLabel)} ${muted("→")} ${accent(modelName)}`;
    this.#transcript.addChild(new Text(
      [
        `${green("✓")} ${bold(green("模型已切换"))}`,
        `  ${identity}`,
        `  ${muted("后续发送给模型的会话已清空。")}`,
      ].join("\n"),
      1,
      1,
    ));
    if (summary.remoteWorkspacePath !== undefined) this.appendRemoteDataNotice(summary.remoteWorkspacePath);
    this.requestRender();
  }

  appendNotice(message: string, tone: "accent" | "success" | "warning" | "error" | "muted"): void {
    const presentation = {
      accent: { icon: "•", painter: accent },
      success: { icon: "✓", painter: green },
      warning: { icon: "!", painter: yellow },
      error: { icon: "×", painter: red },
      muted: { icon: "·", painter: muted },
    }[tone];
    const lines = escapeMultilineTerminalText(message).split("\n");
    this.#transcript.addChild(new Text(
      [
        ` ${presentation.painter(presentation.icon)} ${lines[0] ?? ""}`,
        ...lines.slice(1).map((line) => `   ${line}`),
      ].join("\n"),
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
        workspacePath: path.resolve(this.#options.workspaceRoot),
        modelName: activeModelName(this.#options),
        modelLabel: modelLabel(this.#options),
        permissionLabel: toolPermissionLabel(this.#options),
      },
    );
  }

  private appendRemoteDataNotice(workspacePath: string): void {
    this.#transcript.addChild(new Text(
      [
        `${yellow("!")} ${bold(yellow("远程数据提示"))}`,
        `  ${muted("工作区")}  ${escapeTerminalText(workspacePath)}`,
        `  ${muted("切换本身不发送请求；任务执行时可能发送：")}`,
        `  ${muted("用户任务 · 目录/搜索结果 · 源码片段 · Git 状态或差异")}`,
        `  ${muted("编辑参数 · 获准进程输出")}`,
      ].join("\n"),
      1,
      1,
    ));
  }
}
