import { ToolExecutionError, ToolPolicyError } from "./contracts.ts";
import type {
  AgentMessage,
  ChatModel,
  CommandApprovalRequest,
  ConversationMessage,
  EditApprovalRequest,
  ForcedFunctionToolChoice,
  PlanApprovalRequest,
  PreparedCommandExecution,
  RepairApprovalRequest,
  JsonValue,
  ModelResponse,
  ToolCall,
  ToolDescription,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ToolResultMessage,
  SourceEvidence,
} from "./contracts.ts";
import path from "node:path";
import {
  EDIT_HARD_MAX_ACCEPTED_TOOL_CALLS,
  EDIT_HARD_MAX_MODEL_REQUESTS,
} from "./budget-limits.ts";
import { InMemoryEventLog, type AgentEvent, type AgentEventAuditLog } from "./events.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { WorkingLedger } from "./working-ledger.ts";

export interface AgentRunResult {
  answer: string;
  messages: readonly AgentMessage[];
  events: readonly AgentEvent[];
  workingState: string;
  sourceEvidence: readonly SourceEvidence[];
}

export interface AgentRunOptions {
  conversationHistory?: readonly ConversationMessage[];
  signal?: AbortSignal;
}

export interface AgentLoopOptions {
  workspaceRoot: string;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  maxToolCalls?: number;
  /** 包含 planning/final-only 在内的绝对模型请求硬帽。 */
  hardMaxModelRequests?: number;
  /** 动态修复与验证扩容也不可超过的绝对工具受理硬帽。 */
  hardMaxToolCalls?: number;
  /** 工具总预算耗尽后的下一轮只允许最终回答，不再暴露工具。 */
  finalOnlyAfterToolBudget?: boolean;
  requireSourceEvidence?: boolean;
  /** 编辑模式下，补丁目标必须已由本轮成功的 read_file 读取。 */
  requireReadBeforeEdit?: boolean;
  /** apply 模式下，成功补丁必须由后续成功的固定 test 验证后才能完成。 */
  requirePostPatchTest?: boolean;
  /** 在工具执行前要求模型先给出计划，并等待本地人工确认。 */
  requirePlanApproval?: boolean;
  /** 仅在 planning 模型请求中附加，不写入后续消息历史。 */
  planningPrompt?: string;
  /** 固定验证真实失败后，最多允许一次经人工确认的修复循环。 */
  enableFailureRepair?: boolean;
  /**
   * 显式要求先运行一次固定验证；仅用于需要先复现真实失败的受控工作流，默认关闭。
   * 初始验证失败后，复用既有的人工确认失败修复流程。
   */
  initialProjectCheckAction?: ProjectCheckAction;
  systemPrompt?: string;
  executionMode?: ToolExecutionMode;
  requestEditApproval?: (request: EditApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestPlanApproval?: (request: PlanApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestRepairApproval?: (request: RepairApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestCommandApproval?: (request: CommandApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  auditLog?: AgentEventAuditLog;
  /**
   * 只读观察者：用于终端界面等展示层实时刷新，不参与工具权限、执行或审计决策。
   */
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_SYSTEM_PROMPT = [
  "你是一个运行在受控演示中的 Coding Agent。",
  "需要事实时必须调用工具，并将工具结果作为证据。",
  "不得编造工具结果。",
].join(" ");

const MAX_FINAL_ANSWER_REPAIRS = 1;
const MAX_SOURCE_EVIDENCE_READS = 2;
const MAX_SOURCE_EVIDENCE_SEARCHES_BEFORE_READ = 2;
const MAX_FAILURE_REPAIR_TOOL_CALLS = 3;
const MAX_POST_REPAIR_GIT_TOOL_CALLS = 2;

type FailureRepairState = "idle" | "planning" | "executing" | "post_repair" | "completed" | "final_only";
export type ProjectCheckAction = "test" | "check";

const FAILURE_REPAIR_DIRECTION_PROMPT = [
  "固定验证已真实执行并失败。下一轮是无工具的修复方向阶段。",
  "请基于最近的验证结果，只给出一份简短修复方向：失败原因判断、拟修改文件和复验动作。",
  "不要调用工具，不要声称已经修复；用户确认后才会恢复工具。",
].join(" ");

const FAILURE_REPAIR_EXHAUSTED_PROMPT = [
  "一次修复后的固定验证仍然失败，修复额度已用尽。",
  "下一轮不得调用工具；请基于已有证据总结当前未完成状态、最近验证结果和建议用户检查的事项。",
].join(" ");

const FAILURE_REPAIR_INCOMPLETE_PROMPT = [
  "一次修复的工具额度已用尽，或复验未成功执行；不得继续修改或再次运行验证。",
  "下一轮不得调用工具；请基于已有证据总结当前未完成状态和建议用户检查的事项。",
].join(" ");

const FAILURE_REPAIR_MISSING_PATCH_PROMPT = [
  "固定验证重跑已经通过，但本次修复阶段没有成功应用补丁，不能据此声称修复完成。",
  "下一轮不得继续修改或运行验证；请如实总结当前未完成状态，并提示用户检查是否存在偶发测试或外部状态变化。",
].join(" ");

type SourceEvidenceRejectionReason =
  | "missing_read_file_evidence"
  | "missing_source_citation"
  | "unverified_source_citation";

type SourceEvidenceValidation =
  | { ok: true }
  | { ok: false; reason: SourceEvidenceRejectionReason };

function normalizePositiveLimit(value: number | undefined, optionName: string): number {
  if (value === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${optionName} 必须是大于 0 的安全整数。`);
  }
  return value;
}

function addToLimit(value: number, increment: number): number {
  if (value === Number.MAX_SAFE_INTEGER) return value;
  return Math.min(Number.MAX_SAFE_INTEGER, value + increment);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SourceCitation {
  path: string;
  startLine: number;
  endLine: number;
}

function citationIsFullyVisible(citation: SourceCitation, evidence: SourceEvidence): boolean {
  if (
    evidence.path !== citation.path
    || citation.startLine > citation.endLine
    || citation.startLine < evidence.startLine
    || citation.endLine > evidence.endLine
  ) {
    return false;
  }
  return !(evidence.truncatedLines ?? []).some(
    (line) => line >= citation.startLine && line <= citation.endLine,
  );
}

function completeEvidenceRanges(evidence: SourceEvidence): SourceCitation[] {
  const truncated = new Set(evidence.truncatedLines ?? []);
  const ranges: SourceCitation[] = [];
  let rangeStart: number | undefined;
  for (let line = evidence.startLine; line <= evidence.endLine; line += 1) {
    if (truncated.has(line)) {
      if (rangeStart !== undefined) {
        ranges.push({ path: evidence.path, startLine: rangeStart, endLine: line - 1 });
        rangeStart = undefined;
      }
      continue;
    }
    rangeStart ??= line;
  }
  if (rangeStart !== undefined) {
    ranges.push({ path: evidence.path, startLine: rangeStart, endLine: evidence.endLine });
  }
  return ranges;
}

function citationsForEvidence(answer: string, evidence: SourceEvidence): SourceCitation[] {
  const citationPattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.\\-/\\\\])${escapeRegExp(evidence.path)}:(\\d+)(?:-(\\d+))?(?=$|[\\s\`)\\]，,.;:!?；。])`,
    "gu",
  );
  return Array.from(answer.matchAll(citationPattern), (match) => ({
    path: evidence.path,
    startLine: Number(match[1]),
    endLine: Number(match[2] ?? match[1]),
  }));
}

function citationLikeCandidates(answer: string, sourceEvidence: readonly SourceEvidence[]): SourceCitation[] {
  const candidates: SourceCitation[] = [];
  const inlineCodeRanges: Array<{ start: number; end: number }> = [];
  const inlineCodeCitationPattern = /`([^`\r\n]+):(\d+)(?:-(\d+))?`/gu;
  const compactCitationPattern = /(?<![\p{L}\p{N}_.\-/\\])([\p{L}\p{N}_./\\-]+\.[\p{L}\p{N}_-]+):(\d+)(?:-(\d+))?(?=$|[\s`)\]，,.;:!?；。])/gu;
  for (const match of answer.matchAll(inlineCodeCitationPattern)) {
    inlineCodeRanges.push({ start: match.index, end: match.index + match[0].length });
    if (!/[./\\]/u.test(match[1])) continue;
    candidates.push({
      path: match[1],
      startLine: Number(match[2]),
      endLine: Number(match[3] ?? match[2]),
    });
  }
  for (const match of answer.matchAll(compactCitationPattern)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (inlineCodeRanges.some((range) => matchStart >= range.start && matchEnd <= range.end)) continue;
    const lineSuffix = `${match[2]}${match[3] ? `-${match[3]}` : ""}`;
    const isSuffixOfKnownSpacedPath = sourceEvidence.some((evidence) => {
      if (!evidence.path.endsWith(match[1])) return false;
      const fullCitation = `${evidence.path}:${lineSuffix}`;
      return answer.slice(matchEnd - fullCitation.length, matchEnd) === fullCitation;
    });
    if (isSuffixOfKnownSpacedPath) continue;
    candidates.push({
      path: match[1],
      startLine: Number(match[2]),
      endLine: Number(match[3] ?? match[2]),
    });
  }
  return candidates;
}

