import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {
  AgentTool,
  JsonValue,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ValidationResult,
} from "../agent/contracts.ts";
import { ToolExecutionError } from "../agent/contracts.ts";
import { validateObjectWithKeys } from "./input-validation.ts";

export type ProjectCheckAction = "test" | "check";

interface RunProjectCheckInput {
  action: ProjectCheckAction;
}

export interface ProjectCheckRunResult {
  exitCode: number | null;
  durationMs: number;
  output: string;
  outputLength: number;
  outputTruncated: boolean;
  timedOut: boolean;
}

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
const COMMAND_RISK = "npm scripts 会执行工作区 package.json 中定义的项目代码，也可能修改文件或访问网络；只在信任该工作区时确认。";
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

async function resolveNpmCli(): Promise<string> {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // 尝试下一个受进程环境控制的 npm CLI 位置。
    }
  }
  throw new ToolExecutionError("未找到 npm CLI，无法执行固定项目验证动作。");
}

class NpmProjectCheckRunner implements ProjectCheckRunner {
  async run(action: ProjectCheckAction, workspaceRoot: string): Promise<ProjectCheckRunResult> {
    const npmCli = await resolveNpmCli();
    const startedAt = Date.now();
    const child = spawn(process.execPath, [npmCli, ...ACTION_ARGUMENTS[action]], {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let outputLength = 0;
    let outputTruncated = false;
    let timedOut = false;
    const appendOutput = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      outputLength += text.length;
      const remaining = MAX_OUTPUT_CHARS - output.length;
      if (remaining > 0) {
        output += text.slice(0, remaining);
      }
      if (text.length > remaining) {
        outputTruncated = true;
      }
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);

    return new Promise<ProjectCheckRunResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, TIMEOUT_MS);

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(
          new ToolExecutionError(`无法启动 ${ACTION_LABELS[action]}：${error.message}`, {
            action,
            durationMs: Date.now() - startedAt,
          }),
        );
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          durationMs: Date.now() - startedAt,
          output,
          outputLength,
          outputTruncated,
          timedOut,
        });
      });
    });
  }
}

function metadata(action: ProjectCheckAction, result: ProjectCheckRunResult): ToolExecutionMetadata {
  return {
    action,
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
        action: input.action,
        command: ACTION_LABELS[input.action],
        workspaceRoot,
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
          throw new ToolExecutionError(error.message, { ...error.metadata, action: input.action });
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ToolExecutionError(`固定验证动作无法启动：${message}`, { action: input.action });
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
