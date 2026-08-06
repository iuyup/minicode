import type {
  AgentMessage,
  ChatModel,
  JsonValue,
  ToolCall,
  ToolResultMessage,
} from "./contracts.ts";
import { InMemoryEventLog, type AgentEvent } from "./events.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { WorkingLedger } from "./working-ledger.ts";

export interface AgentRunResult {
  answer: string;
  messages: readonly AgentMessage[];
  events: readonly AgentEvent[];
  workingState: string;
}

export interface AgentLoopOptions {
  maxSteps?: number;
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding agent running in an offline demonstration.",
  "Use a tool when you need a fact, and use the returned tool result as evidence.",
  "Do not invent a tool result.",
].join(" ");

export class AgentLoop {
  private readonly model: ChatModel;
  private readonly tools: ToolRegistry;
  readonly #maxSteps: number;
  readonly #systemPrompt: string;

  constructor(
    model: ChatModel,
    tools: ToolRegistry,
    options: AgentLoopOptions = {},
  ) {
    this.model = model;
    this.tools = tools;
    this.#maxSteps = options.maxSteps ?? 6;
    this.#systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async run(task: string): Promise<AgentRunResult> {
    const messages: AgentMessage[] = [
      { role: "system", content: this.#systemPrompt },
      { role: "user", content: task },
    ];
    const events = new InMemoryEventLog();
    const ledger = new WorkingLedger(task);

    for (let step = 1; step <= this.#maxSteps; step += 1) {
      events.record({ type: "model_requested", step });
      const response = await this.model.complete({
        messages,
        tools: this.tools.describe(),
        workingState: ledger.render(),
      });

      if (response.kind === "final") {
        messages.push({ role: "assistant", content: response.content });
        events.record({ type: "agent_completed", step });
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

      for (const toolCall of response.toolCalls) {
        const result = await this.executeToolCall(toolCall, task, step, events);
        messages.push(result);
        ledger.record({
          toolName: result.name,
          status: result.status,
          summary: result.content,
        });
      }
    }

    const reason = `Reached maxSteps=${this.#maxSteps} without a final answer.`;
    events.record({ type: "agent_stopped", step: this.#maxSteps, reason });
    throw new Error(reason);
  }

  private async executeToolCall(
    toolCall: ToolCall,
    task: string,
    step: number,
    events: InMemoryEventLog,
  ): Promise<ToolResultMessage> {
    events.record({
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
        `Unknown tool: ${toolCall.name}`,
      );
    }

    const validation = tool.validate(toolCall.input as JsonValue);
    if (!validation.ok) {
      return this.finalizeError(events, step, toolCall, validation.error);
    }

    events.record({
      type: "tool_execution_started",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });

    try {
      const content = await tool.execute(validation.value, { task, step });
      events.record({
        type: "tool_finalized",
        step,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "success",
        detail: content,
      });
      return {
        role: "tool",
        toolCallId: toolCall.id,
        name: toolCall.name,
        status: "success",
        content,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.finalizeError(events, step, toolCall, `Tool failed: ${message}`);
    }
  }

  private finalizeError(
    events: InMemoryEventLog,
    step: number,
    toolCall: ToolCall,
    content: string,
  ): ToolResultMessage {
    events.record({
      type: "tool_finalized",
      step,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      status: "error",
      detail: content,
    });
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      status: "error",
      content,
    };
  }
}