function validateSourceEvidence(answer: string, sourceEvidence: readonly SourceEvidence[]): SourceEvidenceValidation {
  if (sourceEvidence.length === 0) {
    return { ok: false, reason: "missing_read_file_evidence" };
  }

  const citations = sourceEvidence.flatMap((evidence) => citationsForEvidence(answer, evidence));
  if (citations.length === 0) {
    return { ok: false, reason: "missing_source_citation" };
  }

  const allCitationCandidates = [...citations, ...citationLikeCandidates(answer, sourceEvidence)];
  const areAllCitationsVerified = allCitationCandidates.every((citation) => sourceEvidence.some(
    (evidence) => citationIsFullyVisible(citation, evidence),
  ));
  return areAllCitationsVerified
    ? { ok: true }
    : { ok: false, reason: "unverified_source_citation" };
}

function cancellationReason(): string {
  return "任务已取消，未继续调用模型、执行工具或修改文件。";
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error(cancellationReason()));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(cancellationReason()));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function formatSourceEvidence(sourceEvidence: readonly SourceEvidence[]): string {
  return [...new Set(sourceEvidence
    .flatMap(completeEvidenceRanges)
    .map((evidence) => {
      const citation = evidence.startLine === evidence.endLine
        ? `${evidence.path}:${evidence.startLine}`
        : `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
      return `\`${citation}\``;
    }))]
    .join("、");
}

function sourceEvidenceRepairMessage(
  reason: SourceEvidenceRejectionReason,
  sourceEvidence: readonly SourceEvidence[],
): string {
  const reasonText = {
    missing_read_file_evidence: "尚未成功读取任何源码文件。",
    missing_source_citation: "最终回答缺少 `path:line` 格式的源码引用。",
    unverified_source_citation: "最终回答包含未在本轮已读取范围内的源码引用。",
  }[reason];
  const formattedEvidence = formatSourceEvidence(sourceEvidence);
  const evidenceText = formattedEvidence === ""
    ? "暂无已验证源码范围。"
    : `可直接复制的已验证引用：${formattedEvidence}。`;
  return [
    `你的上一条最终回答未通过本地源码证据校验：${reasonText}`,
    evidenceText,
    "本次为无工具修复轮；删除上一版中的全部源码引用，至少原样使用一条上面的引用。引用可以是 `path:line` 或 `path:startLine-endLine`，不得输出清单外的任何源码路径或行号。",
    "不得请求工具，不要引用 README、agent.md 或未读取文件来证明实现机制；若原结论需要未读取源码支持，应删去该结论。",
  ].join(" ");
}

function appendSourceEvidence(target: SourceEvidence[], sourceEvidence: readonly SourceEvidence[] | undefined): void {
  for (const evidence of sourceEvidence ?? []) {
    const alreadyRecorded = target.some(
      (existing) =>
        existing.path === evidence.path &&
        existing.startLine === evidence.startLine &&
        existing.endLine === evidence.endLine &&
        JSON.stringify(existing.truncatedLines ?? []) === JSON.stringify(evidence.truncatedLines ?? []),
    );
    if (!alreadyRecorded) {
      target.push(evidence);
    }
  }
}

