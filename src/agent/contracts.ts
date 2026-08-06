export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonValue;
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  status: "success" | "error";
  content: string;
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export interface ToolDescription {
  name: string;
  description: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ToolExecutionContext {
  task: string;
  step: number;
}

export interface AgentTool<TInput extends JsonValue = JsonValue> {
  name: string;
  description: string;
  validate(input: JsonValue): ValidationResult<TInput>;
  execute(input: TInput, context: ToolExecutionContext): Promise<string>;
}

export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools: readonly ToolDescription[];
  workingState: string;
}

export type ModelResponse =
  | { kind: "tool_calls"; content: string; toolCalls: ToolCall[] }
  | { kind: "final"; content: string };

export interface ChatModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
