#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
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
import { escapeMultilineTerminalText, escapeTerminalText } from "./terminal-safety.ts";

const MAX_CONTEXT_TURNS = 6;
const MAX_CLIPBOARD_CHARACTERS = 32_000;
const CLIPBOARD_TIMEOUT_MS = 5_000;
const WINDOWS_SYSTEM_ROOT = "C:\\Windows";
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

export type ApprovalKind = "plan" | "repair" | "patch" | "verification" | "command";

export type SessionPhase =
  | "ready"
  | "planning"
  | "plan_pending"
  | "executing"
  | "patch_pending"
  | "verification_pending"
  | "command_pending"
  | "repair_pending"
  | "completed"
  | "stopped";

export interface SessionPendingApproval {
  readonly kind: ApprovalKind;
  readonly confirmWord: string;
  readonly cancelWord: "CANCEL";
  readonly prompt: string;
}

export type TaskCloseoutOutcome = "completed" | "cancelled" | "stopped" | "failed";
export type TaskCloseoutVerificationStatus = "passed" | "failed" | "cancelled" | "not_run";
export type TaskCloseoutGitAction = "status" | "diff" | "staged_diff";
export type TaskCloseoutExecutionStatus = "completed" | "failed" | "cancelled";

export interface TaskCloseoutVerification {
  readonly action: string;
  readonly attempts: number;
  readonly status: TaskCloseoutVerificationStatus;
  readonly exitCode?: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface TaskCloseoutGitInspection {
  readonly action: TaskCloseoutGitAction;
  readonly status: TaskCloseoutExecutionStatus;
}

/** 只由已完成的本轮生命周期事件投影出的收口事实，不包含工具正文或停止原因。 */
export interface TaskCloseoutView {
  readonly outcome: TaskCloseoutOutcome;
  readonly eventCount: number;
  readonly successfulTools: number;
  readonly failedTools: number;
  readonly cancelledTools: number;
  readonly appliedPaths: readonly string[];
  readonly proposedPatchCount: number;
  readonly rejectedPatchCount: number;
  readonly verification?: TaskCloseoutVerification;
  readonly gitInspections: readonly TaskCloseoutGitInspection[];
  readonly auditFileName: string;
}

/** 展示专用快照；审批 Promise 及其 resolve 永远不暴露给展示层。 */
export interface SessionViewState {
  readonly phase: SessionPhase;
  readonly activity: string;
  readonly contextTurns: number;
  readonly activityExpanded: boolean;
  readonly plan?: string;
  readonly pendingApproval?: SessionPendingApproval;
  readonly closeout?: TaskCloseoutView;
}

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

/** pi-tui 全量重绘会附带 CSI 3J；这里只保留视口重绘，避免意外删除宿主终端历史。 */
class ScrollbackPreservingTerminal implements Terminal {
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

function appendConversation(history: ConversationMessage[], task: string, answer: string): void {
  history.push({ role: "user", content: task }, { role: "assistant", content: answer });
  const maximumMessages = MAX_CONTEXT_TURNS * 2;
  if (history.length > maximumMessages) {
    history.splice(0, history.length - maximumMessages);
  }
}

const TOOL_DISPLAY_NAMES = new Map<string, string>([
  ["get_project_overview", "项目概览"],
  ["list_files", "文件浏览"],
  ["search_text", "代码搜索"],
  ["read_file", "文件读取"],
  ["inspect_git", "Git 只读检查"],
  ["apply_patch", "受控补丁"],
  ["run_project_check", "项目验证"],
  ["run_command", "受控命令"],
]);

function toolDisplayName(toolName: string): string {
  const label = TOOL_DISPLAY_NAMES.get(toolName) ?? toolName;
  return escapeTerminalText(label);
}

function eventLabel(event: AgentEvent): string {
  switch (event.type) {
    case "model_requested":
      return event.forcedToolName
        ? `正在请求模型（固定读取 ${toolDisplayName(event.forcedToolName)}）`
        : "正在请求模型";
    case "plan_proposed":
      return "已生成待确认计划";
    case "plan_decision":
      return event.decision === "approved" ? "计划已确认，开始执行" : "计划已取消";
    case "repair_proposed":
      return "已生成待确认修复方向";
    case "repair_decision":
      return event.decision === "approved" ? "修复方向已确认" : "后续修复已停止";
    case "tool_call":
      return `准备调用 ${toolDisplayName(event.toolName)}`;
    case "edit_approval_requested":
      return `等待确认补丁：${escapeTerminalText(event.path)}`;
    case "edit_approval_decision":
      return event.decision === "approved" ? "补丁已确认，准备写入" : "补丁已取消";
    case "command_approval_requested":
      return event.commandKind === "verification"
        ? `等待确认固定验证：${escapeTerminalText(event.action)}`
        : `等待确认受控命令：${escapeTerminalText(event.action)}`;
    case "command_approval_decision":
      if (event.commandKind === "verification") {
        return event.decision === "approved" ? "验证已确认，准备执行" : "验证已取消";
      }
      return event.decision === "approved" ? "命令已确认，准备执行" : "命令已取消";
    case "tool_execution_started":
      return `正在执行 ${toolDisplayName(event.toolName)}`;
    case "tool_finalized":
      if (event.status === "success") return `${toolDisplayName(event.toolName)}已完成`;
      return event.metadata?.cancelled
        ? `${toolDisplayName(event.toolName)}已取消`
        : `${toolDisplayName(event.toolName)}失败`;
    case "policy_decision":
      return `正在应用 ${toolDisplayName(event.toolName)}策略`;
    case "final_answer_rejected":
      return "正在校验并修复源码引用";
    case "agent_completed":
      return "任务已完成";
    case "agent_stopped":
      return /取消/u.test(event.reason) ? "任务已取消" : "任务已停止";
  }
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

function phaseForApproval(kind: ApprovalKind): SessionPhase {
  switch (kind) {
    case "plan":
      return "plan_pending";
    case "repair":
      return "repair_pending";
    case "patch":
      return "patch_pending";
    case "verification":
      return "verification_pending";
    case "command":
      return "command_pending";
  }
}

function phaseForAgentEvent(event: AgentEvent): SessionPhase | undefined {
  switch (event.type) {
    case "plan_proposed":
      return "planning";
    case "plan_decision":
      return event.decision === "approved" ? "executing" : "stopped";
    case "repair_proposed":
      return "repair_pending";
    case "repair_decision":
      return event.decision === "approved" ? "executing" : "stopped";
    case "edit_approval_requested":
      return "patch_pending";
    case "edit_approval_decision":
      return event.decision === "approved" ? "executing" : "stopped";
    case "command_approval_requested":
      return event.commandKind === "verification" ? "verification_pending" : "command_pending";
    case "command_approval_decision":
      return event.decision === "approved" ? "executing" : "stopped";
    case "agent_completed":
      return "completed";
    case "agent_stopped":
      return "stopped";
    case "model_requested":
    case "tool_call":
    case "tool_execution_started":
    case "tool_finalized":
    case "policy_decision":
    case "final_answer_rejected":
      return "executing";
  }
}

type ToolFinalizedEvent = Extract<AgentEvent, { type: "tool_finalized" }>;
type TerminalAgentEvent = Extract<AgentEvent, { type: "agent_completed" | "agent_stopped" }>;

function terminalOutcome(event: TerminalAgentEvent): TaskCloseoutOutcome {
  if (event.type === "agent_completed") return "completed";
  return /取消/u.test(event.reason) ? "cancelled" : "stopped";
}

function executionStatus(event: ToolFinalizedEvent): TaskCloseoutExecutionStatus {
  if (event.metadata?.cancelled === true) return "cancelled";
  return event.status === "success" ? "completed" : "failed";
}

function gitActionFromMetadata(action: string | undefined): TaskCloseoutGitAction | undefined {
  switch (action) {
    case "git_status":
      return "status";
    case "git_diff":
      return "diff";
    case "git_staged_diff":
      return "staged_diff";
    default:
      return undefined;
  }
}

function deriveTaskCloseout(
  events: readonly AgentEvent[],
  auditPath: string,
  executionMode: CliArguments["executionMode"],
  fallbackOutcome?: TaskCloseoutOutcome,
): TaskCloseoutView {
  const terminalEvent = events.findLast(
    (event): event is TerminalAgentEvent => event.type === "agent_completed" || event.type === "agent_stopped",
  );
  const finalized = events.filter(
    (event): event is ToolFinalizedEvent => event.type === "tool_finalized",
  );
  const successfulPatchIds = new Set(
    finalized
      .filter((event) => event.toolName === "apply_patch" && event.status === "success")
      .map((event) => event.toolCallId),
  );
  const approvedPatchPaths = new Map<string, string>();
  const rejectedPatchIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "edit_approval_decision") continue;
    if (event.decision === "approved") approvedPatchPaths.set(event.toolCallId, event.path);
    else rejectedPatchIds.add(event.toolCallId);
  }
  const appliedPaths = executionMode === "apply"
    ? [...new Set(
        [...approvedPatchPaths]
          .filter(([toolCallId]) => successfulPatchIds.has(toolCallId))
          .map(([, pathValue]) => pathValue),
      )]
    : [];
  const proposedPatchCount = executionMode === "propose"
    ? successfulPatchIds.size
    : 0;

