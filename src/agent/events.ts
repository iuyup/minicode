import fs from "node:fs/promises";
import path from "node:path";

import type { ToolExecutionMetadata } from "./contracts.ts";

export type AgentEvent =
  | { type: "model_requested"; step: number; forcedToolName?: string }
  | { type: "plan_proposed"; step: number; planLength: number }
  | { type: "plan_decision"; step: number; decision: "approved" | "rejected" }
  | { type: "tool_call"; step: number; toolCallId: string; toolName: string }
  | {
      type: "policy_decision";
      step: number;
      toolCallId: string;
      toolName: string;
      decision: "allowed" | "blocked";
      path: string;
      reason: string;
    }
  | { type: "tool_execution_started"; step: number; toolCallId: string; toolName: string }
  | {
      type: "tool_finalized";
      step: number;
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      detail: string;
      metadata?: ToolExecutionMetadata;
    }
  | {
      type: "final_answer_rejected";
      step: number;
      reason: "missing_read_file_evidence" | "missing_source_citation" | "unverified_source_citation";
      sourceEvidenceCount: number;
    }
  | { type: "agent_completed"; step: number }
  | { type: "agent_stopped"; step: number; reason: string };

export class InMemoryEventLog {
  readonly events: AgentEvent[] = [];

  record(event: AgentEvent): void {
    this.events.push(event);
  }
}

export interface AgentEventAuditLog {
  record(event: AgentEvent): void;
  flush(): Promise<void>;
}

interface SanitizedAuditEvent {
  timestamp: string;
  type: AgentEvent["type"];
  step: number;
  toolCallId?: string;
  toolName?: string;
  decision?: "allowed" | "blocked";
  planDecision?: "approved" | "rejected";
  status?: "success" | "error";
  path?: string;
  reason?: string;
  detailLength?: number;
  action?: string;
  exitCode?: number | null;
  durationMs?: number;
  outputLength?: number;
  outputTruncated?: boolean;
  timedOut?: boolean;
  sourceEvidenceCount?: number;
  forcedToolName?: string;
  planLength?: number;
}

function sanitizeMetadata(metadata: ToolExecutionMetadata | undefined): ToolExecutionMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized: ToolExecutionMetadata = {};
  if (metadata.action !== undefined) sanitized.action = metadata.action;
  if (metadata.exitCode !== undefined) sanitized.exitCode = metadata.exitCode;
  if (metadata.durationMs !== undefined) sanitized.durationMs = metadata.durationMs;
  if (metadata.outputLength !== undefined) sanitized.outputLength = metadata.outputLength;
  if (metadata.outputTruncated !== undefined) sanitized.outputTruncated = metadata.outputTruncated;
  if (metadata.timedOut !== undefined) sanitized.timedOut = metadata.timedOut;
  return sanitized;
}

function sanitize(event: AgentEvent): SanitizedAuditEvent {
  const base = { timestamp: new Date().toISOString(), type: event.type, step: event.step };
  switch (event.type) {
    case "tool_call":
    case "tool_execution_started":
      return { ...base, toolCallId: event.toolCallId, toolName: event.toolName };
    case "policy_decision":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        decision: event.decision,
        path: event.path,
        reason: event.reason,
      };
    case "tool_finalized":
      return {
        ...base,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.status,
        detailLength: event.detail.length,
        ...sanitizeMetadata(event.metadata),
      };
    case "final_answer_rejected":
      return {
        ...base,
        reason: event.reason,
        sourceEvidenceCount: event.sourceEvidenceCount,
      };
    case "model_requested":
      return event.forcedToolName ? { ...base, forcedToolName: event.forcedToolName } : base;
    case "plan_proposed":
      return { ...base, planLength: event.planLength };
    case "plan_decision":
      return { ...base, planDecision: event.decision };
    case "agent_completed":
    case "agent_stopped":
      return base;
  }
}

/**
 * 持久化审计只保留生命周期元数据；工具结果、补丁内容和模型上下文不写入 JSONL。
 */
export class JsonlAuditLog implements AgentEventAuditLog {
  readonly #pending: AgentEvent[] = [];
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  record(event: AgentEvent): void {
    this.#pending.push(event);
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return;
    }

    const events = [...this.#pending];
    const output = `${events.map((event) => JSON.stringify(sanitize(event))).join("\n")}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, output, "utf8");
    this.#pending.splice(0, events.length);
  }
}
