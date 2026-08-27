import path from "node:path";

import type { AgentEvent } from "../agent/events.ts";
import type { CliArguments } from "../runtime.ts";
import { escapeTerminalText } from "../terminal-safety.ts";
import type {
  ApprovalKind,
  SessionPhase,
  SessionViewState,
  TaskCloseoutExecutionStatus,
  TaskCloseoutGitAction,
  TaskCloseoutOutcome,
  TaskCloseoutVerification,
  TaskCloseoutView,
  TuiActivityView,
  TuiChromeView,
  TuiReadModel,
} from "./contracts.ts";

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

/** 将原始生命周期事件折叠为可安全展示的简短文案。 */
export function eventLabel(event: AgentEvent): string {
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

export function phaseForApproval(kind: ApprovalKind): SessionPhase {
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

export function phaseForAgentEvent(event: AgentEvent): SessionPhase | undefined {
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

/** 从完整事件数组提取任务收口事实；不读取审计文件，也不解析工具输出。 */
export function deriveTaskCloseout(
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

function activityView(events: readonly AgentEvent[]): TuiActivityView {
  const finalized = events.filter(
    (event): event is ToolFinalizedEvent => event.type === "tool_finalized",
  );
  const terminalEvent = events.findLast(
    (event): event is TerminalAgentEvent => event.type === "agent_completed" || event.type === "agent_stopped",
  );
  const start = Math.max(events.length - 8, 0);
  const items = events.slice(-8).map((event, offset) => ({
    key: `${start + offset}:${event.type}`,
    label: escapeTerminalText(eventLabel(event)),
  }));
  const outcome = terminalEvent?.type === "agent_completed"
    ? "completed"
    : terminalEvent?.type === "agent_stopped"
      ? (/取消/u.test(terminalEvent.reason) ? "cancelled" : "stopped")
      : undefined;
  return {
    items,
    finalizedCount: finalized.length,
    failedCount: finalized.filter(
      (event) => event.status === "error" && event.metadata?.cancelled !== true,
    ).length,
    cancelledCount: finalized.filter(
      (event) => event.status === "error" && event.metadata?.cancelled === true,
    ).length,
    ...(outcome ? { outcome } : {}),
  };
}

function freezeSessionView(session: SessionViewState): SessionViewState {
  const closeout = session.closeout;
  const frozenCloseout = closeout === undefined
    ? undefined
    : Object.freeze({
        ...closeout,
        appliedPaths: Object.freeze(closeout.appliedPaths.map(escapeTerminalText)),
        gitInspections: Object.freeze(closeout.gitInspections.map((inspection) => Object.freeze({ ...inspection }))),
        ...(closeout.verification === undefined
          ? {}
          : {
              verification: Object.freeze({
                ...closeout.verification,
                action: escapeTerminalText(closeout.verification.action),
              }),
            }),
        auditFileName: escapeTerminalText(closeout.auditFileName),
      });
  const pendingApproval = session.pendingApproval === undefined
    ? undefined
    : Object.freeze({
        ...session.pendingApproval,
        confirmWord: escapeTerminalText(session.pendingApproval.confirmWord),
        cancelWord: escapeTerminalText(session.pendingApproval.cancelWord) as "CANCEL",
        prompt: escapeTerminalText(session.pendingApproval.prompt),
      });
  return Object.freeze({
    ...session,
    activity: escapeTerminalText(session.activity),
    ...(session.plan === undefined ? {} : { plan: escapeTerminalText(session.plan) }),
    ...(frozenCloseout === undefined ? {} : { closeout: frozenCloseout }),
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  });
}

/** 仅将安全的展示快照交给组件插件；原始事件不会离开此投影边界。 */
export function createTuiReadModel(
  session: SessionViewState,
  events: readonly AgentEvent[],
  revision: number,
  chrome: TuiChromeView,
): TuiReadModel {
  const activity = activityView(events);
  return Object.freeze({
    revision,
    chrome: Object.freeze({
      workspaceName: escapeTerminalText(chrome.workspaceName),
      workspacePath: escapeTerminalText(chrome.workspacePath),
      modelName: escapeTerminalText(chrome.modelName),
      modelLabel: escapeTerminalText(chrome.modelLabel),
      permissionLabel: escapeTerminalText(chrome.permissionLabel),
    }),
    session: freezeSessionView(session),
    activity: Object.freeze({
      ...activity,
      items: Object.freeze(activity.items.map((item) => Object.freeze({ ...item }))),
    }),
  });
}