  const verificationEvents = finalized.filter((event) => event.toolName === "run_project_check");
  const lastVerification = verificationEvents.at(-1);
  const verificationStartedIds = new Set(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "tool_execution_started" }> =>
          event.type === "tool_execution_started",
      )
      .filter((event) => event.toolName === "run_project_check")
      .map((event) => event.toolCallId),
  );
  const rejectedCommandIds = new Set(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "command_approval_decision" }> =>
          event.type === "command_approval_decision",
      )
      .filter((event) => event.decision === "rejected")
      .map((event) => event.toolCallId),
  );
  const rejectedVerificationIds = new Set(
    events
      .filter(
        (event): event is Extract<AgentEvent, { type: "command_approval_decision" }> =>
          event.type === "command_approval_decision",
      )
      .filter((event) => event.commandKind === "verification" && event.decision === "rejected")
      .map((event) => event.toolCallId),
  );
  const verification = lastVerification
    ? (() => {
        const cancelled = lastVerification.metadata?.cancelled === true ||
          rejectedVerificationIds.has(lastVerification.toolCallId);
        return {
          action: lastVerification.metadata?.action ?? "固定验证",
          attempts: verificationEvents.length,
          status: !verificationStartedIds.has(lastVerification.toolCallId)
            ? "not_run"
            : cancelled
              ? "cancelled"
              : lastVerification.status === "success" && lastVerification.metadata?.exitCode === 0
                ? "passed"
                : "failed",
          ...(lastVerification.metadata?.exitCode !== undefined
            ? { exitCode: lastVerification.metadata.exitCode }
            : {}),
          timedOut: lastVerification.metadata?.timedOut === true,
          cancelled,
        } satisfies TaskCloseoutVerification;
      })()
    : undefined;

  const gitInspections = new Map<TaskCloseoutGitAction, TaskCloseoutExecutionStatus>();
  for (const event of finalized) {
    if (event.toolName !== "inspect_git") continue;
    const action = gitActionFromMetadata(event.metadata?.action);
    if (action) gitInspections.set(action, executionStatus(event));
  }

  const cancelledTools = finalized.filter((event) =>
    event.status === "error" && (
      event.metadata?.cancelled === true ||
      rejectedPatchIds.has(event.toolCallId) ||
      rejectedCommandIds.has(event.toolCallId)
    )
  ).length;
  const failedTools = finalized.filter(
    (event) =>
      event.status === "error" &&
      event.metadata?.cancelled !== true &&
      !rejectedPatchIds.has(event.toolCallId) &&
      !rejectedCommandIds.has(event.toolCallId),
  ).length;
  return {
    outcome: fallbackOutcome ?? (terminalEvent ? terminalOutcome(terminalEvent) : "failed"),
    eventCount: events.length,
    successfulTools: finalized.filter((event) => event.status === "success").length,
    failedTools,
    cancelledTools,
    appliedPaths,
    proposedPatchCount,
    rejectedPatchCount: rejectedPatchIds.size,
    ...(verification ? { verification } : {}),
    gitInspections: [...gitInspections].map(([action, status]) => ({ action, status })),
    auditFileName: path.basename(auditPath),
  };
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

