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
  sourceEvidence?: readonly SourceEvidence[];
}

export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage;

export type ConversationMessage = UserMessage | AssistantMessage;

export interface ToolDescription {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface ForcedFunctionToolChoice {
  type: "function";
  name: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ToolExecutionContext {
  task: string;
  step: number;
  workspaceRoot: string;
  requireSourceEvidence?: boolean;
  executionMode?: ToolExecutionMode;
  requestEditApproval?: (request: EditApprovalRequest) => Promise<boolean>;
  recordPolicyDecision?: (decision: ToolPolicyDecision) => void;
}

export type ToolExecutionMode = "propose" | "apply";

export interface EditApprovalRequest {
  path: string;
  preview: string;
}

export interface PlanApprovalRequest {
  plan: string;
}

export interface CommandApprovalRequest {
  action: string;
  command: string;
  workspaceRoot: string;
  risk: string;
}

export interface ToolPolicyDecision {
  decision: "allowed" | "blocked";
  path: string;
  reason: string;
}

export interface ToolExecutionMetadata {
  action?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputLength?: number;
  outputTruncated?: boolean;
  timedOut?: boolean;
}

export interface SourceEvidence {
  path: string;
  startLine: number;
  endLine: number;
}

export interface ToolExecutionOutput {
  content: string;
  metadata?: ToolExecutionMetadata;
  sourceEvidence?: readonly SourceEvidence[];
}

export type ToolExecutionResult = string | ToolExecutionOutput;

export class ToolExecutionError extends Error {
  readonly metadata?: ToolExecutionMetadata;

  constructor(message: string, metadata?: ToolExecutionMetadata) {
    super(message);
    this.name = "ToolExecutionError";
    this.metadata = metadata;
  }
}

export interface AgentTool<TInput = JsonValue, TOutput extends ToolExecutionResult = string> {
  name: string;
  description: string;
  parameters: JsonObject;
  validate(input: JsonValue): ValidationResult<TInput>;
  getCommandApprovalRequest?(input: TInput, workspaceRoot: string): CommandApprovalRequest;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools: readonly ToolDescription[];
  workingState: string;
  phase?: "planning" | "execution";
  toolChoice?: ForcedFunctionToolChoice;
}

export type ModelResponse =
  | { kind: "tool_calls"; content: string; toolCalls: ToolCall[] }
  | { kind: "final"; content: string };

export interface ChatModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
