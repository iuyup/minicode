import type { Component } from "@mariozechner/pi-tui";

/** 本地确认状态；展示层只读取它，不能持有审批 Promise。 */
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

/** 展示专用快照；审批 Promise、原始工具正文和停止原因永远不暴露给组件。 */
export interface SessionViewState {
  readonly phase: SessionPhase;
  readonly activity: string;
  readonly contextTurns: number;
  readonly activityExpanded: boolean;
  readonly plan?: string;
  readonly pendingApproval?: SessionPendingApproval;
  readonly closeout?: TaskCloseoutView;
}

/** 活动时间线的安全投影，已经移除了原始 AgentEvent 与工具 detail。 */
export interface TuiActivityItem {
  readonly key: string;
  readonly label: string;
}

export interface TuiActivityView {
  readonly items: readonly TuiActivityItem[];
  readonly finalizedCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
  readonly outcome?: "completed" | "cancelled" | "stopped";
}

/** 顶部与底部栏可展示的已净化配置摘要。 */
export interface TuiChromeView {
  readonly workspaceName: string;
  readonly modelLabel: string;
  readonly permissionLabel: string;
}

/** 插件唯一可读的不可变展示模型。 */
export interface TuiReadModel {
  readonly revision: number;
  readonly chrome: TuiChromeView;
  readonly session: SessionViewState;
  readonly activity: TuiActivityView;
}

/** 输入层只能发出这些意图；控制器仍独占审批与副作用。 */
export type TuiAction =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "interrupt" }
  | { readonly type: "toggle_activity" }
  | { readonly type: "paste" };

export type TuiSlot =
  | "header"
  | "spacer"
  | "workflow"
  | "session"
  | "transcript"
  | "activity"
  | "closeout"
  | "approval"
  | "composer_hint"
  | "composer"
  | "footer";

/**
 * 稳定键节点：组件只在首次挂载时创建，后续状态变更通过 revision 失效重绘。
 * 这是仓库内静态插件协议，不是可从磁盘或网络加载的代码插件机制。
 */
export interface TuiNode {
  readonly key: string;
  readonly revision: string;
  readonly slot: TuiSlot;
  readonly create: () => Component;
}

export interface TuiPluginContext {
  readonly readModel: () => TuiReadModel;
  readonly transcript: Component;
  readonly activity: Component;
  readonly composer: Component;
}

/** 受控面板插件：只生成展示节点，不能获得 AgentLoop、审批 resolver 或 Terminal。 */
export interface TuiPlugin {
  readonly id: string;
  nodes(context: TuiPluginContext): readonly TuiNode[];
}

export const MAX_CONTEXT_TURNS = 6;
