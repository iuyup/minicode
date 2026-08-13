import { ToolExecutionError } from "./contracts.ts";
import type {
  AgentMessage,
  ChatModel,
  ConversationMessage,
  EditApprovalRequest,
  PlanApprovalRequest,
  JsonValue,
  ModelResponse,
  ToolCall,
  ToolExecutionMode,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ToolResultMessage,
  SourceEvidence,
} from "./contracts.ts";
import path from "node:path";
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
}

export interface AgentLoopOptions {
  workspaceRoot: string;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  maxToolCalls?: number;
  requireSourceEvidence?: boolean;
  /** 编辑模式下，补丁目标必须已由本轮成功的 read_file 读取。 */
  requireReadBeforeEdit?: boolean;
  /** 在工具执行前要求模型先给出计划，并等待本地人工确认。 */
  requirePlanApproval?: boolean;
  systemPrompt?: string;
  executionMode?: ToolExecutionMode;
  requestEditApproval?: (request: EditApprovalRequest) => Promise<boolean>;
  requestPlanApproval?: (request: PlanApprovalRequest) => Promise<boolean>;
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

type SourceEvidenceRejectionReason =
  | "missing_read_file_evidence"
  | "missing_source_citation"
  | "unverified_source_citation";

type SourceEvidenceValidation =
  | { ok: true }
  | { ok: false; reason: SourceEvidenceRejectionReason };

const SOURCE_CITATION_PATTERN = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md)):(\d+)(?:-(\d+))?(?=$|[\s`)\]，,.;:!?；。])/gm;

function normalizePositiveLimit(value: number | undefined, optionName: string): number {
  if (value === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${optionName} 必须是大于 0 的安全整数。`);
  }
  return value;
}

function validateSourceEvidence(answer: string, sourceEvidence: readonly SourceEvidence[]): SourceEvidenceValidation {
  if (sourceEvidence.length === 0) {
    return { ok: false, reason: "missing_read_file_evidence" };
  }

  const citations = Array.from(answer.matchAll(SOURCE_CITATION_PATTERN), (match) => ({
    path: match[1],
    startLine: Number(match[2]),
    endLine: Number(match[3] ?? match[2]),
  }));
  if (citations.length === 0) {
    return { ok: false, reason: "missing_source_citation" };
  }

  const areAllCitationsVerified = citations.every((citation) => sourceEvidence.some(
    (evidence) =>
      evidence.path === citation.path &&
      citation.startLine <= citation.endLine &&
      citation.startLine >= evidence.startLine &&
      citation.endLine <= evidence.endLine,
  ));
  return areAllCitationsVerified
    ? { ok: true }
    : { ok: false, reason: "unverified_source_citation" };
}

