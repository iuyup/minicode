import process from "node:process";

import type {
  AgentTool,
  JsonValue,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ValidationResult,
} from "../agent/contracts.ts";
import { ToolExecutionError, ToolPolicyError } from "../agent/contracts.ts";
import {
  createSanitizedChildEnvironment,
  runBoundedProcess,
  resolveNpmCli,
  type BoundedProcessResult,
} from "./child-process-safety.ts";
import { validateObjectWithKeys } from "./input-validation.ts";
import {
  prepareNpmRuntimeBinding,
  verifyNpmRuntimeBinding,
  type PreparedNpmRuntimeBinding,
} from "./run-command.ts";

export type ProjectCheckAction = "test" | "check";

interface RunProjectCheckInput {
  action: ProjectCheckAction;
}

export interface ProjectCheckRunResult extends BoundedProcessResult {}

export interface ProjectCheckRunner {
  run(
    action: ProjectCheckAction,
    workspaceRoot: string,
    signal?: AbortSignal,
    runtime?: { readonly nodeExecutablePath: string; readonly npmCliPath: string },
  ): Promise<ProjectCheckRunResult>;
}

const ACTION_ARGUMENTS: Record<ProjectCheckAction, readonly string[]> = {
  test: ["test"],
  check: ["run", "check"],
};
const ACTION_LABELS: Record<ProjectCheckAction, string> = {
  test: "npm test",
  check: "npm run check",
};
const COMMAND_RISK = "npm scripts 会执行工作区 package.json 中定义的项目代码，也可能修改文件、访问网络或启动子进程；只在信任该工作区时确认。这不是操作系统沙箱。";
const MAX_OUTPUT_CHARS = 12_000;
const TIMEOUT_MS = 60_000;

function validate(input: JsonValue): ValidationResult<RunProjectCheckInput> {
  const object = validateObjectWithKeys(input, ["action"]);
  if (!object.ok) {
    return object;
  }
  if (object.value.action !== "test" && object.value.action !== "check") {
    return { ok: false, error: "action 只能是固定值 test 或 check，不接受任意命令。" };
  }
  return { ok: true, value: { action: object.value.action } };
}

class NpmProjectCheckRunner implements ProjectCheckRunner {
  async run(
    action: ProjectCheckAction,
    workspaceRoot: string,
    signal?: AbortSignal,
    runtime?: { readonly nodeExecutablePath: string; readonly npmCliPath: string },
  ): Promise<ProjectCheckRunResult> {
    const npmCli = runtime?.npmCliPath ?? await resolveNpmCli();
    return runBoundedProcess({
      executable: runtime?.nodeExecutablePath ?? process.execPath,
      args: [npmCli, ...ACTION_ARGUMENTS[action]],
      cwd: workspaceRoot,
      env: createSanitizedChildEnvironment(),
      action,
      startFailureLabel: ` ${ACTION_LABELS[action]}`,
      timeoutMs: TIMEOUT_MS,
      maxOutputChars: MAX_OUTPUT_CHARS,
      signal,
    });
  }
}

function blockedProjectCheck(
  action: ProjectCheckAction,
  message: string,
  reason: string,
): ToolPolicyError {
  return new ToolPolicyError(
    `固定验证动作未执行：${message}`,
    { decision: "blocked", path: ".", reason },
    { action, riskLevel: "medium" },
  );
}

async function prepareProjectCheck(
  action: ProjectCheckAction,
  workspaceRoot: string,
): Promise<PreparedNpmRuntimeBinding> {
  try {
    return await prepareNpmRuntimeBinding(workspaceRoot, ".");
  } catch {
    throw blockedProjectCheck(
      action,
      "无法安全绑定工作区根目录、本机 Node/npm 入口与 package.json；请确认它们存在且未被读取策略保护。",
      "固定验证环境未通过审批前身份与内容绑定。",
    );
  }
}

