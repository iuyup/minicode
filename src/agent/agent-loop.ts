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
}

export interface AgentLoopOptions {
  workspaceRoot: string;
  maxSteps?: number;
  maxToolCallsPerStep?: number;
  maxToolCalls?: number;
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

function normalizePositiveLimit(value: number | undefined, optionName: string): number {
  if (value === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${optionName} 必须是大于 0 的安全整数。`);
  }
  return value;
}

export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  readonly #workspaceRoot: string;
  readonly #maxSteps: number;
  readonly #maxToolCallsPerStep: number;
  readonly #maxToolCalls: number;
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
          messages.push({ role: "assistant", content: response.content });
          this.recordEvent(events, { type: "agent_completed", step });
          return {
            answer: response.content,
            messages,
            events: events.events,
            workingState: ledger.render(),
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
