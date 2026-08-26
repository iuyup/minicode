#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ProcessTerminal, type Terminal } from "@mariozechner/pi-tui";

import { type AgentLoop } from "./agent/agent-loop.ts";
import type {
  ChatModel,
  CommandApprovalRequest,
  ConversationMessage,
  EditApprovalRequest,
  PlanApprovalRequest,
  RepairApprovalRequest,
} from "./agent/contracts.ts";
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
import { escapeMultilineTerminalText } from "./terminal-safety.ts";
import {
  PiTuiRenderer,
  type PiTuiRendererCallbacks,
} from "./tui/pi-renderer.ts";
import {
  MAX_CONTEXT_TURNS,
  type ApprovalKind,
  type SessionPhase,
  type SessionViewState,
  type TaskCloseoutView,
  type TuiAction,
  type TuiPlugin,
} from "./tui/contracts.ts";
import { deriveTaskCloseout, eventLabel, phaseForAgentEvent, phaseForApproval } from "./tui/read-model.ts";

export type {
  ApprovalKind,
  SessionPendingApproval,
  SessionPhase,
  SessionViewState,
  TaskCloseoutExecutionStatus,
  TaskCloseoutGitAction,
  TaskCloseoutGitInspection,
  TaskCloseoutOutcome,
  TaskCloseoutVerification,
  TaskCloseoutVerificationStatus,
  TaskCloseoutView,
  TuiAction,
  TuiActivityItem,
  TuiActivityView,
  TuiChromeView,
  TuiNode,
  TuiPlugin,
  TuiPluginContext,
  TuiReadModel,
  TuiSlot,
} from "./tui/contracts.ts";

const MAX_CLIPBOARD_CHARACTERS = 32_000;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
const execFileAsync = promisify(execFile);

const APPROVAL_SPECS = {
  plan: {
    confirmWord: "CONTINUE",
    prompt: "CONTINUE / CANCEL",
    waiting: "计划仍在等待确认。精确输入 CONTINUE 开始执行；输入 CANCEL 取消。",
    approved: "计划已确认，正在开始执行。",
    rejected: "已取消计划，未执行工具或修改文件。",
  },
  repair: {
    confirmWord: "CONTINUE",
    prompt: "CONTINUE / CANCEL",
    waiting: "修复方向仍在等待确认。精确输入 CONTINUE 继续；输入 CANCEL 停止后续修复。",
    approved: "修复方向已确认，正在进行一次有界修复。",
    rejected: "已停止后续修复，当前工作区保持现状。",
  },
  patch: {
    confirmWord: "APPLY",
    prompt: "APPLY / CANCEL",
    waiting: "确认未通过，补丁仍在等待确认。精确输入 APPLY 写入；输入 CANCEL 取消。",
    approved: "已确认补丁，正在进行原子写入。",
    rejected: "已取消补丁，文件保持不变。",
  },
  verification: {
    confirmWord: "RUN",
    prompt: "RUN / CANCEL",
    waiting: "验证仍在等待确认。精确输入 RUN 执行；输入 CANCEL 取消。",
    approved: "已确认验证，正在执行固定命令。",
    rejected: "已取消验证，固定命令未执行。",
  },
  command: {
    confirmWord: "RUN",
    prompt: "RUN / CANCEL",
    waiting: "命令仍在等待确认。精确输入 RUN 执行；输入 CANCEL 取消。",
    approved: "已确认命令，正在启动受控进程。",
    rejected: "已取消命令，进程未启动。",
  },
} as const satisfies Record<ApprovalKind, {
  confirmWord: string;
  prompt: string;
  waiting: string;
  approved: string;
  rejected: string;
}>;

const CONTROL_WORD_NOTICES = {
  APPLY: "当前没有待确认补丁，APPLY 未发送给模型。只有出现黄色“待确认补丁”时，精确输入 APPLY 才会写入。",
  CONTINUE: "当前没有待确认计划或修复方向，CONTINUE 未发送给模型。",
  RUN: "当前没有待确认验证或命令，RUN 未发送给模型。",
  CANCEL: "当前没有待确认操作，CANCEL 未发送给模型。",
} as const;