function normalizeWorkspacePath(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function patchTargetPath(toolCall: ToolCall): string | undefined {
  if (!toolCall.input || typeof toolCall.input !== "object" || Array.isArray(toolCall.input)) {
    return undefined;
  }
  const value = (toolCall.input as Record<string, JsonValue>).path;
  return typeof value === "string" ? normalizeWorkspacePath(value) : undefined;
}

function projectCheckAction(toolCall: ToolCall): string | undefined {
  if (!toolCall.input || typeof toolCall.input !== "object" || Array.isArray(toolCall.input)) {
    return undefined;
  }
  const value = (toolCall.input as Record<string, JsonValue>).action;
  return typeof value === "string" ? value : undefined;
}

function isExecutedProjectCheckFailure(result: ToolResultMessage): boolean {
  if (result.name !== "run_project_check" || result.status !== "error") return false;
  return result.metadata?.timedOut === true ||
    (typeof result.metadata?.exitCode === "number" && result.metadata.exitCode !== 0);
}

function isExecutedProjectCheckSuccess(result: ToolResultMessage): boolean {
  return result.name === "run_project_check" &&
    result.status === "success" &&
    result.metadata?.timedOut === false &&
    result.metadata.exitCode === 0;
}

function isExecutedProjectTestSuccess(result: ToolResultMessage): boolean {
  return isExecutedProjectCheckSuccess(result) && result.metadata?.action === "test";
}

function isExecutedProjectActionSuccess(
  result: ToolResultMessage,
  action: ProjectCheckAction,
): boolean {
  return isExecutedProjectCheckSuccess(result) && result.metadata?.action === action;
}

function isExecutedProjectAction(
  result: ToolResultMessage,
  action: ProjectCheckAction,
): boolean {
  if (result.name !== "run_project_check" || result.metadata?.action !== action) return false;
  return result.status === "success" ||
    result.metadata?.timedOut === true ||
    typeof result.metadata?.exitCode === "number";
}

export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  readonly #workspaceRoot: string;
  readonly #maxSteps: number;
  readonly #maxToolCallsPerStep: number;
  readonly #maxToolCalls: number;
  readonly #hardMaxModelRequests: number;
  readonly #hardMaxToolCalls: number;
  readonly #finalOnlyAfterToolBudget: boolean;
  readonly #requireSourceEvidence: boolean;
  readonly #requireReadBeforeEdit: boolean;
  readonly #requirePostPatchTest: boolean;
  readonly #requirePlanApproval: boolean;
  readonly #planningPrompt?: string;
  readonly #enableFailureRepair: boolean;
  readonly #initialProjectCheckAction?: ProjectCheckAction;
  readonly #systemPrompt: string;
  readonly #executionMode: ToolExecutionMode;
  readonly #requestEditApproval?: (request: EditApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  readonly #requestPlanApproval?: (request: PlanApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  readonly #requestRepairApproval?: (request: RepairApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  readonly #requestCommandApproval?: (request: CommandApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  readonly #auditLog?: AgentEventAuditLog;
  readonly #onEvent?: (event: AgentEvent) => void;

  constructor(
    model: ChatModel,
    tools: ToolRegistry,
    options: AgentLoopOptions,
  ) {
    this.model = model;
    this.tools = tools;
    this.#workspaceRoot = path.resolve(options.workspaceRoot);
    this.#maxSteps = normalizePositiveLimit(options.maxSteps ?? 6, "maxSteps");
    this.#maxToolCallsPerStep = normalizePositiveLimit(options.maxToolCallsPerStep, "maxToolCallsPerStep");
    const configuredMaxToolCalls = normalizePositiveLimit(options.maxToolCalls, "maxToolCalls");
    this.#hardMaxModelRequests = normalizePositiveLimit(
      options.hardMaxModelRequests ?? (options.requirePostPatchTest ? EDIT_HARD_MAX_MODEL_REQUESTS : undefined),
      "hardMaxModelRequests",
    );
    this.#hardMaxToolCalls = normalizePositiveLimit(
      options.hardMaxToolCalls ?? (options.requirePostPatchTest ? EDIT_HARD_MAX_ACCEPTED_TOOL_CALLS : undefined),
      "hardMaxToolCalls",
    );
    this.#maxToolCalls = Math.min(configuredMaxToolCalls, this.#hardMaxToolCalls);
    if (this.#hardMaxModelRequests < this.#maxSteps) {
      throw new Error("hardMaxModelRequests 不得小于 maxSteps。");
    }
    if (options.maxToolCalls !== undefined && this.#hardMaxToolCalls < configuredMaxToolCalls) {
      throw new Error("hardMaxToolCalls 不得小于 maxToolCalls。");
    }
    this.#finalOnlyAfterToolBudget = options.finalOnlyAfterToolBudget ?? false;
    this.#requireSourceEvidence = options.requireSourceEvidence ?? false;
    this.#requireReadBeforeEdit = options.requireReadBeforeEdit ?? false;
    this.#requirePostPatchTest = options.requirePostPatchTest ?? false;
    this.#requirePlanApproval = options.requirePlanApproval ?? false;
    this.#planningPrompt = options.planningPrompt;
    this.#enableFailureRepair = options.enableFailureRepair ?? false;
    this.#initialProjectCheckAction = options.initialProjectCheckAction;
    if (this.#initialProjectCheckAction !== undefined && !this.#enableFailureRepair) {
      throw new Error("initialProjectCheckAction 需要 enableFailureRepair=true。");
    }
    if (this.#initialProjectCheckAction !== undefined && !this.tools.find("run_project_check")) {
      throw new Error("initialProjectCheckAction 需要注册 run_project_check 工具。");
    }
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#executionMode = options.executionMode ?? "propose";
    this.#requestEditApproval = options.requestEditApproval;
    this.#requestPlanApproval = options.requestPlanApproval;
    this.#requestRepairApproval = options.requestRepairApproval;
    this.#requestCommandApproval = options.requestCommandApproval;
    this.#auditLog = options.auditLog;
    this.#onEvent = options.onEvent;
  }

  async run(task: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [
      { role: "system", content: this.#systemPrompt },
      ...(options.conversationHistory ?? []),
      { role: "user", content: task },
    ];
    const events = new InMemoryEventLog();
    const ledger = new WorkingLedger(task);
    let acceptedToolCalls = 0;
    let finalAnswerRepairs = 0;
    let sourceEvidenceRepairPending = false;
    let sourceEvidenceCompletionPending = false;
    let extraFinalOnlyTurnUsed = false;
    let successfulSourceReadCalls = 0;
    let sourceSearchCallsBeforeEvidence = 0;
    let supplementalSourceSearchUsed = false;
    let planApprovalPending = this.#requirePlanApproval;
    let repairState: FailureRepairState = "idle";
    let repairToolCalls = 0;
    let repairPatchUsed = false;
    let repairPatchSucceeded = false;
    let postRepairGitToolCalls = 0;
    let failedRepairAction: ProjectCheckAction = "test";
    let repairOriginalCheckRequired = false;
    let postPatchTestRequired = false;
    let initialProjectCheckRequired = this.#initialProjectCheckAction !== undefined;
    let sameTurnRecoveryStepGranted = false;
    // 受限验证 / Git 收尾阶段的一次本地拒绝，不能让可选收尾挤掉最终回答。
    // 恢复只跳过可选 Git，不增加任何工具额度，也只允许触发一次。
    let closeoutRecoveryUsed = false;
    let closeoutRecoveryAwaitingVerification = false;
    let closeoutRecoveryFinalOnly = false;
    let maximumStep = this.#maxSteps;
    let maximumToolCalls = this.#maxToolCalls;
    const extendModelRequestLimit = (value: number, increment: number): number =>
      Math.min(this.#hardMaxModelRequests, addToLimit(value, increment));
    const extendToolCallLimit = (value: number, increment: number): number =>
      Math.min(this.#hardMaxToolCalls, addToLimit(value, increment));
    const sourceEvidence: SourceEvidence[] = [];
    const readPaths = new Set<string>();

    try {
      for (let step = 1; step <= maximumStep; step += 1) {
        if (options.signal?.aborted) {
          const reason = cancellationReason();
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }
        const isSourceEvidenceRepairTurn = sourceEvidenceRepairPending;
        const isSourceEvidenceCompletionTurn = sourceEvidenceCompletionPending;
        sourceEvidenceRepairPending = false;
        sourceEvidenceCompletionPending = false;
        const isSourceEvidenceFinalTurn = isSourceEvidenceRepairTurn || isSourceEvidenceCompletionTurn;
        const isPlanningTurn = planApprovalPending;
        const isRepairPlanningTurn = repairState === "planning";
        const isRepairFinalTurn = repairState === "final_only";
        const isRepairCompletedTurn = repairState === "completed";
        const isCloseoutRecoveryFinalOnlyTurn = closeoutRecoveryFinalOnly;
        const isToolBudgetFinalTurn = this.#finalOnlyAfterToolBudget && acceptedToolCalls >= maximumToolCalls;
        const initialProjectCheckAction: ProjectCheckAction | undefined = initialProjectCheckRequired
          ? this.#initialProjectCheckAction
          : undefined;
        const mustVerifyPatchNow = this.#requirePostPatchTest && postPatchTestRequired && (
          repairState === "idle" || (repairState === "executing" && repairPatchSucceeded)
        );
        const requiredProjectCheckAction: ProjectCheckAction | undefined = initialProjectCheckAction ?? (
          mustVerifyPatchNow
            ? "test"
            : repairState === "executing" && repairOriginalCheckRequired
              ? failedRepairAction
              : undefined
        );
        const baseAvailableTools: ToolDescription[] = isPlanningTurn || isRepairPlanningTurn ||
          isRepairFinalTurn || isRepairCompletedTurn || isCloseoutRecoveryFinalOnlyTurn ||
          isSourceEvidenceFinalTurn || isToolBudgetFinalTurn
          ? []
          : this.getAvailableToolDescriptions(
              sourceEvidence,
              sourceSearchCallsBeforeEvidence,
              supplementalSourceSearchUsed,
            );
        const stateAvailableTools: ToolDescription[] = repairState === "executing"
          ? baseAvailableTools.filter((tool) =>
              tool.name === "read_file" ||
              (tool.name === "apply_patch" && !repairPatchUsed) ||
              tool.name === "run_project_check"
            )
          : repairState === "post_repair"
            ? baseAvailableTools.filter((tool) => tool.name === "inspect_git")
            : baseAvailableTools;
        const availableTools: ToolDescription[] = requiredProjectCheckAction
          ? stateAvailableTools.filter((tool) => tool.name === "run_project_check")
          : stateAvailableTools;
        const toolChoice: ForcedFunctionToolChoice | undefined =
          (this.#requireSourceEvidence || requiredProjectCheckAction !== undefined || repairState === "post_repair") &&
            availableTools.length === 1
          ? { type: "function" as const, name: availableTools[0].name }
          : undefined;
        const allowedToolNames: ReadonlySet<string> | undefined = this.#requireSourceEvidence ||
            requiredProjectCheckAction !== undefined || repairState === "executing" || repairState === "post_repair" ||
            isCloseoutRecoveryFinalOnlyTurn
          ? new Set(availableTools.map((tool) => tool.name))
          : undefined;
        this.recordEvent(events, {
          type: "model_requested",
          step,
          ...(toolChoice ? { forcedToolName: toolChoice.name } : {}),
        });
        let response: ModelResponse;
        try {
          const requestMessages: AgentMessage[] = this.#planningPrompt && isPlanningTurn
            ? [...messages, { role: "user", content: this.#planningPrompt }]
            : [...messages];
          response = await awaitWithAbort(this.model.complete({
            messages: requestMessages,
            tools: availableTools,
            workingState: ledger.render(),
            phase: isPlanningTurn ? "planning" : isRepairPlanningTurn ? "repair_planning" : "execution",
            ...(toolChoice ? { toolChoice } : {}),
          }, options.signal), options.signal);
        } catch (error) {
          const reason = options.signal?.aborted
            ? cancellationReason()
            : `模型请求失败：${error instanceof Error ? error.message : String(error)}`;
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        const rejectToolResponse = (reason: string): void => {
          if (response.kind !== "tool_calls") return;
          messages.push({
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls,
          });
          for (const toolCall of response.toolCalls) {
            messages.push(this.rejectToolCall(toolCall, step, events, reason));
          }
        };

        if (isRepairPlanningTurn) {
          if (response.kind !== "final") {
            const reason = "修复方向阶段不允许调用工具；请先给出可供用户确认的简短修复方向。";
            rejectToolResponse(reason);
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            throw new Error(reason);
          }

          this.recordEvent(events, {
            type: "repair_proposed",
            step,
            directionLength: response.content.length,
          });
          let approved = false;
          let rejectionReason = "用户未确认修复方向，未继续修改文件或运行验证。";
          if (options.signal?.aborted) {
            rejectionReason = cancellationReason();
          } else if (!this.#requestRepairApproval) {
            rejectionReason = "未配置本地修复方向确认，未继续修改文件或运行验证。";
          } else {
            try {
              approved = await awaitWithAbort(this.#requestRepairApproval({
                failedAction: failedRepairAction,
                direction: response.content,
                attempt: 1,
                maximumAttempts: 1,
              }, options.signal), options.signal) === true;
            } catch {
              rejectionReason = "本地修复方向确认不可用，未继续修改文件或运行验证。";
            }
          }
          if (options.signal?.aborted) {
            approved = false;
            rejectionReason = cancellationReason();
          }
          this.recordEvent(events, {
            type: "repair_decision",
            step,
            decision: approved ? "approved" : "rejected",
          });
          await this.#auditLog?.flush();
          messages.push({ role: "assistant", content: response.content });
          if (!approved) {
            this.recordEvent(events, { type: "agent_stopped", step, reason: rejectionReason });
            return {
              answer: rejectionReason,
              messages,
              events: events.events,
              workingState: ledger.render(),
              sourceEvidence,
            };
          }
          messages.push({
            role: "user",
            content: "修复方向已由用户确认。现在执行一次最小修复并复验；不得开启第二次修复循环。",
          });
          repairState = "executing";
          continue;
        }

        if (isRepairFinalTurn) {
          if (response.kind === "tool_calls") {
            const reason = "一次修复复验仍失败，本轮只能总结未完成状态，不能继续请求工具。";
            rejectToolResponse(reason);
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            throw new Error(reason);
          }

          const reason = "一次有界修复未成功完成，任务以未完成状态停止。";
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          return {
            answer: `${reason}\n\n${response.content}`,
            messages,
            events: events.events,
            workingState: ledger.render(),
            sourceEvidence,
          };
        }

        if (isRepairCompletedTurn && response.kind === "tool_calls") {
          const reason = "修复复验与 Git 收尾额度已经完成，本轮只能给出最终回答。";
          rejectToolResponse(reason);
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isCloseoutRecoveryFinalOnlyTurn && response.kind === "tool_calls") {
          const reason = "受限阶段的本地拒绝后，已跳过可选 Git 收尾；本轮只能给出最终回答。";
          rejectToolResponse(reason);
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isSourceEvidenceFinalTurn && response.kind === "tool_calls") {
          const reason = isSourceEvidenceRepairTurn
            ? "源码证据修复轮只能给出最终回答，不能请求工具。"
            : "源码取证已收集足够证据，本轮只能给出最终回答，不能请求工具。";
          rejectToolResponse(reason);
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isToolBudgetFinalTurn && response.kind === "tool_calls") {
          const reason = "工具预算已耗尽，本轮只能给出最终回答，不能继续请求工具。";
          rejectToolResponse(reason);
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isPlanningTurn) {
          if (response.kind !== "final") {
            const reason = "计划阶段不允许调用工具；请先给出可供用户确认的简短计划。";
            rejectToolResponse(reason);
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            throw new Error(reason);
          }
          this.recordEvent(events, { type: "plan_proposed", step, planLength: response.content.length });
          let approved = false;
          let rejectionReason = "用户未确认计划，未执行工具或修改文件。";
          if (options.signal?.aborted) {
            rejectionReason = cancellationReason();
          } else if (!this.#requestPlanApproval) {
            rejectionReason = "已启用计划确认，但没有可用的本地确认回调，未执行工具或修改文件。";
          } else {
            try {
              approved = await awaitWithAbort(
                this.#requestPlanApproval({ plan: response.content }, options.signal),
                options.signal,
              ) === true;
              if (options.signal?.aborted) {
                approved = false;
                rejectionReason = cancellationReason();
              }
            } catch {
              rejectionReason = options.signal?.aborted
                ? cancellationReason()
                : "本地计划确认不可用，未执行工具或修改文件。";
            }
          }
          this.recordEvent(events, {
            type: "plan_decision",
            step,
            decision: approved ? "approved" : "rejected",
          });
          await this.#auditLog?.flush();
          messages.push({ role: "assistant", content: response.content });
          if (!approved) {
            this.recordEvent(events, { type: "agent_stopped", step, reason: rejectionReason });
            return {
              answer: rejectionReason,
              messages,
              events: events.events,
              workingState: ledger.render(),
              sourceEvidence,
            };
          }

          messages.push({ role: "user", content: "计划已由用户确认。现在开始执行；仅在必要时调用已注册工具。" });
          planApprovalPending = false;
          maximumStep = extendModelRequestLimit(maximumStep, 1);
          continue;
        }

        if (response.kind === "final" && initialProjectCheckAction !== undefined) {
          const reason = `尚未执行初始 run_project_check(${initialProjectCheckAction}) 复现当前状态，任务以未完成状态停止。`;
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          return {
            answer: reason,
            messages,
            events: events.events,
            workingState: ledger.render(),
            sourceEvidence,
          };
        }

        if (repairState === "executing" && response.kind === "final") {
          const reason = "修复尚未完成成功复验，任务以未完成状态停止。";
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          return {
            answer: reason,
            messages,
            events: events.events,
            workingState: ledger.render(),
            sourceEvidence,
          };
        }

        if (response.kind === "final" && postPatchTestRequired) {
          const reason = "补丁尚未通过后续 run_project_check(test) 验证，任务以未完成状态停止。";
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          return {
            answer: reason,
            messages,
            events: events.events,
            workingState: ledger.render(),
            sourceEvidence,
          };
        }

        if (response.kind === "final") {
          const sourceEvidenceValidation: SourceEvidenceValidation = this.#requireSourceEvidence
            ? validateSourceEvidence(response.content, sourceEvidence)
            : { ok: true };
          if (!sourceEvidenceValidation.ok) {
            messages.push({ role: "assistant", content: response.content });
            this.recordEvent(events, {
              type: "final_answer_rejected",
              step,
              reason: sourceEvidenceValidation.reason,
              sourceEvidenceCount: sourceEvidence.length,
            });
            if (sourceEvidenceValidation.reason === "missing_read_file_evidence") {
              const reason = "最终回答缺少已读取源码，无法进行无工具修复。";
              this.recordEvent(events, { type: "agent_stopped", step, reason });
              throw new Error(reason);
            }
            if (finalAnswerRepairs >= MAX_FINAL_ANSWER_REPAIRS) {
              const reason = "最终回答连续两次未通过源码证据校验。";
              this.recordEvent(events, { type: "agent_stopped", step, reason });
              throw new Error(reason);
            }
            if (step === maximumStep && extraFinalOnlyTurnUsed) {
              const reason = "最终回答未通过源码证据校验，且额外无工具回答轮次已用尽。";
              this.recordEvent(events, { type: "agent_stopped", step, reason });
              throw new Error(reason);
            }
            finalAnswerRepairs += 1;
            sourceEvidenceRepairPending = true;
            if (step === maximumStep) {
              extraFinalOnlyTurnUsed = true;
              maximumStep = extendModelRequestLimit(maximumStep, 1);
            }
            messages.push({
              role: "user",
              content: sourceEvidenceRepairMessage(sourceEvidenceValidation.reason, sourceEvidence),
            });
            continue;
          }
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_completed", step });
          return {
            answer: response.content,
            messages,
            events: events.events,
            workingState: ledger.render(),
            sourceEvidence,
          };
        }

        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });

        let remainingToolCallBlockReason: string | undefined;
        const deferredRuntimeMessages: string[] = [];
        for (const [toolCallIndex, toolCall] of response.toolCalls.entries()) {
          const rejectedForCancellation = options.signal?.aborted === true;
          const localPolicyCheckBeforeCall = remainingToolCallBlockReason === undefined;
          const rejectionReason: string | undefined = remainingToolCallBlockReason ?? (
            rejectedForCancellation
              ? cancellationReason()
              : this.getToolCallRejectionReason(
                  toolCall,
                  toolCallIndex,
                  acceptedToolCalls,
                  maximumToolCalls,
                  allowedToolNames,
                  readPaths,
                  requiredProjectCheckAction,
                  initialProjectCheckAction,
                )
          );
          const result: ToolResultMessage = rejectionReason
            ? this.rejectToolCall(
                toolCall,
                step,
                events,
                rejectionReason,
                rejectedForCancellation ? { cancelled: true } : undefined,
              )
            : await this.executeToolCall(toolCall, task, step, events, options.signal);
          if (!rejectionReason) {
            acceptedToolCalls += 1;
            if (repairState === "executing") {
              repairToolCalls += 1;
              if (result.name === "apply_patch") {
                repairPatchUsed = true;
                if (result.status === "success") repairPatchSucceeded = true;
              }
            } else if (repairState === "post_repair") {
              postRepairGitToolCalls += 1;
            }
          }
          if (
            rejectionReason?.includes("maxToolCallsPerStep=") &&
            step === maximumStep &&
            !sameTurnRecoveryStepGranted &&
            acceptedToolCalls < maximumToolCalls
          ) {
            sameTurnRecoveryStepGranted = true;
            maximumStep = extendModelRequestLimit(maximumStep, 1);
          }
          if (
            rejectionReason !== undefined &&
            !rejectedForCancellation &&
            localPolicyCheckBeforeCall &&
            !closeoutRecoveryUsed &&
            (
              (requiredProjectCheckAction !== undefined && initialProjectCheckAction === undefined) ||
              repairState === "post_repair"
            )
          ) {
            closeoutRecoveryUsed = true;
            if (requiredProjectCheckAction !== undefined) {
              closeoutRecoveryAwaitingVerification = true;
              maximumStep = Math.min(
                this.#hardMaxModelRequests,
                Math.max(maximumStep, addToLimit(step, 2)),
              );
              deferredRuntimeMessages.push(
                "上一条工具请求未通过本地阶段校验。下一轮仍只能执行当前固定验证；验证成功后将跳过可选 Git 收尾，并在无工具轮给出最终回答。",
              );
            } else {
              closeoutRecoveryFinalOnly = true;
              maximumStep = Math.min(
                this.#hardMaxModelRequests,
                Math.max(maximumStep, addToLimit(step, 1)),
              );
              deferredRuntimeMessages.push(
                "上一条 Git 收尾工具请求未通过本地阶段校验。修复和验证已完成；将跳过剩余可选 Git 收尾，下一轮只能给出最终回答。",
              );
            }
          }
          if (
            !rejectionReason &&
            this.#requirePostPatchTest &&
            result.name === "apply_patch" &&
            result.status === "success"
          ) {
            postPatchTestRequired = true;
            remainingToolCallBlockReason ??=
              "补丁已成功应用；必须在下一模型轮执行固定 test，本轮其余工具调用不会执行。";
            const postPatchExtraToolCalls = repairState === "executing"
              ? 1
              : MAX_POST_REPAIR_GIT_TOOL_CALLS + 1;
            const postPatchExtraModelRequests = repairState === "executing"
              ? 1
              : MAX_POST_REPAIR_GIT_TOOL_CALLS + 2;
            maximumToolCalls = Math.min(
              this.#hardMaxToolCalls,
              Math.max(maximumToolCalls, addToLimit(acceptedToolCalls, postPatchExtraToolCalls)),
            );
            maximumStep = Math.min(
              this.#hardMaxModelRequests,
              Math.max(maximumStep, addToLimit(step, postPatchExtraModelRequests)),
            );
          }
          const hadSourceEvidence = sourceEvidence.length > 0;
          messages.push(result);
          appendSourceEvidence(sourceEvidence, result.sourceEvidence);
          if (result.name === "read_file" && result.status === "success") {
            for (const evidence of result.sourceEvidence ?? []) {
              readPaths.add(normalizeWorkspacePath(evidence.path));
            }
          }
          if (this.#requireSourceEvidence && !rejectionReason && result.name === "search_text") {
            if (hadSourceEvidence) {
              supplementalSourceSearchUsed = true;
            } else {
              sourceSearchCallsBeforeEvidence += 1;
            }
          }
          if (
            this.#requireSourceEvidence &&
            result.name === "read_file" &&
            result.status === "success" &&
            (result.sourceEvidence?.length ?? 0) > 0
          ) {
            successfulSourceReadCalls += 1;
            if (successfulSourceReadCalls >= MAX_SOURCE_EVIDENCE_READS || step === maximumStep) {
              sourceEvidenceCompletionPending = true;
              if (step === maximumStep && !extraFinalOnlyTurnUsed) {
                extraFinalOnlyTurnUsed = true;
                maximumStep = extendModelRequestLimit(maximumStep, 1);
              }
            }
          }
          ledger.record({
            toolName: result.name,
            status: result.status,
            summary: result.content,
          });
          if (
            !rejectionReason &&
            initialProjectCheckAction !== undefined &&
            isExecutedProjectAction(result, initialProjectCheckAction)
          ) {
            initialProjectCheckRequired = false;
          }
          if (this.#enableFailureRepair && !rejectionReason) {
            if (repairState === "idle" && isExecutedProjectCheckFailure(result)) {
              failedRepairAction = result.metadata?.action === "check" ? "check" : "test";
              repairOriginalCheckRequired = false;
              repairState = "planning";
              maximumToolCalls = extendToolCallLimit(
                maximumToolCalls,
                MAX_FAILURE_REPAIR_TOOL_CALLS + MAX_POST_REPAIR_GIT_TOOL_CALLS,
              );
              maximumStep = Math.min(
                this.#hardMaxModelRequests,
                Math.max(
                  addToLimit(maximumStep, 1),
                  addToLimit(
                    step,
                    MAX_FAILURE_REPAIR_TOOL_CALLS + MAX_POST_REPAIR_GIT_TOOL_CALLS + 2,
                  ),
                ),
              );
              deferredRuntimeMessages.push(FAILURE_REPAIR_DIRECTION_PROMPT);
              remainingToolCallBlockReason = "验证失败后必须先确认修复方向；本轮其余工具调用不会执行。";
            } else if (repairState === "executing" && result.name === "run_project_check") {
              if (!repairPatchSucceeded && isExecutedProjectCheckSuccess(result)) {
                repairState = "final_only";
                deferredRuntimeMessages.push(FAILURE_REPAIR_MISSING_PATCH_PROMPT);
                remainingToolCallBlockReason = "没有成功应用修复补丁，不能把重跑通过视为修复完成。";
              } else if (
                repairPatchSucceeded &&
                postPatchTestRequired &&
                isExecutedProjectTestSuccess(result) &&
                failedRepairAction === "check"
              ) {
                repairOriginalCheckRequired = true;
                remainingToolCallBlockReason =
                  "修复补丁的固定 test 已通过；还必须在下一模型轮重跑原失败的 check。";
              } else {
                const successfulRepairVerification = repairPatchSucceeded && (
                  postPatchTestRequired
                    ? isExecutedProjectTestSuccess(result)
                    : repairOriginalCheckRequired
                      ? isExecutedProjectActionSuccess(result, failedRepairAction)
                      : isExecutedProjectCheckSuccess(result)
                );
                if (successfulRepairVerification) {
                  repairOriginalCheckRequired = false;
                  repairState = "post_repair";
                  maximumToolCalls = Math.min(
                    this.#hardMaxToolCalls,
                    Math.max(maximumToolCalls, addToLimit(acceptedToolCalls, MAX_POST_REPAIR_GIT_TOOL_CALLS)),
                  );
                  maximumStep = Math.min(
                    this.#hardMaxModelRequests,
                    Math.max(maximumStep, addToLimit(step, MAX_POST_REPAIR_GIT_TOOL_CALLS + 1)),
                  );
                  remainingToolCallBlockReason = "修复补丁已成功复验；本轮其余工具调用不会执行。";
                } else {
                  repairState = "final_only";
                  deferredRuntimeMessages.push(
                    isExecutedProjectCheckFailure(result)
                      ? FAILURE_REPAIR_EXHAUSTED_PROMPT
                      : FAILURE_REPAIR_INCOMPLETE_PROMPT,
                  );
                  remainingToolCallBlockReason = "一次修复的复验未成功；本轮其余工具调用不会执行。";
                }
              }
              if (step === maximumStep) maximumStep = extendModelRequestLimit(maximumStep, 1);
            } else if (
              repairState === "executing" &&
              repairToolCalls >= MAX_FAILURE_REPAIR_TOOL_CALLS &&
              !(
                this.#requirePostPatchTest &&
                repairPatchSucceeded &&
                (postPatchTestRequired || repairOriginalCheckRequired)
              )
            ) {
              repairState = "final_only";
              if (step === maximumStep) maximumStep = extendModelRequestLimit(maximumStep, 1);
              deferredRuntimeMessages.push(FAILURE_REPAIR_INCOMPLETE_PROMPT);
              remainingToolCallBlockReason = "一次修复的工具上限已用尽；本轮其余工具调用不会执行。";
            }
          }
          if (!rejectionReason && postPatchTestRequired && isExecutedProjectTestSuccess(result)) {
            postPatchTestRequired = false;
          }
          if (
            closeoutRecoveryAwaitingVerification &&
            !postPatchTestRequired &&
            !repairOriginalCheckRequired
          ) {
            closeoutRecoveryAwaitingVerification = false;
            closeoutRecoveryFinalOnly = true;
            maximumStep = Math.min(
              this.#hardMaxModelRequests,
              Math.max(maximumStep, addToLimit(step, 1)),
            );
          }
          if (repairState === "post_repair" && postRepairGitToolCalls >= MAX_POST_REPAIR_GIT_TOOL_CALLS) {
            repairState = "completed";
            remainingToolCallBlockReason = "Git 收尾工具额度已用尽；本轮其余工具调用不会执行。";
          }
          if (options.signal?.aborted) {
            remainingToolCallBlockReason = cancellationReason();
          }
        }
        for (const content of deferredRuntimeMessages) {
          messages.push({ role: "user", content });
        }
        if (options.signal?.aborted) {
          const reason = cancellationReason();
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }
      }

      const reason = `达到最大步数 maxSteps=${maximumStep}，但模型尚未给出最终回答。`;
      this.recordEvent(events, { type: "agent_stopped", step: maximumStep, reason });
      throw new Error(reason);
    } finally {
      await this.#auditLog?.flush();
    }
  }

  private getAvailableToolDescriptions(
    sourceEvidence: readonly SourceEvidence[],
    sourceSearchCallsBeforeEvidence: number,
    supplementalSourceSearchUsed: boolean,
  ) {
    const descriptions = this.tools.describe();
    if (!this.#requireSourceEvidence) {
      return descriptions;
    }

    const sourceTools = descriptions.filter(
      (tool) => tool.name === "search_text" || tool.name === "read_file",
    );
    if (sourceEvidence.length === 0) {
      return sourceSearchCallsBeforeEvidence >= MAX_SOURCE_EVIDENCE_SEARCHES_BEFORE_READ
        ? sourceTools.filter((tool) => tool.name === "read_file")
        : sourceTools;
    }
    return supplementalSourceSearchUsed
      ? sourceTools.filter((tool) => tool.name === "read_file")
      : sourceTools;
  }

  private getToolCallRejectionReason(
    toolCall: ToolCall,
    toolCallIndex: number,
    acceptedToolCalls: number,
    maximumToolCalls: number,
    allowedToolNames: ReadonlySet<string> | undefined,
    readPaths: ReadonlySet<string>,
    requiredProjectCheckAction: ProjectCheckAction | undefined,
    initialProjectCheckAction: ProjectCheckAction | undefined,
  ): string | undefined {
    if (requiredProjectCheckAction) {
      if (toolCall.name !== "run_project_check") {
        return `当前阶段必须先执行固定 run_project_check(${requiredProjectCheckAction})，当前工具不会执行。`;
      }
      if (projectCheckAction(toolCall) !== requiredProjectCheckAction) {
        if (initialProjectCheckAction !== undefined) {
          return `任务要求先执行初始 run_project_check(${initialProjectCheckAction})；当前调用不会执行。`;
        }
        return requiredProjectCheckAction === "test"
          ? "补丁成功后的固定验证只接受 run_project_check 的 test 动作；当前调用不会执行。"
          : "原失败动作的复验只接受 run_project_check 的 check 动作；当前调用不会执行。";
      }
    }
    if (allowedToolNames && !allowedToolNames.has(toolCall.name)) {
      return this.#requireSourceEvidence
        ? "源码取证状态不允许该工具；请按当前阶段继续定位、读取或给出最终回答。"
        : "当前有界失败修复阶段不允许该工具；请完成一次最小修复、复验、Git 收尾或给出最终回答。";
    }
    if (toolCallIndex >= this.#maxToolCallsPerStep) {
      return `本轮工具调用超过上限 maxToolCallsPerStep=${this.#maxToolCallsPerStep}；该调用未执行，请在下一模型轮只重新请求一个仍然必要的工具，不要据此声称任务完成。`;
    }
    if (acceptedToolCalls >= maximumToolCalls) {
      return `本次任务已达到工具调用上限 maxToolCalls=${maximumToolCalls}；请基于已有结果给出最终回答。`;
    }
    if (this.#requireReadBeforeEdit && toolCall.name === "apply_patch") {
      const targetPath = patchTargetPath(toolCall);
      if (targetPath && !readPaths.has(targetPath)) {
        return `修改前必须先用 read_file 成功读取目标文件：${targetPath}。`;
      }
    }
    return undefined;
  }

  private rejectToolCall(
    toolCall: ToolCall,
    step: number,
    events: InMemoryEventLog,
    reason: string,
    metadata?: ToolExecutionMetadata,
  ): ToolResultMessage {
    this.recordEvent(events, {
      type: "tool_call",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return this.finalizeError(events, step, toolCall, reason, metadata);
  }

  private async executeToolCall(
    toolCall: ToolCall,
    task: string,
    step: number,
    events: InMemoryEventLog,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    this.recordEvent(events, {
      type: "tool_call",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    const tool = this.tools.find(toolCall.name);
    if (!tool) {
      return this.finalizeError(
        events,
        step,
        toolCall,
        `未知工具：${toolCall.name}`,
      );
    }

    let validation;
    try {
      validation = tool.validate(toolCall.input as JsonValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.finalizeError(events, step, toolCall, `工具参数校验失败：${message}`);
    }
    if (!validation.ok) {
      return this.finalizeError(events, step, toolCall, validation.error);
    }

    let preparedCommandExecution: PreparedCommandExecution | undefined;
    if (tool.prepareCommandExecution || tool.getCommandApprovalRequest) {
      let request: CommandApprovalRequest;
      try {
        if (tool.prepareCommandExecution) {
          preparedCommandExecution = await tool.prepareCommandExecution(
            validation.value,
            this.#workspaceRoot,
          );
          request = preparedCommandExecution.approvalRequest;
        } else {
          request = await tool.getCommandApprovalRequest!(validation.value, this.#workspaceRoot);
        }
      } catch (error) {
        if (error instanceof ToolPolicyError) {
          this.recordEvent(events, {
            type: "policy_decision",
            step,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ...error.decision,
          });
          return this.finalizeError(events, step, toolCall, error.message, error.metadata);
        }
        return this.finalizeError(
          events,
          step,
          toolCall,
          "无法生成本地命令确认，命令未执行。",
        );
      }
      const approvalAction = request.action;
      this.recordEvent(events, {
        type: "command_approval_requested",
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        action: approvalAction,
        commandKind: request.kind,
        riskLevel: request.riskLevel,
      });
      await this.#auditLog?.flush();

      let approved = false;
      const approvalTarget = request.kind === "verification" ? "固定验证动作" : "受控命令";
      let rejectionReason = `用户已取消${approvalTarget}，未执行命令。`;
      if (signal?.aborted) {
        rejectionReason = cancellationReason();
      } else if (!this.#requestCommandApproval) {
        rejectionReason = `未配置本地命令确认，${approvalTarget}未执行。`;
      } else {
        try {
          approved = await awaitWithAbort(
            this.#requestCommandApproval(request, signal),
            signal,
          ) === true;
        } catch {
          rejectionReason = `本地命令确认不可用，${approvalTarget}未执行。`;
        }
      }
      if (signal?.aborted) {
        approved = false;
        rejectionReason = cancellationReason();
      }
      this.recordEvent(events, {
        type: "command_approval_decision",
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        action: approvalAction,
        commandKind: request.kind,
        riskLevel: request.riskLevel,
        decision: approved ? "approved" : "rejected",
      });
      await this.#auditLog?.flush();
      if (!approved) {
        return this.finalizeError(events, step, toolCall, rejectionReason, {
          action: approvalAction,
          riskLevel: request.riskLevel,
          ...(signal?.aborted ? { cancelled: true } : {}),
        });
      }
    }

    if (signal?.aborted) {
      return this.finalizeError(events, step, toolCall, cancellationReason(), { cancelled: true });
    }

    this.recordEvent(events, {
      type: "tool_execution_started",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    await this.#auditLog?.flush();

    try {
      const executionContext: ToolExecutionContext = {
        task,
        step,
        workspaceRoot: this.#workspaceRoot,
        signal,
        requireSourceEvidence: this.#requireSourceEvidence,
        executionMode: this.#executionMode,
        requestEditApproval: this.#requestEditApproval
          ? async (request) => {
              this.recordEvent(events, {
                type: "edit_approval_requested",
                step,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                path: request.path,
                previewLength: request.preview.length,
              });
              await this.#auditLog?.flush();
              let approved = false;
              if (!signal?.aborted) {
                try {
                  approved = await awaitWithAbort(
                    this.#requestEditApproval!(request, signal),
                    signal,
                  ) === true;
                } catch {
                  approved = false;
                }
              }
              if (signal?.aborted) approved = false;
              this.recordEvent(events, {
                type: "edit_approval_decision",
                step,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                path: request.path,
                decision: approved ? "approved" : "rejected",
              });
              await this.#auditLog?.flush();
              return approved;
            }
          : undefined,
        recordPolicyDecision: (decision) => {
          this.recordEvent(events, {
            type: "policy_decision",
            step,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ...decision,
          });
        },
      };
      const execution = preparedCommandExecution
        ? await preparedCommandExecution.execute(executionContext)
        : await tool.execute(validation.value, executionContext);
      const output: ToolExecutionOutput = typeof execution === "string" ? { content: execution } : execution;
      this.recordEvent(events, {
        type: "tool_finalized",
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "success",
        detail: output.content,
        metadata: output.metadata,
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        name: toolCall.name,
        status: "success",
        content: output.content,
        ...(output.metadata ? { metadata: output.metadata } : {}),
        ...(output.sourceEvidence ? { sourceEvidence: output.sourceEvidence } : {}),
      };
    } catch (error) {
      if (error instanceof ToolPolicyError) {
        this.recordEvent(events, {
          type: "policy_decision",
          step,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ...error.decision,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      const baseMetadata = error instanceof ToolExecutionError ? error.metadata : undefined;
      const metadata = signal?.aborted ? { ...baseMetadata, cancelled: true } : baseMetadata;
      return this.finalizeError(events, step, toolCall, `工具执行失败：${message}`, metadata);
    }
  }

  private finalizeError(
    events: InMemoryEventLog,
    step: number,
    toolCall: ToolCall,
    content: string,
    metadata?: ToolExecutionMetadata,
  ): ToolResultMessage {
    this.recordEvent(events, {
      type: "tool_finalized",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: "error",
      detail: content,
      ...(metadata ? { metadata } : {}),
    });
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      status: "error",
      content,
      ...(metadata ? { metadata } : {}),
    };
  }

  private recordEvent(events: InMemoryEventLog, event: AgentEvent): void {
    events.record(event);
    this.#auditLog?.record(event);
    try {
      this.#onEvent?.(event);
    } catch {
      // 展示层故障不能改变 Agent 的执行、事件或审计语义。
    }
  }
}
