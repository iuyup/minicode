#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  Editor,
  Container,
  Key,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TUI,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type Terminal,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";

import { type AgentLoop } from "./agent/agent-loop.ts";
import type { ConversationMessage, EditApprovalRequest, PlanApprovalRequest } from "./agent/contracts.ts";
import type { AgentEvent } from "./agent/events.ts";
import {
  createAgent,
  listModelProfiles,
  modelLabel,
  modelProfileReadiness,
  parseArguments,
  selectModelProfile,
  toolPermissionLabel,
  type CliArguments,
} from "./runtime.ts";

const MAX_CONTEXT_TURNS = 6;
const MAX_CLIPBOARD_CHARACTERS = 32_000;
const RESET = "\u001B[0m";
const execFileAsync = promisify(execFile);

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

function defaultSessionAuditPath(workspaceRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(workspaceRoot, "reports", `mini-session-${stamp}.jsonl`);
}

async function readWindowsClipboard(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("当前系统不支持 Ctrl+V 剪贴板读取。");
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Clipboard -Raw",
    ],
    { windowsHide: true, maxBuffer: MAX_CLIPBOARD_CHARACTERS + 1 },
  );
  if (stdout.length > MAX_CLIPBOARD_CHARACTERS) {
    throw new Error(`剪贴板内容超过 ${MAX_CLIPBOARD_CHARACTERS} 字符，未插入。`);
  }
  return stdout;
}

function appendConversation(history: ConversationMessage[], task: string, answer: string): void {
  history.push({ role: "user", content: task }, { role: "assistant", content: answer });
  const maximumMessages = MAX_CONTEXT_TURNS * 2;
  if (history.length > maximumMessages) {
    history.splice(0, history.length - maximumMessages);
  }
}

function eventLabel(event: AgentEvent): string {
  switch (event.type) {
    case "model_requested":
      return event.forcedToolName
        ? `正在请求模型（固定读取 ${event.forcedToolName}）`
        : "正在请求模型";
    case "plan_proposed":
      return "已生成待确认计划";
    case "plan_decision":
      return event.decision === "approved" ? "计划已确认，开始执行" : "计划已取消";
    case "tool_call":
      return `准备调用 ${event.toolName}`;
    case "tool_execution_started":
      return `正在执行 ${event.toolName}`;
    case "tool_finalized":
      return event.status === "success" ? `${event.toolName} 已完成` : `${event.toolName} 已被拒绝`;
    case "policy_decision":
      return `正在应用 ${event.toolName} 的策略`;
    case "final_answer_rejected":
      return "正在校验并修复源码引用";
    case "agent_completed":
      return "任务已完成";
    case "agent_stopped":
      return "任务已停止";
  }
}

function renderLine(text: string, width: number): string {
  return truncateToWidth(text, Math.max(width, 1));
}

class Header implements Component {
  readonly #options: CliArguments;
  readonly #isRunning: () => boolean;

  constructor(options: CliArguments, isRunning: () => boolean) {
    this.#options = options;
    this.#isRunning = isRunning;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.#isRunning() ? yellow("● 工作中") : green("● 就绪");
    const workspace = path.basename(this.#options.workspaceRoot) || this.#options.workspaceRoot;
    return [
      renderLine(`${bold(accent("◆ MiniCode"))}  ${muted("轻量 Coding Agent")}`, width),
      renderLine(`  ${state}  ${modelLabel(this.#options)}  ${muted("·")}  ${toolPermissionLabel(this.#options)}`, width),
      renderLine(`  ${muted("工作区")} ${workspace}  ${muted("·  Ctrl+O 展开工具细节")}`, width),
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
    ];
  }
}

class ToolTimeline implements Component {
  #events: readonly AgentEvent[] = [];
  #expanded = false;

  setEvents(events: readonly AgentEvent[]): void {
    this.#events = events;
  }