function metadata(action: ProjectCheckAction, result: ProjectCheckRunResult): ToolExecutionMetadata {
  return {
    action,
    riskLevel: "medium",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputLength: result.outputLength,
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled ?? false,
  };
}

function renderOutput(action: ProjectCheckAction, result: ProjectCheckRunResult): string {
  const output = result.output || "（命令没有输出）";
  const truncationNotice = result.outputTruncated ? "\n[输出已截断]" : "";
  return [
    `验证动作：${action}`,
    `固定命令：${ACTION_LABELS[action]}`,
    `退出码：${result.exitCode ?? "无"}`,
    `耗时：${result.durationMs}ms`,
    "输出：",
    `${output}${truncationNotice}`,
  ].join("\n");
}

async function executePreparedProjectCheck(
  input: RunProjectCheckInput,
  binding: PreparedNpmRuntimeBinding,
  context: Parameters<NonNullable<AgentTool<RunProjectCheckInput, ToolExecutionOutput>["execute"]>>[1],
  runner: ProjectCheckRunner,
): Promise<ToolExecutionOutput> {
  try {
    await verifyNpmRuntimeBinding(binding, context.workspaceRoot);
  } catch {
    throw blockedProjectCheck(
      input.action,
      "审批期间工作区、Node/npm 入口或 package.json 失效、被替换或内容发生变化。",
      "固定验证环境未通过审批后身份与内容复核。",
    );
  }

  context.recordPolicyDecision?.({
    decision: "allowed",
    path: ".",
    reason: `允许固定验证动作：${input.action}；工作目录、执行入口与项目定义已通过审批后复核。`,
  });
  let result: ProjectCheckRunResult;
  try {
    result = await runner.run(input.action, binding.cwd, context.signal, {
      nodeExecutablePath: binding.nodeExecutable.path,
      npmCliPath: binding.npmCli.path,
    });
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      throw new ToolExecutionError(error.message, {
        ...error.metadata,
        action: input.action,
        riskLevel: "medium",
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolExecutionError(`固定验证动作无法启动：${message}`, {
      action: input.action,
      riskLevel: "medium",
    });
  }
  const resultMetadata = metadata(input.action, result);
  const content = renderOutput(input.action, result);

  if (result.cancelled) {
    throw new ToolExecutionError(`固定验证动作已取消。\n${content}`, resultMetadata);
  }
  if (result.timedOut) {
    throw new ToolExecutionError(`固定验证动作超时（${TIMEOUT_MS}ms）。\n${content}`, resultMetadata);
  }
  if (result.exitCode !== 0) {
    throw new ToolExecutionError(`固定验证动作失败。\n${content}`, resultMetadata);
  }
  return { content, metadata: resultMetadata };
}

export function createRunProjectCheckTool(
  runner: ProjectCheckRunner = new NpmProjectCheckRunner(),
): AgentTool<RunProjectCheckInput, ToolExecutionOutput> {
  return {
    name: "run_project_check",
    description: "在工作区根目录运行固定验证动作；只允许 test（npm test）或 check（npm run check），并在执行前等待本地 RUN 确认。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["test", "check"], description: "固定验证动作。" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    validate,
    async prepareCommandExecution(input, workspaceRoot) {
      const binding = await prepareProjectCheck(input.action, workspaceRoot);
      return {
        approvalRequest: {
          kind: "verification",
          action: input.action,
          command: ACTION_LABELS[input.action],
          workingDirectory: binding.cwd,
          riskLevel: "medium",
          risk: COMMAND_RISK,
        },
        execute: async (context) => executePreparedProjectCheck(input, binding, context, runner),
      };
    },
    async execute(input, context): Promise<ToolExecutionOutput> {
      const binding = await prepareProjectCheck(input.action, context.workspaceRoot);
      return executePreparedProjectCheck(input, binding, context, runner);
    },
  };
}

export const runProjectCheck = createRunProjectCheckTool();