function formatSourceEvidence(sourceEvidence: readonly SourceEvidence[]): string {
  return sourceEvidence
    .map((evidence) => {
      const citation = evidence.startLine === evidence.endLine
        ? `${evidence.path}:${evidence.startLine}`
        : `${evidence.path}:${evidence.startLine}-${evidence.endLine}`;
      return `\`${citation}\``;
    })
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
  const evidenceText = sourceEvidence.length === 0
    ? "暂无已验证源码范围。"
    : `可直接复制的已验证引用：${formatSourceEvidence(sourceEvidence)}。`;
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
        existing.endLine === evidence.endLine,
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

export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  readonly #workspaceRoot: string;
  readonly #maxSteps: number;
  readonly #maxToolCallsPerStep: number;
  readonly #maxToolCalls: number;
  readonly #requireSourceEvidence: boolean;
  readonly #requireReadBeforeEdit: boolean;
  readonly #requirePlanApproval: boolean;
  readonly #systemPrompt: string;
  readonly #executionMode: ToolExecutionMode;
  readonly #requestEditApproval?: (request: EditApprovalRequest) => Promise<boolean>;
  readonly #requestPlanApproval?: (request: PlanApprovalRequest) => Promise<boolean>;
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
    this.#maxSteps = options.maxSteps ?? 6;
    this.#maxToolCallsPerStep = normalizePositiveLimit(options.maxToolCallsPerStep, "maxToolCallsPerStep");
    this.#maxToolCalls = normalizePositiveLimit(options.maxToolCalls, "maxToolCalls");
    this.#requireSourceEvidence = options.requireSourceEvidence ?? false;
    this.#requireReadBeforeEdit = options.requireReadBeforeEdit ?? false;
    this.#requirePlanApproval = options.requirePlanApproval ?? false;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#executionMode = options.executionMode ?? "propose";
    this.#requestEditApproval = options.requestEditApproval;
    this.#requestPlanApproval = options.requestPlanApproval;
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
    let maximumStep = this.#maxSteps;
    const sourceEvidence: SourceEvidence[] = [];
    const readPaths = new Set<string>();

    try {
      for (let step = 1; step <= maximumStep; step += 1) {
        const isSourceEvidenceRepairTurn = sourceEvidenceRepairPending;
        const isSourceEvidenceCompletionTurn = sourceEvidenceCompletionPending;
        sourceEvidenceRepairPending = false;
        sourceEvidenceCompletionPending = false;
        const isSourceEvidenceFinalTurn = isSourceEvidenceRepairTurn || isSourceEvidenceCompletionTurn;
        const isPlanningTurn = planApprovalPending;
        const availableTools = isPlanningTurn || isSourceEvidenceFinalTurn
          ? []
          : this.getAvailableToolDescriptions(
              sourceEvidence,
              sourceSearchCallsBeforeEvidence,
              supplementalSourceSearchUsed,
            );
        const toolChoice = this.#requireSourceEvidence && availableTools.length === 1
          ? { type: "function" as const, name: availableTools[0].name }
          : undefined;
        const allowedToolNames = this.#requireSourceEvidence
          ? new Set(availableTools.map((tool) => tool.name))
          : undefined;
        this.recordEvent(events, {
          type: "model_requested",
          step,
          ...(toolChoice ? { forcedToolName: toolChoice.name } : {}),
        });
        let response: ModelResponse;
        try {
          response = await this.model.complete({
            messages,
            tools: availableTools,
            workingState: ledger.render(),
            phase: isPlanningTurn ? "planning" : "execution",
            ...(toolChoice ? { toolChoice } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = `模型请求失败：${message}`;
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isSourceEvidenceFinalTurn && response.kind === "tool_calls") {
          const reason = isSourceEvidenceRepairTurn
            ? "源码证据修复轮只能给出最终回答，不能请求工具。"
            : "源码取证已收集足够证据，本轮只能给出最终回答，不能请求工具。";
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
        }

        if (isPlanningTurn) {
          if (response.kind !== "final") {
            const reason = "计划阶段不允许调用工具；请先给出可供用户确认的简短计划。";
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            throw new Error(reason);
          }
          if (!this.#requestPlanApproval) {
            const reason = "已启用计划确认，但没有可用的本地确认回调。";
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            throw new Error(reason);
          }

          this.recordEvent(events, { type: "plan_proposed", step, planLength: response.content.length });
          const approved = await this.#requestPlanApproval({ plan: response.content });
          this.recordEvent(events, {
            type: "plan_decision",
            step,
            decision: approved ? "approved" : "rejected",
          });
          messages.push({ role: "assistant", content: response.content });
          if (!approved) {
            const reason = "用户未确认计划，未执行工具或修改文件。";
            this.recordEvent(events, { type: "agent_stopped", step, reason });
            return {
              answer: reason,
              messages,
              events: events.events,
              workingState: ledger.render(),
              sourceEvidence,
            };
          }

          messages.push({ role: "user", content: "计划已由用户确认。现在开始执行；仅在必要时调用已注册工具。" });
          planApprovalPending = false;
          maximumStep += 1;
          continue;
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
              maximumStep += 1;
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

        for (const [toolCallIndex, toolCall] of response.toolCalls.entries()) {
          const rejectionReason = this.getToolCallRejectionReason(
            toolCall,
            toolCallIndex,
            acceptedToolCalls,
            allowedToolNames,
            readPaths,
          );
          const result = rejectionReason
            ? this.rejectToolCall(toolCall, step, events, rejectionReason)
            : await this.executeToolCall(toolCall, task, step, events);
          if (!rejectionReason) {
            acceptedToolCalls += 1;
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
                maximumStep += 1;
              }
            }
          }
          ledger.record({
            toolName: result.name,
            status: result.status,
            summary: result.content,
          });
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
    allowedToolNames: ReadonlySet<string> | undefined,
    readPaths: ReadonlySet<string>,
  ): string | undefined {
    if (allowedToolNames && !allowedToolNames.has(toolCall.name)) {
      return "源码取证状态不允许该工具；请按当前阶段继续定位、读取或给出最终回答。";
    }
    if (toolCallIndex >= this.#maxToolCallsPerStep) {
      return `本轮工具调用超过上限 maxToolCallsPerStep=${this.#maxToolCallsPerStep}；请基于本轮其余工具结果给出最终回答。`;
    }
    if (acceptedToolCalls >= this.#maxToolCalls) {
      return `本次任务已达到工具调用上限 maxToolCalls=${this.#maxToolCalls}；请基于已有结果给出最终回答。`;
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
  ): ToolResultMessage {
    this.recordEvent(events, {
      type: "tool_call",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return this.finalizeError(events, step, toolCall, reason);
  }

  private async executeToolCall(
    toolCall: ToolCall,
    task: string,
    step: number,
    events: InMemoryEventLog,
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

    const validation = tool.validate(toolCall.input as JsonValue);
    if (!validation.ok) {
      return this.finalizeError(events, step, toolCall, validation.error);
    }

    this.recordEvent(events, {
      type: "tool_execution_started",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    try {
      const execution = await tool.execute(validation.value, {
        task,
        step,
        workspaceRoot: this.#workspaceRoot,
        requireSourceEvidence: this.#requireSourceEvidence,
        executionMode: this.#executionMode,
        requestEditApproval: this.#requestEditApproval,
        recordPolicyDecision: (decision) => {
          this.recordEvent(events, {
            type: "policy_decision",
            step,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ...decision,
          });
        },
      });
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
        ...(output.sourceEvidence ? { sourceEvidence: output.sourceEvidence } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const metadata = error instanceof ToolExecutionError ? error.metadata : undefined;
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