  toggle(): void {
    this.#expanded = !this.#expanded;
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.#events.length === 0) return [];

    const finalized = this.#events.filter((event) => event.type === "tool_finalized");
    const failed = finalized.filter((event) => event.status === "error").length;
    if (!this.#expanded) {
      const outcome = failed > 0 ? yellow(`${failed} 次受控拒绝`) : green("无错误终态");
      return [renderLine(`  ${muted("工具活动已折叠")} · ${finalized.length} 次处理 · ${outcome}`, width)];
    }

    return [
      renderLine(`  ${bold(accent("工具活动"))} ${muted("Ctrl+O 折叠")}`, width),
      ...this.#events.slice(-8).map((event) => renderLine(`  ${muted("·")} ${eventLabel(event)}`, width)),
    ];
  }
}

class Footer implements Component {
  readonly #options: CliArguments;
  readonly #contextTurns: () => number;
  readonly #isRunning: () => boolean;
  readonly #isAwaitingApproval: () => boolean;
  readonly #approvalLabel: () => string | undefined;

  constructor(
    options: CliArguments,
    contextTurns: () => number,
    isRunning: () => boolean,
    isAwaitingApproval: () => boolean,
    approvalLabel: () => string | undefined,
  ) {
    this.#options = options;
    this.#contextTurns = contextTurns;
    this.#isRunning = isRunning;
    this.#isAwaitingApproval = isAwaitingApproval;
    this.#approvalLabel = approvalLabel;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const activity = this.#isAwaitingApproval()
      ? yellow(`等待确认：${this.#approvalLabel() ?? "CANCEL"}`)
      : this.#isRunning()
        ? yellow("执行中")
        : green("可输入");
    return [
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
      renderLine(
        ` ${activity}  ${muted(`上下文 ${this.#contextTurns()} / ${MAX_CONTEXT_TURNS}`)}  ${muted("Ctrl+V 粘贴 · /help · /clear · /details · /exit")}`,
        width,
      ),
    ];
  }
}

export interface MiniTuiCallbacks {
  onExit?: () => void;
  readClipboard?: () => Promise<string>;
  createAgent?: () => AgentLoop;
}

/**
 * 终端展示层。它只渲染 AgentLoop 的安全生命周期事件；工具内容和审计记录仍留在原有链路。
 */
export class MiniTuiApp {
  readonly #options: CliArguments;
  readonly #terminal: Terminal;
  #agent: AgentLoop;
  readonly #onExit?: () => void;
  readonly #readClipboard: () => Promise<string>;
  readonly #createAgent?: () => AgentLoop;
  readonly #tui: TUI;
  readonly #transcript = new Container();
  readonly #activity = new Container();
  readonly #history: ConversationMessage[] = [];
  readonly #events: AgentEvent[] = [];
  readonly #timeline = new ToolTimeline();
  readonly #loader: Loader;
  readonly #editor: Editor;
  #pendingApproval?: {
    kind: "plan" | "patch";
    resolve: (approved: boolean) => void;
  };
  #running = false;
  #started = false;
  #stopped = false;

