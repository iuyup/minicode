import { ToolExecutionError } from "./contracts.ts";
import type {
  AgentMessage,
  ChatModel,
  EditApprovalRequest,
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

export interface AgentLoopOptions {
  workspaceRoot: string;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  maxToolCalls?: number;
  requireSourceEvidence?: boolean;
  systemPrompt?: string;
  executionMode?: ToolExecutionMode;
  requestEditApproval?: (request: EditApprovalRequest) => Promise<boolean>;
  auditLog?: AgentEventAuditLog;
}

const DEFAULT_SYSTEM_PROMPT = [
  "你是一个运行在受控演示中的 Coding Agent。",
  "需要事实时必须调用工具，并将工具结果作为证据。",
  "不得编造工具结果。",
].join(" ");

const MAX_FINAL_ANSWER_REPAIRS = 1;

type SourceEvidenceRejectionReason =
  | "missing_read_file_evidence"
  | "missing_source_citation"
  | "unverified_source_citation";

type SourceEvidenceValidation =
  | { ok: true }
  | { ok: false; reason: SourceEvidenceRejectionReason };

const SOURCE_CITATION_PATTERN = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?|json|md)):(\d+)(?=$|[\s`)\]，,.;:!?；。])/gm;

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
    line: Number(match[2]),
  }));
  if (citations.length === 0) {
    return { ok: false, reason: "missing_source_citation" };
  }

  const areAllCitationsVerified = citations.every((citation) => sourceEvidence.some(
    (evidence) =>
      evidence.path === citation.path &&
      citation.line >= evidence.startLine &&
      citation.line <= evidence.endLine,
  ));
  return areAllCitationsVerified
    ? { ok: true }
    : { ok: false, reason: "unverified_source_citation" };
}

function formatSourceEvidence(sourceEvidence: readonly SourceEvidence[]): string {
  return sourceEvidence
    .map((evidence) => `${evidence.path}:${evidence.startLine}-${evidence.endLine}`)
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
    : `本轮已验证范围：${formatSourceEvidence(sourceEvidence)}。`;
  return [
    `你的上一条最终回答未通过本地源码证据校验：${reasonText}`,
    evidenceText,
    "如需补充证据，可以调用 read_file；重答时只能引用本轮成功 read_file 的源码，并至少包含一条 `path:line`。",
    "不要引用 README、agent.md 或未读取文件来证明实现机制；若证据不足，请明确说明。",
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

export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  readonly #workspaceRoot: string;
  readonly #maxSteps: number;
  readonly #maxToolCallsPerStep: number;
  readonly #maxToolCalls: number;
  readonly #requireSourceEvidence: boolean;
  readonly #systemPrompt: string;
  readonly #executionMode: ToolExecutionMode;
  readonly #requestEditApproval?: (request: EditApprovalRequest) => Promise<boolean>;
  readonly #auditLog?: AgentEventAuditLog;

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
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#executionMode = options.executionMode ?? "propose";
    this.#requestEditApproval = options.requestEditApproval;
    this.#auditLog = options.auditLog;
  }

  async run(task: string): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [
      { role: "system", content: this.#systemPrompt },
      { role: "user", content: task },
    ];
    const events = new InMemoryEventLog();
    const ledger = new WorkingLedger(task);
    let acceptedToolCalls = 0;
    let finalAnswerRepairs = 0;
    const sourceEvidence: SourceEvidence[] = [];

    try {
      for (let step = 1; step <= this.#maxSteps; step += 1) {
        this.recordEvent(events, { type: "model_requested", step });
        let response: ModelResponse;
        try {
          response = await this.model.complete({
            messages,
            tools: this.tools.describe(),
            workingState: ledger.render(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = `模型请求失败：${message}`;
          this.recordEvent(events, { type: "agent_stopped", step, reason });
          throw new Error(reason);
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
            if (finalAnswerRepairs >= MAX_FINAL_ANSWER_REPAIRS) {
              const reason = "最终回答连续两次未通过源码证据校验。";
              this.recordEvent(events, { type: "agent_stopped", step, reason });
              throw new Error(reason);
            }
            finalAnswerRepairs += 1;
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
          const rejectionReason = this.getToolCallRejectionReason(toolCallIndex, acceptedToolCalls);
          const result = rejectionReason
            ? this.rejectToolCall(toolCall, step, events, rejectionReason)
            : await this.executeToolCall(toolCall, task, step, events);
          if (!rejectionReason) {
            acceptedToolCalls += 1;
          }
          messages.push(result);
          appendSourceEvidence(sourceEvidence, result.sourceEvidence);
          ledger.record({
            toolName: result.name,
            status: result.status,
            summary: result.content,
          });
        }
      }

      const reason = `达到最大步数 maxSteps=${this.#maxSteps}，但模型尚未给出最终回答。`;
      this.recordEvent(events, { type: "agent_stopped", step: this.#maxSteps, reason });
      throw new Error(reason);
    } finally {
      await this.#auditLog?.flush();
    }
  }

  private getToolCallRejectionReason(toolCallIndex: number, acceptedToolCalls: number): string | undefined {
    if (toolCallIndex >= this.#maxToolCallsPerStep) {
      return `本轮工具调用超过上限 maxToolCallsPerStep=${this.#maxToolCallsPerStep}；请基于本轮其余工具结果给出最终回答。`;
    }
    if (acceptedToolCalls >= this.#maxToolCalls) {
      return `本次任务已达到工具调用上限 maxToolCalls=${this.#maxToolCalls}；请基于已有结果给出最终回答。`;
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
  }
}
