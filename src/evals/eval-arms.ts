import path from "node:path";

import { AgentLoop } from "../agent/agent-loop.ts";
import type {
  ChatModel,
  CommandApprovalRequest,
  EditApprovalRequest,
} from "../agent/contracts.ts";
import { JsonlAuditLog, type AgentEvent } from "../agent/events.ts";
import { ToolRegistry } from "../agent/tool-registry.ts";
import { createAgent, parseArguments } from "../runtime.ts";
import { applyPatch } from "../tools/apply-patch.ts";
import { readFile } from "../tools/read-file.ts";
import { runProjectCheck } from "../tools/run-project-check.ts";
import { EVALUATION_BUDGET, type EvaluationArm } from "./eval-config.ts";
import { readEvaluationFixture, type PreparedEvaluationFixture } from "./eval-fixture.ts";
import { EVALUATION_PROMPTS } from "./eval-prompts.ts";

export interface CreateEvaluationArmOptions {
  arm: EvaluationArm;
  fixture: PreparedEvaluationFixture;
  auditPath: string;
  profileId: "deepseek" | "openai-compatible";
  model: ChatModel;
  onEvent?: (event: AgentEvent) => void;
}

function normalizedPath(target: string): string {
  const normalized = path.normalize(path.resolve(target));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(normalizedPath(parent), normalizedPath(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function createApprovalPolicy(fixture: PreparedEvaluationFixture): {
  requestEditApproval(request: EditApprovalRequest): Promise<boolean>;
  requestCommandApproval(request: CommandApprovalRequest): Promise<boolean>;
} {
  const allowedPaths = new Set(fixture.task.allowedChangedFiles.map(normalizedRelativePath));
  return {
    async requestEditApproval(request) {
      return fixture.task.category === "functional" && allowedPaths.has(normalizedRelativePath(request.path));
    },
    async requestCommandApproval(request) {
      return request.kind === "verification" &&
        (request.action === "test" || request.action === "check") &&
        samePath(request.workingDirectory, fixture.workspaceRoot);
    },
  };
}

async function verifyFixtureForAutoApproval(
  fixture: PreparedEvaluationFixture,
  auditPath: string,
): Promise<PreparedEvaluationFixture> {
  const verified = await readEvaluationFixture(fixture.runRoot);
  if (
    verified.task.id !== fixture.task.id ||
    !samePath(verified.workspaceRoot, fixture.workspaceRoot) ||
    verified.marker.fixtureSha256 !== fixture.marker.fixtureSha256
  ) {
    throw new Error("评测 fixture 在自动审批前发生变化，拒绝运行。");
  }
  const resolvedAuditPath = path.resolve(auditPath);
  if (
    !isSameOrInside(verified.runRoot, resolvedAuditPath) ||
    isSameOrInside(verified.workspaceRoot, resolvedAuditPath)
  ) {
    throw new Error("评测审计必须位于受标记 run root 内、Agent workspace 外。" );
  }
  return verified;
}

export async function createEvaluationArmAgent(options: CreateEvaluationArmOptions): Promise<AgentLoop> {
  const fixture = await verifyFixtureForAutoApproval(options.fixture, options.auditPath);
  const approvals = createApprovalPolicy(fixture);
  const sharedCallbacks = {
    requestEditApproval: approvals.requestEditApproval,
    requestPlanApproval: async () => true,
    requestRepairApproval: async () => true,
    requestCommandApproval: approvals.requestCommandApproval,
    onEvent: options.onEvent,
  };
  const failureRepairInitialProjectCheckAction = fixture.task.flow === "failure_repair"
    ? EVALUATION_BUDGET.failureRepairInitialProjectCheckAction
    : undefined;

  if (options.arm === "minicode-product") {
    const argumentsValue = parseArguments([
      "--profile", options.profileId,
      "--mode", "edit",
      "--guided",
      "--workspace", fixture.workspaceRoot,
      "--audit", path.resolve(options.auditPath),
      fixture.task.prompt,
    ]);
    return createAgent(argumentsValue, {
      model: options.model,
      initialProjectCheckAction: failureRepairInitialProjectCheckAction,
      ...sharedCallbacks,
    });
  }

  const guided = options.arm === "minicode-3tool";
  return new AgentLoop(
    options.model,
    new ToolRegistry([readFile, applyPatch, runProjectCheck]),
    {
      workspaceRoot: fixture.workspaceRoot,
      maxSteps: guided
        ? EVALUATION_BUDGET.guidedBaseMaxModelRequests - 1
        : EVALUATION_BUDGET.baselineMaxModelRequests,
      maxToolCallsPerStep: EVALUATION_BUDGET.maxToolCallsPerTurn,
      maxToolCalls: EVALUATION_BUDGET.baseMaxAcceptedToolCalls,
      hardMaxModelRequests: EVALUATION_BUDGET.hardMaxModelRequests,
      hardMaxToolCalls: EVALUATION_BUDGET.hardMaxAcceptedToolCalls,
      finalOnlyAfterToolBudget: true,
      executionMode: "apply",
      requireReadBeforeEdit: true,
      requirePlanApproval: guided,
      planningPrompt: guided ? EVALUATION_PROMPTS[options.arm].planning ?? undefined : undefined,
      enableFailureRepair: guided,
      initialProjectCheckAction: guided ? failureRepairInitialProjectCheckAction : undefined,
      systemPrompt: EVALUATION_PROMPTS[options.arm].system,
      auditLog: new JsonlAuditLog(path.resolve(options.auditPath)),
      ...sharedCallbacks,
    },
  );
}
