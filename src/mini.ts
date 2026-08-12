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
import type { ConversationMessage, EditApprovalRequest } from "./agent/contracts.ts";
import type { AgentEvent } from "./agent/events.ts";
import {
  createAgent,
  modelLabel,
  parseArguments,
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
    ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
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

  constructor(options: CliArguments, contextTurns: () => number, isRunning: () => boolean) {
    this.#options = options;
    this.#contextTurns = contextTurns;
    this.#isRunning = isRunning;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const activity = this.#isRunning() ? yellow("执行中") : green("可输入");
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
}

/**
 * 终端展示层。它只渲染 AgentLoop 的安全生命周期事件；工具内容和审计记录仍留在原有链路。
 */
export class MiniTuiApp {
  readonly #options: CliArguments;
  readonly #terminal: Terminal;
  readonly #agent: AgentLoop;
  readonly #onExit?: () => void;
  readonly #readClipboard: () => Promise<string>;
  readonly #tui: TUI;
  readonly #transcript = new Container();
  readonly #activity = new Container();
  readonly #history: ConversationMessage[] = [];
  readonly #events: AgentEvent[] = [];
  readonly #timeline = new ToolTimeline();
  readonly #loader: Loader;
  readonly #editor: Editor;
  #pendingApproval?: { resolve: (approved: boolean) => void };
  #running = false;
  #started = false;
  #stopped = false;

  constructor(options: CliArguments, terminal: Terminal, agent: AgentLoop, callbacks: MiniTuiCallbacks = {}) {
    this.#options = options;
    this.#terminal = terminal;
    this.#agent = agent;
    this.#onExit = callbacks.onExit;
    this.#readClipboard = callbacks.readClipboard ?? readWindowsClipboard;
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
    this.#tui.addChild(new Footer(this.#options, () => this.contextTurns, () => this.#running));
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
      this.resolvePendingApproval(input === "APPLY");
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
    this.appendNotice("补丁尚未写入。请在下方准确输入 APPLY 并按 Enter 确认；任何其他输入都会取消。", yellow);
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);
    this.#tui.requestRender();

    return new Promise((resolve) => {
      this.#pendingApproval = { resolve };
    });
  }

  private appendWelcome(): void {
    const mode = this.#options.modelProvider === "fake"
      ? "当前是离线演示；使用 --model deepseek 才会发起真实模型请求。"
      : this.#options.agentMode === "edit"
        ? "当前是受控编辑会话：补丁必须先读取目标文件，并逐次等待你的 APPLY 确认。"
      : "当前会话会调用 DeepSeek，并仅开放已标明的工具权限。";
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
    this.appendNotice(
      approved ? "已确认补丁，正在进行原子写入。" : "已取消补丁，文件保持不变。",
      approved ? green : yellow,
    );
    pendingApproval.resolve(approved);
  }

  private handleCommand(input: string): void {
    switch (input) {
      case "/help":
        this.appendNotice("Ctrl+V 粘贴文本；/status 查看当前配置；/details 或 Ctrl+O 展开工具活动；/clear 清空会话上下文；/exit 退出。编辑确认期间只能输入 APPLY 或取消。", accent);
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
  const agent = createAgent(options, {
    onEvent: (event) => app?.handleAgentEvent(event),
    requestEditApproval: (request) => app?.requestEditApproval(request) ?? Promise.resolve(false),
  });
  app = new MiniTuiApp(options, terminal, agent, callbacks);
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