  constructor(options: CliArguments, terminal: Terminal, agent: AgentLoop, callbacks: MiniTuiCallbacks = {}) {
    this.#options = options;
    this.#terminal = terminal;
    this.#agent = agent;
    this.#onExit = callbacks.onExit;
    this.#readClipboard = callbacks.readClipboard ?? readWindowsClipboard;
    this.#createAgent = callbacks.createAgent;
    this.#tui = new TUI(terminal, true);
    this.#loader = new Loader(this.#tui, accent, muted, "等待任务");
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1, autocompleteMaxVisible: 6 });
    this.#editor.onSubmit = (text) => {
      void this.submit(text);
    };

    this.#tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.requestExit();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        this.#timeline.toggle();
        this.refreshActivity();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("v"))) {
        void this.pasteFromClipboard();
        return { consume: true };
      }
      return undefined;
    });
  }

  get contextTurns(): number {
    return this.#history.length / 2;
  }

  get running(): boolean {
    return this.#running;
  }

  get awaitingApproval(): boolean {
    return this.#pendingApproval !== undefined;
  }

  get awaitingPlanApproval(): boolean {
    return this.#pendingApproval?.kind === "plan";
  }

  get approvalPrompt(): string | undefined {
    return this.#pendingApproval?.kind === "plan"
      ? "CONTINUE / CANCEL"
      : this.#pendingApproval ? "APPLY / CANCEL" : undefined;
  }

  get editorText(): string {
    return this.#editor.getExpandedText();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#terminal.setTitle("MiniCode");
    this.#tui.addChild(new Header(this.#options, () => this.#running));
    this.#tui.addChild(new Text("", 0, 1));
    this.#tui.addChild(this.#transcript);
    this.#tui.addChild(this.#activity);
    this.#tui.addChild(new Text(muted("  输入一个代码任务，Enter 发送，Shift+Enter 换行。"), 0, 1));
    this.#tui.addChild(this.#editor);
    this.#tui.addChild(new Footer(
      this.#options,
      () => this.contextTurns,
      () => this.#running,
      () => this.awaitingApproval,
      () => this.approvalPrompt,
    ));
    this.appendWelcome();
    this.#tui.setFocus(this.#editor);
    this.#tui.start();
  }

  stop(): void {
    if (this.#stopped) return;
    this.resolvePendingApproval(false);
    this.#stopped = true;
    this.#loader.stop();
    this.#tui.stop();
  }

  async submit(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (this.#stopped) return;
    if (this.#pendingApproval) {
      const isPlanApproval = this.#pendingApproval.kind === "plan";
      const confirmWord = isPlanApproval ? "CONTINUE" : "APPLY";
      if (input === confirmWord) {
        this.resolvePendingApproval(true);
      } else if (input === "CANCEL" || input === "/cancel") {
        this.resolvePendingApproval(false);
      } else {
        this.#editor.setText("");
        this.appendNotice(
          isPlanApproval
            ? "计划仍在等待确认。精确输入 CONTINUE 开始执行；输入 CANCEL 取消。"
            : "确认未通过，补丁仍在等待确认。精确输入 APPLY 写入；输入 CANCEL 取消。",
          yellow,
        );
      }
      return;
    }
    if (input.toUpperCase() === "APPLY") {
      this.#editor.setText("");
      this.appendNotice(
        "当前没有待确认补丁，APPLY 未发送给模型。只有出现黄色“待确认补丁”时，精确输入 APPLY 才会写入。",
        yellow,
      );
      return;
    }
    if (input.toUpperCase() === "CONTINUE") {
      this.#editor.setText("");
      this.appendNotice("当前没有待确认计划，CONTINUE 未发送给模型。", yellow);
      return;
    }
    if (!input) return;
    if (this.#running) {
      this.appendNotice("当前任务仍在执行，请等待它结束后再发送下一条消息。", yellow);
      return;
    }
    if (input.startsWith("/")) {
      this.handleCommand(input);
      return;
    }

    this.#editor.setText("");
    this.#editor.disableSubmit = true;
    this.#events.splice(0, this.#events.length);
    this.#timeline.setEvents(this.#events);
    this.#running = true;
    this.appendUser(input);
    this.#loader.setMessage("正在准备任务");
    this.#loader.start();
    this.refreshActivity();

    try {
      const result = await this.#agent.run(input, { conversationHistory: this.#history });
      appendConversation(this.#history, input, result.answer);
      this.appendAnswer(result.answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendNotice(`任务未完成：${message}`, red);
    } finally {
      this.#running = false;
      this.#editor.disableSubmit = false;
      this.#loader.stop();
      this.refreshActivity();
      this.#tui.setFocus(this.#editor);
      this.#tui.requestRender();
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    this.#events.push(event);
    this.#timeline.setEvents(this.#events);
    this.#loader.setMessage(eventLabel(event));
    this.refreshActivity();
  }

  requestEditApproval(request: EditApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

    this.#transcript.addChild(new Text(`${bold(yellow("待确认补丁"))} ${request.path}`, 1, 0));
    this.#transcript.addChild(new Text(color(37)(request.preview), 2, 1));
    this.appendNotice("补丁尚未写入。请准确输入 APPLY 并按 Enter 写入；输入 CANCEL 取消；其他输入会保留当前待确认补丁。", yellow);
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);
    this.#tui.requestRender();

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "patch", resolve };
    });
  }

  requestPlanApproval(request: PlanApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

    this.#transcript.addChild(new Text(bold(yellow("待确认计划")), 1, 0));
    this.#transcript.addChild(new Markdown(request.plan, 2, 1, MARKDOWN_THEME));
    this.appendNotice("计划尚未执行。请准确输入 CONTINUE 开始；输入 CANCEL 取消。", yellow);
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);
    this.#tui.requestRender();

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "plan", resolve };
    });
  }

  private appendWelcome(): void {
    const mode = this.#options.guided
      ? "当前为引导式会话：先确认计划，再进入每个执行阶段。"
      : this.#options.modelProfile === "fake"
      ? "当前是离线演示；输入 /model 查看并切换已配置的模型 Profile。"
      : this.#options.agentMode === "edit"
        ? "当前是受控编辑会话：补丁必须先读取目标文件，并逐次等待你的 APPLY 确认。"
      : `当前会话会调用 ${modelLabel(this.#options)}，并仅开放已标明的工具权限。`;
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))} ${muted(mode)}`, 1, 0));
    this.#transcript.addChild(new Text(muted("  支持 Ctrl+V 粘贴；工具细节默认折叠，审计仍写入 reports。"), 1, 1));
  }

  private appendUser(input: string): void {
    this.#transcript.addChild(new Text(`${bold(green("你"))}`, 1, 0));
    this.#transcript.addChild(new Text(input, 2, 1));
  }

  private appendAnswer(answer: string): void {
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))}`, 1, 0));
    this.#transcript.addChild(new Markdown(answer, 2, 1, MARKDOWN_THEME));
  }

  private appendNotice(message: string, tone: (text: string) => string): void {
    this.#transcript.addChild(new Text(tone(`  ${message}`), 1, 1));
    this.#tui.requestRender();
  }

  private refreshActivity(): void {
    this.#activity.clear();
    if (this.#running) this.#activity.addChild(this.#loader);
    this.#activity.addChild(this.#timeline);
    this.#tui.requestRender();
  }

  private async pasteFromClipboard(): Promise<void> {
    if (this.#stopped || this.#editor.disableSubmit) return;
    try {
      const content = await this.#readClipboard();
      if (content === "") {
        this.appendNotice("剪贴板没有可插入的文本。", muted);
        return;
      }
      this.#editor.insertTextAtCursor(content);
      this.#tui.setFocus(this.#editor);
      this.#tui.requestRender();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取系统剪贴板。";
      this.appendNotice(`粘贴失败：${message}`, yellow);
    }
  }

  private resolvePendingApproval(approved: boolean): void {
    const pendingApproval = this.#pendingApproval;
    if (!pendingApproval) return;
    this.#pendingApproval = undefined;
    this.#editor.setText("");
    this.#editor.disableSubmit = true;
    const isPlanApproval = pendingApproval.kind === "plan";
    this.appendNotice(
      approved
        ? isPlanApproval ? "计划已确认，正在开始执行。" : "已确认补丁，正在进行原子写入。"
        : isPlanApproval ? "已取消计划，未执行工具或修改文件。" : "已取消补丁，文件保持不变。",
      approved ? green : yellow,
    );
    pendingApproval.resolve(approved);
  }

  private handleCommand(input: string): void {
    if (input === "/model" || input.startsWith("/model ")) {
      this.handleModelCommand(input);
      return;
    }
    switch (input) {
      case "/help":
        this.appendNotice("Ctrl+V 粘贴文本；/model 查看或切换模型；/status 查看当前配置；/details 或 Ctrl+O 展开工具活动；/clear 清空会话上下文；/exit 退出。计划确认输入 CONTINUE；编辑确认输入 APPLY；CANCEL 取消。", accent);
        break;
      case "/status":
        this.appendNotice(
          `${modelLabel(this.#options)} · ${toolPermissionLabel(this.#options)} · 上下文 ${this.contextTurns} / ${MAX_CONTEXT_TURNS} · 审计 ${path.basename(this.#options.auditPath)}`,
          muted,
        );
        break;
      case "/details":
        this.#timeline.toggle();
        this.refreshActivity();
        break;
      case "/clear":
        this.#history.splice(0, this.#history.length);
        this.#events.splice(0, this.#events.length);
        this.#timeline.setEvents(this.#events);
        this.#transcript.clear();
        this.appendWelcome();
        this.appendNotice("已清空会话上下文；审计文件不会被删除。", green);
        this.refreshActivity();
        break;
      case "/exit":
      case "/quit":
        this.requestExit();
        break;
      default:
        this.appendNotice(`未知命令：${input}。输入 /help 查看可用命令。`, yellow);
    }
  }

  private handleModelCommand(input: string): void {
    const requestedProfile = input.slice("/model".length).trim();
    if (requestedProfile === "") {
      const choices = listModelProfiles().map((profile) => {
        const marker = profile.id === this.#options.modelProfile ? "当前" : "可选";
        return `${marker} ${profile.id} · ${profile.label} · ${modelProfileReadiness(profile)}`;
      });
      this.appendNotice(
        `模型 Profile：\n${choices.join("\n")}\nOpenAI-compatible 配置：MINICODE_OPENAI_BASE_URL、MINICODE_OPENAI_MODEL、MINICODE_OPENAI_API_KEY。\n输入 /model <profile> 切换；切换会清除后续发送给模型的会话上下文。`,
        accent,
      );
      return;
    }
    if (!this.#createAgent) {
      this.appendNotice("当前 TUI 实例未提供模型切换工厂，无法切换 Profile。", yellow);
      return;
    }

    const previousOptions = { ...this.#options };
    try {
      const profile = selectModelProfile(this.#options, requestedProfile);
      if (profile.id === previousOptions.modelProfile) {
        this.appendNotice(`${modelLabel(this.#options)} 已是当前 Profile。`, muted);
        return;
      }
      this.#agent = this.#createAgent();
      this.#history.splice(0, this.#history.length);
      this.#events.splice(0, this.#events.length);
      this.#timeline.setEvents(this.#events);
      this.appendNotice(
        `已切换到 ${modelLabel(this.#options)}；为避免不同模型混用上下文，后续发送给模型的会话已清空。`,
        green,
      );
      this.refreshActivity();
    } catch (error) {
      Object.assign(this.#options, previousOptions);
      const message = error instanceof Error ? error.message : String(error);
      this.appendNotice(`模型切换失败：${message}`, yellow);
    }
  }

  private requestExit(): void {
    if (this.#pendingApproval) {
      this.resolvePendingApproval(false);
      return;
    }
    if (this.#running) {
      this.appendNotice("当前任务仍在执行；这一版暂不支持中断，完成后可再次按 Ctrl+C 或输入 /exit。", yellow);
      return;
    }
    this.stop();
    this.#onExit?.();
  }
}

export function createMiniTui(
  args: string[],
  terminal: Terminal,
  callbacks: MiniTuiCallbacks = {},
): MiniTuiApp {
  const options = parseArguments(args);
  if (!args.includes("--audit")) {
    options.auditPath = defaultSessionAuditPath(options.workspaceRoot);
  }

  let app: MiniTuiApp | undefined;
  const createConfiguredAgent = (): AgentLoop => createAgent(options, {
    onEvent: (event) => app?.handleAgentEvent(event),
    requestEditApproval: (request) => app?.requestEditApproval(request) ?? Promise.resolve(false),
    requestPlanApproval: (request) => app?.requestPlanApproval(request) ?? Promise.resolve(false),
  });
  const agent = createConfiguredAgent();
  app = new MiniTuiApp(options, terminal, agent, { ...callbacks, createAgent: createConfiguredAgent });
  return app;
}

export async function runMini(args: string[] = process.argv.slice(2)): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("mini 需要可交互的 TTY 终端；请在 PowerShell、Windows Terminal 或 VS Code 终端中运行。");
  }

  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const app = createMiniTui(args, new ProcessTerminal(), { onExit: () => resolveExit?.() });

  process.stdout.write("\u001B[?1049h");
  try {
    app.start();
    await exited;
  } finally {
    app.stop();
    process.stdout.write("\u001B[?1049l");
  }
}

const isMainModule = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runMini();
}