async function readWindowsClipboard(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("当前系统不支持 Ctrl+V 剪贴板读取。");
  }

  const systemRoot = WINDOWS_SYSTEM_ROOT;
  const executable = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const executableStat = await fs.lstat(executable).catch(() => undefined);
  if (!executableStat?.isFile()) {
    throw new Error("未找到可信的 Windows PowerShell 可执行文件，未读取剪贴板。");
  }

  const { stdout } = await execFileAsync(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Clipboard -Raw",
    ],
    {
      windowsHide: true,
      timeout: CLIPBOARD_TIMEOUT_MS,
      maxBuffer: (MAX_CLIPBOARD_CHARACTERS + 1) * 4,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot },
    },
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

type NoticeTone = "accent" | "success" | "warning" | "error" | "muted";

export interface MiniTuiCallbacks {
  onExit?: () => void;
  readClipboard?: () => Promise<string>;
  createAgent?: () => AgentLoop;
  model?: ChatModel;
  onAgentEvent?: (event: AgentEvent) => void;
  /** 仅限受信任的仓库内展示插件；不会从配置、磁盘或网络动态加载。 */
  tuiPlugins?: readonly TuiPlugin[];
}

/**
 * TUI 控制器。它独占 AgentLoop、审批 resolver、取消控制和命令解析；Pi 渲染器只收到只读展示模型。
 */