function renderCloseoutModification(closeout: TaskCloseoutView): string {
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

function renderCloseoutVerification(closeout: TaskCloseoutView): string {
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

function renderCloseoutGit(closeout: TaskCloseoutView): string {
  if (closeout.gitInspections.length === 0) return "Git 收口：未读取（不代表工作区干净）";
  const inspections = closeout.gitInspections
    .map((inspection) => `${closeoutGitActionLabel(inspection.action)}${closeoutExecutionLabel(inspection.status)}`)
    .join(" · ");
  return `Git 收口：${inspections}（只读；未暂存或提交）`;
}

class Header implements Component {
  readonly #options: CliArguments;
  readonly #viewState: () => SessionViewState;

  constructor(options: CliArguments, viewState: () => SessionViewState) {
    this.#options = options;
    this.#viewState = viewState;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const viewState = this.#viewState();
    const workspace = escapeTerminalText(
      path.basename(this.#options.workspaceRoot) || this.#options.workspaceRoot,
    );
    const model = escapeTerminalText(modelLabel(this.#options));
    const permissions = escapeTerminalText(toolPermissionLabel(this.#options));
    return [
      renderLine(`${bold(accent("◆ MiniCode"))}  ${muted("受控 Coding Agent")}  ${muted("·")} ${sessionPhaseBadge(viewState.phase)}`, width),
      renderLine(`  ${model}  ${muted("·")}  ${permissions}`, width),
      renderLine(`  ${muted("工作区")} ${workspace}  ${muted("·  滚轮浏览历史  ·  Ctrl+O 展开工具细节")}`, width),
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
    ];
  }
}

class SessionPresenter implements Component {
  readonly #viewState: () => SessionViewState;

  constructor(viewState: () => SessionViewState) {
    this.#viewState = viewState;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const viewState = this.#viewState();
    const lines = [
      renderLine(
        ` ${bold(accent("会话"))}  ${muted("当前活动")} ${escapeTerminalText(viewState.activity)}`,
        width,
      ),
    ];
    if (viewState.plan !== undefined) {
      lines.push(renderLine(`  ${muted("计划")} ${summarizeSessionPlan(viewState.plan)}`, width));
    } else if (viewState.phase === "planning") {
      lines.push(renderLine(`  ${muted("计划")} 正在准备可确认的最小步骤`, width));
    }
    return lines;
  }
}

class ApprovalPresenter implements Component {
  readonly #viewState: () => SessionViewState;

  constructor(viewState: () => SessionViewState) {
    this.#viewState = viewState;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const approval = this.#viewState().pendingApproval;
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
  readonly #viewState: () => SessionViewState;

  constructor(viewState: () => SessionViewState) {
    this.#viewState = viewState;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const closeout = this.#viewState().closeout;
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
    const cancelled = finalized.filter(
      (event) => event.status === "error" && event.metadata?.cancelled === true,
    ).length;
    const failed = finalized.filter(
      (event) => event.status === "error" && event.metadata?.cancelled !== true,
    ).length;
    const terminalEvent = this.#events.findLast(
      (event) => event.type === "agent_completed" || event.type === "agent_stopped",
    );
    if (!this.#expanded) {
      const unsuccessfulParts = [
        ...(failed > 0 ? [`${failed} 次失败`] : []),
        ...(cancelled > 0 ? [`${cancelled} 次已取消`] : []),
      ];
      const issueSummary = unsuccessfulParts.join(" · ");
      const outcome = terminalEvent?.type === "agent_stopped"
        ? yellow(`${/取消/u.test(terminalEvent.reason) ? "任务已取消" : "任务已停止"}${issueSummary ? `（${issueSummary}）` : ""}`)
        : terminalEvent?.type === "agent_completed"
          ? green(issueSummary ? `已完成（${issueSummary}）` : "成功完成")
          : issueSummary
            ? (failed > 0 ? red(issueSummary) : yellow(issueSummary))
            : muted("进行中");
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
  readonly #viewState: () => SessionViewState;

  constructor(options: CliArguments, viewState: () => SessionViewState) {
    this.#options = options;
    this.#viewState = viewState;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const viewState = this.#viewState();
    const activity = viewState.pendingApproval
      ? yellow(`等待确认：${viewState.pendingApproval.prompt}`)
      : viewState.phase === "planning" || viewState.phase === "executing"
        ? yellow("执行中")
        : viewState.phase === "stopped"
          ? yellow("已停止")
          : green("可输入");
    return [
      renderLine(muted("─".repeat(Math.max(width, 1))), width),
      renderLine(
        ` ${activity}  ${muted(`上下文 ${viewState.contextTurns} / ${MAX_CONTEXT_TURNS}`)}  ${muted("滚轮历史 · Ctrl+V 粘贴 · /help · /clear · /details · /exit")}`,
        width,
      ),
    ];
  }
}

export interface MiniTuiCallbacks {
  onExit?: () => void;
  readClipboard?: () => Promise<string>;
  createAgent?: () => AgentLoop;
  model?: ChatModel;
  onAgentEvent?: (event: AgentEvent) => void;
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
    this.#terminal = terminal;
    this.#agent = agent;
    this.#onExit = callbacks.onExit;
    this.#readClipboard = callbacks.readClipboard ?? readWindowsClipboard;
    this.#createAgent = callbacks.createAgent;
    this.#tui = new TUI(new ScrollbackPreservingTerminal(terminal), true);
    this.#loader = new Loader(this.#tui, accent, muted, "等待任务");
    this.#editor = new Editor(this.#tui, EDITOR_THEME, { paddingX: 1, autocompleteMaxVisible: 6 });
    this.#editor.onSubmit = (text) => {
      void this.submit(text);
    };
    this.#editor.onChange = (text) => {
      this.#inputGeneration += 1;
      const safeText = escapeMultilineTerminalText(text.replace(/\t/g, "    "));
      if (safeText !== text) this.#editor.setText(safeText);
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

  get awaitingRepairApproval(): boolean {
    return this.#pendingApproval?.kind === "repair";
  }

  get awaitingCommandApproval(): boolean {
    return this.#pendingApproval?.kind === "verification" || this.#pendingApproval?.kind === "command";
  }

  get approvalPrompt(): string | undefined {
    return this.#pendingApproval ? APPROVAL_SPECS[this.#pendingApproval.kind].prompt : undefined;
  }

  get sessionViewState(): SessionViewState {
    const pendingApproval = this.#pendingApproval;
    const approvalSpec = pendingApproval ? APPROVAL_SPECS[pendingApproval.kind] : undefined;
    return {
      phase: this.#sessionPhase,
      activity: this.#sessionActivity,
      contextTurns: this.contextTurns,
      activityExpanded: this.#timeline.expanded,
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
    return this.#editor.getExpandedText();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#terminal.setTitle("MiniCode");
    const viewState = () => this.sessionViewState;
    this.#tui.addChild(new Header(this.#options, viewState));
    this.#tui.addChild(new Text("", 0, 1));
    this.#tui.addChild(new SessionPresenter(viewState));
    this.#tui.addChild(this.#transcript);
    this.#tui.addChild(this.#activity);
    this.#tui.addChild(new TaskCloseoutPresenter(viewState));
    this.#tui.addChild(new ApprovalPresenter(viewState));
    this.#tui.addChild(new Text(muted("  输入一个代码任务，Enter 发送，Shift+Enter 换行。"), 0, 1));
    this.#tui.addChild(this.#editor);
    this.#tui.addChild(new Footer(this.#options, viewState));
    this.appendWelcome();
    this.#tui.setFocus(this.#editor);
    this.#tui.start();
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
    this.#loader.stop();
    this.#tui.stop();
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
        this.#editor.setText("");
        this.appendNotice(spec.waiting, yellow);
      }
      return;
    }
    const controlNotice = CONTROL_WORD_NOTICES[input.toUpperCase() as keyof typeof CONTROL_WORD_NOTICES];
    if (controlNotice) {
      this.#editor.setText("");
      this.appendNotice(controlNotice, yellow);
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
    this.#inputGeneration += 1;
    this.#events.splice(0, this.#events.length);
    this.#timeline.setEvents(this.#events);
    this.#currentPlan = undefined;
    this.#currentCloseout = undefined;
    this.#sessionPhase = this.#options.guided ? "planning" : "executing";
    this.#sessionActivity = "正在准备任务";
    this.#running = true;
    const taskGeneration = ++this.#taskGeneration;
    const abortController = new AbortController();
    this.#taskAbortController = abortController;
    this.appendUser(input);
    this.#loader.setMessage("正在准备任务");
    this.#loader.start();
    this.refreshActivity();

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
        this.appendNotice("当前任务已取消，未追加旧回答。", yellow);
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
        this.appendNotice("当前任务已取消，未追加旧回答。", yellow);
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
      this.appendNotice(`任务未完成：${message}`, red);
    } finally {
      if (taskGeneration !== this.#taskGeneration || this.#stopped) return;
      this.#running = false;
      this.#taskAbortController = undefined;
      this.#inputGeneration += 1;
      this.#editor.disableSubmit = false;
      this.#loader.stop();
      this.refreshActivity();
      this.#tui.setFocus(this.#editor);
      this.#tui.requestRender();
    }
  }

  handleAgentEvent(event: AgentEvent): void {
    if (this.#stopped) return;
    this.#events.push(event);
    this.#timeline.setEvents(this.#events);
    const activity = eventLabel(event);
    this.#sessionActivity = activity;
    const phase = phaseForAgentEvent(event);
    if (phase) this.#sessionPhase = phase;
    this.#loader.setMessage(activity);
    this.refreshActivity();
  }

  requestEditApproval(request: EditApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

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
    this.appendNotice("补丁尚未写入。请准确输入 APPLY 并按 Enter 写入；输入 CANCEL 取消；其他输入会保留当前待确认补丁。", yellow);
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "patch", resolve };
      this.#sessionPhase = "patch_pending";
      this.#sessionActivity = "等待补丁确认";
      this.#tui.requestRender();
    });
  }

  requestPlanApproval(request: PlanApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

    this.#transcript.addChild(new Text(bold(yellow("待确认计划")), 1, 0));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(request.plan),
      2,
      1,
      MARKDOWN_THEME,
    ));
    this.appendNotice("计划尚未执行。请准确输入 CONTINUE 开始；输入 CANCEL 取消。", yellow);
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "plan", resolve };
      this.#currentPlan = request.plan;
      this.#sessionPhase = "plan_pending";
      this.#sessionActivity = "等待计划确认";
      this.#tui.requestRender();
    });
  }

  requestRepairApproval(request: RepairApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

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
      yellow,
    );
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: "repair", resolve };
      this.#sessionPhase = "repair_pending";
      this.#sessionActivity = "等待修复方向确认";
      this.#tui.requestRender();
    });
  }

  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean> {
    if (this.#stopped || this.#pendingApproval) return Promise.resolve(false);

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
      yellow,
    );
    this.#editor.setText("");
    this.#editor.disableSubmit = false;
    this.#tui.setFocus(this.#editor);

    return new Promise((resolve) => {
      this.#pendingApproval = { kind: request.kind, resolve };
      this.#sessionPhase = phaseForApproval(request.kind);
      this.#sessionActivity = isVerification ? "等待验证确认" : "等待命令确认";
      this.#tui.requestRender();
    });
  }

  private appendWelcome(): void {
    const mode = this.#options.guided
      ? "当前为引导式会话：先确认计划，再进入每个执行阶段。"
      : this.#options.modelProfile === "fake"
      ? "当前是离线演示；输入 /model 查看并切换已配置的模型 Profile。"
      : this.#options.agentMode === "edit"
        ? "当前是受控编辑会话：补丁逐次等待 APPLY，验证与 Node/npm 命令逐次等待 RUN。"
      : `当前会话会调用 ${escapeTerminalText(modelLabel(this.#options))}，并仅开放已标明的工具权限。`;
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))} ${muted(mode)}`, 1, 0));
    if (this.#options.modelProfile !== "fake") {
      this.#transcript.addChild(new Text(
        yellow(`  ${escapeMultilineTerminalText(this.remoteDataNotice())}`),
        1,
        0,
      ));
    }
    this.#transcript.addChild(new Text(muted("  鼠标滚轮或终端滚动条可查看历史；支持 Ctrl+V 粘贴，工具细节默认折叠。"), 1, 1));
  }

  private remoteDataNotice(): string {
    return [
      `远程数据提示：当前工作区 ${this.#options.workspaceRoot} 将连接 ${modelLabel(this.#options)}。`,
      "按工具实际调用，用户任务、目录/搜索结果、源码片段、Git 状态或差异，以及编辑参数和获准进程输出可能发送给该远程服务。",
    ].join(" ");
  }

  private appendUser(input: string): void {
    this.#transcript.addChild(new Text(`${bold(green("你"))}`, 1, 0));
    this.#transcript.addChild(new Text(escapeMultilineTerminalText(input), 2, 1));
  }

  private appendAnswer(answer: string): void {
    this.#transcript.addChild(new Text(`${bold(accent("MiniCode"))}`, 1, 0));
    this.#transcript.addChild(new Markdown(
      escapeMultilineTerminalText(answer),
      2,
      1,
      MARKDOWN_THEME,
    ));
  }

  private appendNotice(message: string, tone: (text: string) => string): void {
    this.#transcript.addChild(new Text(
      tone(`  ${escapeMultilineTerminalText(message)}`),
      1,
      1,
    ));
    this.#tui.requestRender();
  }

  private refreshActivity(): void {
    this.#activity.clear();
    if (this.#running) this.#activity.addChild(this.#loader);
    this.#activity.addChild(this.#timeline);
    this.#tui.requestRender();
  }

  private replaceTaskEvents(events: readonly AgentEvent[]): void {
    this.#events.splice(0, this.#events.length, ...events);
    this.#timeline.setEvents(this.#events);
  }

  private async pasteFromClipboard(): Promise<void> {
    if (this.#stopped || this.#editor.disableSubmit) return;
    const inputGeneration = ++this.#inputGeneration;
    const editorText = this.#editor.getExpandedText();
    try {
      const content = await this.#readClipboard();
      if (
        this.#stopped ||
        this.#editor.disableSubmit ||
        inputGeneration !== this.#inputGeneration ||
        editorText !== this.#editor.getExpandedText()
      ) return;
      if (content === "") {
        this.appendNotice("剪贴板没有可插入的文本。", muted);
        return;
      }
      const safeContent = escapeMultilineTerminalText(content.replace(/\t/g, "    "));
      this.#editor.insertTextAtCursor(safeContent);
      this.#tui.setFocus(this.#editor);
      this.#tui.requestRender();
    } catch (error) {
      if (
        this.#stopped ||
        this.#editor.disableSubmit ||
        inputGeneration !== this.#inputGeneration ||
        editorText !== this.#editor.getExpandedText()
      ) return;
      const message = error instanceof Error ? error.message : "无法读取系统剪贴板。";
      this.appendNotice(`粘贴失败：${message}`, yellow);
    }
  }

  private resolvePendingApproval(approved: boolean, showNotice = true): void {
    const pendingApproval = this.#pendingApproval;
    if (!pendingApproval) return;
    this.#pendingApproval = undefined;
    this.#inputGeneration += 1;
    this.#editor.setText("");
    this.#editor.disableSubmit = true;
    const spec = APPROVAL_SPECS[pendingApproval.kind];
    this.#sessionPhase = approved ? "executing" : "stopped";
    this.#sessionActivity = approved ? spec.approved : spec.rejected;
    if (showNotice && !this.#stopped) {
      this.appendNotice(approved ? spec.approved : spec.rejected, approved ? green : yellow);
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
        this.appendNotice("鼠标滚轮或终端滚动条查看历史；Ctrl+V 粘贴文本；/model 查看或切换模型；/status 查看当前配置；/details 或 Ctrl+O 展开工具活动；/clear 清空会话与当前终端历史；/exit 退出。计划或失败修复确认输入 CONTINUE；编辑确认输入 APPLY；验证或命令确认输入 RUN；CANCEL 取消。", accent);
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
        this.#inputGeneration += 1;
        this.#history.splice(0, this.#history.length);
        this.#events.splice(0, this.#events.length);
        this.#timeline.setEvents(this.#events);
        this.#currentPlan = undefined;
        this.#currentCloseout = undefined;
        this.#sessionPhase = "ready";
        this.#sessionActivity = "等待任务";
        this.#transcript.clear();
        this.appendWelcome();
        this.appendNotice("已清空会话上下文；审计文件不会被删除。", green);
        this.refreshActivity();
        this.#terminal.write("\u001B[3J");
        this.#tui.requestRender(true);
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
        `模型 Profile：\n${choices.join("\n")}\nOpenAI-compatible 配置：MINICODE_OPENAI_BASE_URL、MINICODE_OPENAI_MODEL、MINICODE_OPENAI_API_KEY。默认只允许 HTTPS 或本机回环 HTTP；MINICODE_ALLOW_INSECURE_HTTP=1 可显式放行其他明文 HTTP，但会暴露密钥与正文。\n输入 /model <profile> 切换；切换会清除后续发送给模型的会话上下文。`,
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
      this.#inputGeneration += 1;
      this.#history.splice(0, this.#history.length);
      this.#events.splice(0, this.#events.length);
      this.#timeline.setEvents(this.#events);
      this.#currentPlan = undefined;
      this.#currentCloseout = undefined;
      this.#sessionPhase = "ready";
      this.#sessionActivity = "等待新任务";
      this.appendNotice(
        `已切换到 ${modelLabel(this.#options)}；为避免不同模型混用上下文，后续发送给模型的会话已清空。`,
        green,
      );
      if (this.#options.modelProfile !== "fake") {
        this.appendNotice(this.remoteDataNotice(), yellow);
      }
      this.refreshActivity();
    } catch (error) {
      Object.assign(this.#options, previousOptions);
      const message = error instanceof Error ? error.message : String(error);
      this.appendNotice(`模型切换失败：${message}`, yellow);
    }
  }

  private requestExit(): void {
    if (this.#running) {
      this.resolvePendingApproval(false);
      this.#taskAbortController?.abort();
      this.#inputGeneration += 1;
      this.appendNotice("正在取消当前任务；本次待确认操作已关闭。", yellow);
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
