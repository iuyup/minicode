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
  metadata?: ToolExecutionMetadata;
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
  signal?: AbortSignal;
  requireSourceEvidence?: boolean;
  executionMode?: ToolExecutionMode;
  requestEditApproval?: (request: EditApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
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

export interface RepairApprovalRequest {
  failedAction: string;
  direction: string;
  attempt: number;
  maximumAttempts: number;
}

export type CommandApprovalKind = "verification" | "command";
export type CommandRiskLevel = "low" | "medium" | "high";

export interface CommandApprovalRequest {
  kind: CommandApprovalKind;
  action: string;
  command: string;
  workingDirectory: string;
  riskLevel: CommandRiskLevel;
  risk: string;
}

export interface ToolPolicyDecision {
  decision: "allowed" | "blocked";
  path: string;
  reason: string;
}

export interface ToolExecutionMetadata {
  action?: string;
  riskLevel?: CommandRiskLevel;
  exitCode?: number | null;
  durationMs?: number;
  outputLength?: number;
  outputTruncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface SourceEvidence {
  path: string;
  startLine: number;
  endLine: number;
  /** 行内容在发给模型前被截断；这些行不能作为完整源码证据。 */
  truncatedLines?: readonly number[];
}

export interface ToolExecutionOutput {
  content: string;
  metadata?: ToolExecutionMetadata;
  sourceEvidence?: readonly SourceEvidence[];
}

export type ToolExecutionResult = string | ToolExecutionOutput;

export interface PreparedCommandExecution<
  TOutput extends ToolExecutionResult = ToolExecutionResult,
> {
  approvalRequest: CommandApprovalRequest;
  execute(context: ToolExecutionContext): Promise<TOutput>;
}

export class ToolExecutionError extends Error {
  readonly metadata?: ToolExecutionMetadata;

  constructor(message: string, metadata?: ToolExecutionMetadata) {
    super(message);
    this.name = "ToolExecutionError";
    this.metadata = metadata;
  }
}

export class ToolPolicyError extends ToolExecutionError {
  readonly decision: ToolPolicyDecision;

  constructor(
    message: string,
    decision: ToolPolicyDecision,
    metadata?: ToolExecutionMetadata,
  ) {
    super(message, metadata);
    this.name = "ToolPolicyError";
    this.decision = decision;
  }
}

export interface AgentTool<TInput = JsonValue, TOutput extends ToolExecutionResult = string> {
  name: string;
  description: string;
  parameters: JsonObject;
  validate(input: JsonValue): ValidationResult<TInput>;
  getCommandApprovalRequest?(
    input: TInput,
    workspaceRoot: string,
  ): CommandApprovalRequest | Promise<CommandApprovalRequest>;
  /**
   * 将审批展示和获批后的执行绑定到同一个一次性准备结果。
   * 命令类工具应优先实现此接口，而不是在审批后重新解析模型输入。
   */
  prepareCommandExecution?(
    input: TInput,
    workspaceRoot: string,
  ): PreparedCommandExecution<TOutput> | Promise<PreparedCommandExecution<TOutput>>;
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

export interface ModelRequest {
  messages: readonly AgentMessage[];
  tools: readonly ToolDescription[];
  workingState: string;
  phase?: "planning" | "repair_planning" | "execution";
  toolChoice?: ForcedFunctionToolChoice;
}

export type ModelResponse =
  | { kind: "tool_calls"; content: string; toolCalls: ToolCall[] }
  | { kind: "final"; content: string };

export interface ChatModel {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