export class MiniTuiApp {
  readonly #options: CliArguments;
  #agent: AgentLoop;
  readonly #onExit?: () => void;
  readonly #readClipboard: () => Promise<string>;
  readonly #createAgent?: () => AgentLoop;
  readonly #renderer: PiTuiRenderer;
  readonly #history: ConversationMessage[] = [];
  readonly #events: AgentEvent[] = [];
  #pendingApproval?: {
    kind: ApprovalKind;
    resolve: (approved: boolean) => void;
  };
  #sessionPhase: SessionPhase = "ready";
  #sessionActivity = "等待任务";
  #currentPlan?: string;
  #currentCloseout?: TaskCloseoutView;
  #running = false;
  #started = false;
  #stopped = false;
  #taskAbortController?: AbortController;
  #taskGeneration = 0;
  #inputGeneration = 0;

  constructor(options: CliArguments, terminal: Terminal, agent: AgentLoop, callbacks: MiniTuiCallbacks = {}) {
    this.#options = options;
    this.#agent = agent;
    this.#onExit = callbacks.onExit;
    this.#readClipboard = callbacks.readClipboard ?? readWindowsClipboard;
    this.#createAgent = callbacks.createAgent;
    const rendererCallbacks: PiTuiRendererCallbacks = {
      onAction: (action) => this.handleTuiAction(action),
      normalizeInput: (text) => {
        this.#inputGeneration += 1;
        return escapeMultilineTerminalText(text.replace(/\t/g, "    "));
      },
    };
    this.#renderer = new PiTuiRenderer({
      options: this.#options,
      terminal,
      viewState: () => this.sessionViewState,
      callbacks: rendererCallbacks,
      ...(callbacks.tuiPlugins ? { plugins: callbacks.tuiPlugins } : {}),
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

  get awaitingRepairApproval(): boolean {
    return this.#pendingApproval?.kind === "repair";
  }

  get awaitingCommandApproval(): boolean {
    return this.#pendingApproval?.kind === "verification" || this.#pendingApproval?.kind === "command";
  }

  get approvalPrompt(): string | undefined {
    return this.#pendingApproval ? APPROVAL_SPECS[this.#pendingApproval.kind].prompt : undefined;
  }

  /** 等待本地确认时停止动画，避免把用户决策误显示为自动执行。 */
  get loading(): boolean {
    return this.#renderer.loading;
  }

  get sessionViewState(): SessionViewState {
    const pendingApproval = this.#pendingApproval;
    const approvalSpec = pendingApproval ? APPROVAL_SPECS[pendingApproval.kind] : undefined;
    return {
      phase: this.#sessionPhase,
      activity: this.#sessionActivity,
      contextTurns: this.contextTurns,
      activityExpanded: this.#renderer.activityExpanded,
      ...(this.#currentPlan !== undefined ? { plan: this.#currentPlan } : {}),
      ...(this.#currentCloseout ? { closeout: this.#currentCloseout } : {}),
      ...(pendingApproval && approvalSpec
        ? {
            pendingApproval: {
              kind: pendingApproval.kind,
              confirmWord: approvalSpec.confirmWord,
              cancelWord: "CANCEL",
              prompt: approvalSpec.prompt,
            },
          }
        : {}),
    };
  }

  get editorText(): string {
    return this.#renderer.editorText;
  }

  /** 仅供组件编排回归测试读取；不暴露底层终端或原始事件。 */
  get tuiNodeKeys(): readonly string[] {
    return this.#renderer.mountedNodeKeys;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#renderer.start();
    this.appendWelcome();
    this.#renderer.focusEditor();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#running = false;
    this.#sessionPhase = "stopped";
    this.#sessionActivity = "会话已结束";
    this.#taskGeneration += 1;
    this.#inputGeneration += 1;
    this.#taskAbortController?.abort();
    this.#taskAbortController = undefined;
    this.resolvePendingApproval(false, false);
    this.#renderer.stop();
  }

  async submit(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (this.#stopped) return;
    if (this.#pendingApproval) {
      const spec = APPROVAL_SPECS[this.#pendingApproval.kind];
      if (input === spec.confirmWord) {
        this.resolvePendingApproval(true);
      } else if (input === "CANCEL" || input === "/cancel") {
        this.resolvePendingApproval(false);
      } else {
        this.#renderer.setEditorText("");
        this.appendNotice(spec.waiting, "warning");
      }
      return;
    }
    const controlNotice = CONTROL_WORD_NOTICES[input.toUpperCase() as keyof typeof CONTROL_WORD_NOTICES];
    if (controlNotice) {
      this.#renderer.setEditorText("");
      this.appendNotice(controlNotice, "warning");
      return;
    }
    if (!input) return;
    if (this.#running) {
      this.appendNotice("当前任务仍在执行，请等待它结束后再发送下一条消息。", "warning");
      return;
    }
    if (input.startsWith("/")) {
      this.handleCommand(input);
      return;
    }

    this.#renderer.setEditorText("");
    this.#renderer.setEditorSubmitDisabled(true);
    this.#inputGeneration += 1;
    this.#events.splice(0, this.#events.length);
    this.#renderer.setActivityEvents(this.#events);
    this.#currentPlan = undefined;
    this.#currentCloseout = undefined;
    this.#sessionPhase = this.#options.guided ? "planning" : "executing";
    this.#sessionActivity = "正在准备任务";
    this.#running = true;
    const taskGeneration = ++this.#taskGeneration;
    const abortController = new AbortController();
    this.#taskAbortController = abortController;
    this.appendUser(input);
    this.#renderer.setLoaderMessage("正在准备任务");
    this.#renderer.startLoader();

    try {
      const result = await this.#agent.run(input, {
        conversationHistory: this.#history,
        signal: abortController.signal,
      });
      if (this.#stopped || taskGeneration !== this.#taskGeneration) return;
      this.replaceTaskEvents(result.events);
      this.#currentCloseout = deriveTaskCloseout(
        result.events,
        this.#options.auditPath,
        this.#options.executionMode,
        abortController.signal.aborted ? "cancelled" : undefined,
      );
      if (abortController.signal.aborted) {
        this.#sessionPhase = "stopped";
        this.#sessionActivity = "任务已取消";
        this.appendNotice("当前任务已取消，未追加旧回答。", "warning");
        return;
      }
      appendConversation(this.#history, input, result.answer);
      this.#sessionPhase = this.#currentCloseout.outcome === "completed" ? "completed" : "stopped";
      this.#sessionActivity = this.#currentCloseout.outcome === "completed" ? "任务已完成" : "任务未完成";
      this.appendAnswer(result.answer);
    } catch (error) {
      if (this.#stopped || taskGeneration !== this.#taskGeneration) return;
      if (abortController.signal.aborted) {
        this.#currentCloseout = deriveTaskCloseout(
          this.#events,
          this.#options.auditPath,
          this.#options.executionMode,
          "cancelled",
        );
        this.#sessionPhase = "stopped";
        this.#sessionActivity = "任务已取消";
        this.appendNotice("当前任务已取消，未追加旧回答。", "warning");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.#currentCloseout = deriveTaskCloseout(
        this.#events,
        this.#options.auditPath,
        this.#options.executionMode,
        "failed",
      );
      this.#sessionPhase = "stopped";
      this.#sessionActivity = "任务未完成";
      this.appendNotice(`任务未完成：${message}`, "error");
    } finally {
      if (taskGeneration !== this.#taskGeneration || this.#stopped) return;
      this.#running = false;
      this.#taskAbortController = undefined;
      this.#inputGeneration += 1;
      this.#renderer.setEditorSubmitDisabled(false);
      this.#renderer.stopLoader();
      this.refreshActivity();
      this.#renderer.focusEditor();
      this.#renderer.requestRender();
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    if (this.#stopped) return;
    this.#events.push(event);
    this.#renderer.setActivityEvents(this.#events);
    const activity = eventLabel(event);
    this.#sessionActivity = activity;
    const phase = phaseForAgentEvent(event);
    if (phase) this.#sessionPhase = phase;
    this.#renderer.setLoaderMessage(activity);
    this.refreshActivity();
  }

  requestEditApproval(request: EditApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);
    this.#renderer.stopLoader();
    this.#renderer.showEditApproval(request);
    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "patch", resolve };
      this.#sessionPhase = "patch_pending";
      this.#sessionActivity = "等待补丁确认";
      this.#renderer.requestRender();
    });
  }

  requestPlanApproval(request: PlanApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);
    this.#renderer.stopLoader();
    this.#renderer.showPlanApproval(request);
    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "plan", resolve };
      this.#currentPlan = request.plan;
      this.#sessionPhase = "plan_pending";
      this.#sessionActivity = "等待计划确认";
      this.#renderer.requestRender();
    });
  }

  requestRepairApproval(request: RepairApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);
    this.#renderer.stopLoader();
    this.#renderer.showRepairApproval(request);
    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "repair", resolve };
      this.#sessionPhase = "repair_pending";
      this.#sessionActivity = "等待修复方向确认";
      this.#renderer.requestRender();
    });
  }

  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);
    this.#renderer.stopLoader();
    this.#renderer.showCommandApproval(request);
    return new Promise((resolve) => {
      this.#pendingApproval = { kind: request.kind, resolve };
      this.#sessionPhase = phaseForApproval(request.kind);
      this.#sessionActivity = request.kind === "verification" ? "等待验证确认" : "等待命令确认";
      this.#renderer.requestRender();
    });
  }

  private handleTuiAction(action: TuiAction): void {
    switch (action.type) {
      case "submit":
        void this.submit(action.text);
        return;
      case "interrupt":
        this.requestExit();
        return;
      case "toggle_activity":
        this.#renderer.toggleActivity();
        this.refreshActivity();
        return;
      case "paste":
        void this.pasteFromClipboard();
        return;
    }
  }

  private appendWelcome(): void {
    const mode = this.#options.guided
      ? "当前为引导式会话：先确认计划，再进入每个执行阶段。"
      : this.#options.modelProfile === "fake"
        ? "当前是离线演示；输入 /model 查看并切换已配置的模型 Profile。"
        : this.#options.agentMode === "edit"
          ? "当前是受控编辑会话：补丁逐次等待 APPLY，验证与 Node/npm 命令逐次等待 RUN。"
          : `当前会话会调用 ${modelLabel(this.#options)}，并仅开放已标明的工具权限。`;
    this.#renderer.appendWelcome(
      mode,
      this.#options.modelProfile !== "fake" ? this.remoteDataNotice() : undefined,
    );
  }

  private remoteDataNotice(): string {
    return [
      `远程数据提示：当前工作区 ${this.#options.workspaceRoot} 将连接 ${modelLabel(this.#options)}。`,
      "按工具实际调用，用户任务、目录/搜索结果、源码片段、Git 状态或差异，以及编辑参数和获准进程输出可能发送给该远程服务。",
    ].join(" ");
  }

  private appendUser(input: string): void {
    this.#renderer.appendUser(input);
  }

  private appendAnswer(answer: string): void {
    this.#renderer.appendAnswer(answer);
  }

  private appendNotice(message: string, tone: NoticeTone): void {
    this.#renderer.appendNotice(message, tone);
  }

  private refreshActivity(): void {
    this.#renderer.setActivityEvents(this.#events);
  }

  private replaceTaskEvents(events: readonly AgentEvent[]): void {
    this.#events.splice(0, this.#events.length, ...events);
    this.#renderer.setActivityEvents(this.#events);
  }

  private async pasteFromClipboard(): Promise<void> {
    if (this.#stopped || this.#renderer.editorSubmitDisabled) return;
    const inputGeneration = ++this.#inputGeneration;
    const editorText = this.#renderer.editorText;
    try {
      const content = await this.#readClipboard();
      if (
        this.#stopped ||
        this.#renderer.editorSubmitDisabled ||
        inputGeneration !== this.#inputGeneration ||
        editorText !== this.#renderer.editorText
      ) return;
      if (content === "") {
        this.appendNotice("剪贴板没有可插入的文本。", "muted");
        return;
      }
      const safeContent = escapeMultilineTerminalText(content.replace(/\t/g, "    "));
      this.#renderer.insertTextAtCursor(safeContent);
      this.#renderer.focusEditor();
      this.#renderer.requestRender();
    } catch (error) {
      if (
        this.#stopped ||
        this.#renderer.editorSubmitDisabled ||
        inputGeneration !== this.#inputGeneration ||
        editorText !== this.#renderer.editorText
      ) return;
      const message = error instanceof Error ? error.message : "无法读取系统剪贴板。";
      this.appendNotice(`粘贴失败：${message}`, "warning");
    }
  }

  private resolvePendingApproval(approved: boolean, showNotice = true): void {
    const pendingApproval = this.#pendingApproval;
    if (!pendingApproval) return;
    this.#pendingApproval = undefined;
    this.#inputGeneration += 1;
    this.#renderer.setEditorText("");
    this.#renderer.setEditorSubmitDisabled(true);
    const spec = APPROVAL_SPECS[pendingApproval.kind];
    this.#sessionPhase = approved ? "executing" : "stopped";
    this.#sessionActivity = approved ? spec.approved : spec.rejected;
    if (this.#running && !this.#stopped) {
      this.#renderer.setLoaderMessage(this.#sessionActivity);
      this.#renderer.startLoader();
    }
    if (showNotice && !this.#stopped) {
      this.appendNotice(approved ? spec.approved : spec.rejected, approved ? "success" : "warning");
    }
    pendingApproval.resolve(approved);
  }

  private handleCommand(input: string): void {
    if (input === "/model" || input.startsWith("/model ")) {
      this.handleModelCommand(input);
      return;
    }
    switch (input) {
      case "/help":
        this.appendNotice("鼠标滚轮或终端滚动条查看历史；Ctrl+V 粘贴文本；/model 查看或切换模型；/status 查看当前配置；/details 或 Ctrl+O 展开工具活动；/clear 清空会话与当前终端历史；/exit 退出。计划或失败修复确认输入 CONTINUE；编辑确认输入 APPLY；验证或命令确认输入 RUN；CANCEL 取消。", "accent");
        break;
      case "/status":
        this.appendNotice(
          `${modelLabel(this.#options)} · ${toolPermissionLabel(this.#options)} · 上下文 ${this.contextTurns} / ${MAX_CONTEXT_TURNS} · 审计 ${path.basename(this.#options.auditPath)}`,
          "muted",
        );
        break;
      case "/details":
        this.#renderer.toggleActivity();
        this.refreshActivity();
        break;
      case "/clear":
        this.#inputGeneration += 1;
        this.#history.splice(0, this.#history.length);
        this.#events.splice(0, this.#events.length);
        this.#renderer.setActivityEvents(this.#events);
        this.#currentPlan = undefined;
        this.#currentCloseout = undefined;
        this.#sessionPhase = "ready";
        this.#sessionActivity = "等待任务";
        this.#renderer.clearTranscript();
        this.appendWelcome();
        this.appendNotice("已清空会话上下文；审计文件不会被删除。", "success");
        this.refreshActivity();
        this.#renderer.clearScrollback();
        this.#renderer.requestRender(true);
        break;
      case "/exit":
      case "/quit":
        this.requestExit();
        break;
      default:
        this.appendNotice(`未知命令：${input}。输入 /help 查看可用命令。`, "warning");
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
        `模型 Profile：\n${choices.join("\n")}\nOpenAI-compatible 配置：MINICODE_OPENAI_BASE_URL、MINICODE_OPENAI_MODEL、MINICODE_OPENAI_API_KEY。默认只允许 HTTPS 或本机回环 HTTP；MINICODE_ALLOW_INSECURE_HTTP=1 可显式放行其他明文 HTTP，但会暴露密钥与正文。\n输入 /model <profile> 切换；切换会清除后续发送给模型的会话上下文。`,
        "accent",
      );
      return;
    }
    if (!this.#createAgent) {
      this.appendNotice("当前 TUI 实例未提供模型切换工厂，无法切换 Profile。", "warning");
      return;
    }

    const previousOptions = { ...this.#options };
    try {
      const profile = selectModelProfile(this.#options, requestedProfile);
      if (profile.id === previousOptions.modelProfile) {
        this.appendNotice(`${modelLabel(this.#options)} 已是当前 Profile。`, "muted");
        return;
      }
      this.#agent = this.#createAgent();
      this.#inputGeneration += 1;
      this.#history.splice(0, this.#history.length);
      this.#events.splice(0, this.#events.length);
      this.#renderer.setActivityEvents(this.#events);
      this.#currentPlan = undefined;
      this.#currentCloseout = undefined;
      this.#sessionPhase = "ready";
      this.#sessionActivity = "等待新任务";
      this.appendNotice(
        `已切换到 ${modelLabel(this.#options)}；为避免不同模型混用上下文，后续发送给模型的会话已清空。`,
        "success",
      );
      if (this.#options.modelProfile !== "fake") {
        this.appendNotice(this.remoteDataNotice(), "warning");
      }
      this.refreshActivity();
    } catch (error) {
      Object.assign(this.#options, previousOptions);
      const message = error instanceof Error ? error.message : String(error);
      this.appendNotice(`模型切换失败：${message}`, "warning");
    }
  }

  private requestExit(): void {
    if (this.#running) {
      this.resolvePendingApproval(false);
      this.#taskAbortController?.abort();
      this.#inputGeneration += 1;
      this.appendNotice("正在取消当前任务；本次待确认操作已关闭。", "warning");
      return;
    }
    if (this.#pendingApproval) {
      this.resolvePendingApproval(false);
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

  let app: MiniTuiApp | undefined;
  const createConfiguredAgent = (): AgentLoop => createAgent(options, {
    model: callbacks.model,
    onEvent: (event) => {
      app?.handleAgentEvent(event);
      callbacks.onAgentEvent?.(event);
    },
    requestEditApproval: (request) => app?.requestEditApproval(request) ?? Promise.resolve(false),
    requestPlanApproval: (request) => app?.requestPlanApproval(request) ?? Promise.resolve(false),
    requestRepairApproval: (request) => app?.requestRepairApproval(request) ?? Promise.resolve(false),
    requestCommandApproval: (request) => app?.requestCommandApproval(request) ?? Promise.resolve(false),
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

  try {
    app.start();
    await exited;
  } finally {
    app.stop();
  }
}

const isMainModule = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runMini();
}
