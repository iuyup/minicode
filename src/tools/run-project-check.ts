import process from "node:process";

import type {
  AgentTool,
  JsonValue,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ValidationResult,
} from "../agent/contracts.ts";
import { ToolExecutionError } from "../agent/contracts.ts";
import {
  createSanitizedChildEnvironment,
  runBoundedProcess,
  resolveNpmCli,
  type BoundedProcessResult,
} from "./child-process-safety.ts";
import { validateObjectWithKeys } from "./input-validation.ts";

export type ProjectCheckAction = "test" | "check";

interface RunProjectCheckInput {
  action: ProjectCheckAction;
}

export interface ProjectCheckRunResult extends BoundedProcessResult {}

export interface ProjectCheckRunner {
  run(action: ProjectCheckAction, workspaceRoot: string): Promise<ProjectCheckRunResult>;
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
  async run(action: ProjectCheckAction, workspaceRoot: string): Promise<ProjectCheckRunResult> {
    const npmCli = await resolveNpmCli();
    return runBoundedProcess({
      executable: process.execPath,
      args: [npmCli, ...ACTION_ARGUMENTS[action]],
      cwd: workspaceRoot,
      env: createSanitizedChildEnvironment(),
      action,
      startFailureLabel: ` ${ACTION_LABELS[action]}`,
      timeoutMs: TIMEOUT_MS,
      maxOutputChars: MAX_OUTPUT_CHARS,
    });
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
    getCommandApprovalRequest(input, workspaceRoot) {
      return {
        kind: "verification",
        action: input.action,
        command: ACTION_LABELS[input.action],
        workingDirectory: workspaceRoot,
        riskLevel: "medium",
        risk: COMMAND_RISK,
      };
    },
    async execute(input, context): Promise<ToolExecutionOutput> {
      context.recordPolicyDecision?.({
        decision: "allowed",
        path: ".",
        reason: `允许固定验证动作：${input.action}；工作目录固定为工作区根目录。`,
      });
      let result: ProjectCheckRunResult;
      try {
        result = await runner.run(input.action, context.workspaceRoot);
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

      if (result.timedOut) {
        throw new ToolExecutionError(`固定验证动作超时（${TIMEOUT_MS}ms）。\n${content}`, resultMetadata);
      }
      if (result.exitCode !== 0) {
        throw new ToolExecutionError(`固定验证动作失败。\n${content}`, resultMetadata);
      }
      return { content, metadata: resultMetadata };
    },
  };
}

export const runProjectCheck = createRunProjectCheckTool();
