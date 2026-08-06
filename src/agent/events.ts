export type AgentEvent =
  | { type: "model_requested"; step: number }
  | { type: "tool_call"; step: number; toolCallId: string; toolName: string }
  | { type: "tool_execution_started"; step: number; toolCallId: string; toolName: string }
  | {
      type: "tool_finalized";
      step: number;
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      detail: string;
    }
  | { type: "agent_completed"; step: number }
  | { type: "agent_stopped"; step: number; reason: string };

export class InMemoryEventLog {
  readonly events: AgentEvent[] = [];

  record(event: AgentEvent): void {
    this.events.push(event);
  }
}
