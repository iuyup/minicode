import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {
  AgentTool,
  CommandRiskLevel,
  JsonValue,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ValidationResult,
} from "../agent/contracts.ts";
import { ToolExecutionError, ToolPolicyError } from "../agent/contracts.ts";
import { hasUnsafeTerminalText } from "../terminal-safety.ts";
import { WorkspacePolicy } from "../workspace/workspace-policy.ts";
import {
  createSanitizedChildEnvironment,
  runBoundedProcess,
  resolveNpmCli,
  type BoundedProcessResult,
} from "./child-process-safety.ts";
import { evaluateCommandPolicy, type ControlledProgram } from "./command-policy.ts";
import { validateObjectWithKeys } from "./input-validation.ts";

export interface RunCommandInput {
  program: string;
  args: string[];
  cwd: string;
}

export interface CommandRunRequest {
  program: ControlledProgram;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface CommandRunResult extends BoundedProcessResult {}

export interface CommandRunner {
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

interface PreparedCommand {
  program: ControlledProgram;
  args: readonly string[];
  cwd: string;
  relativeCwd: string;
  command: string;
  riskLevel: CommandRiskLevel;
  risk: string;
  auditReason: string;
}

const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_CHARS = 1_000;
const MAX_TOTAL_ARGUMENT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 12_000;
const TIMEOUT_MS = 60_000;
const PROGRAM_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;

function validate(input: JsonValue): ValidationResult<RunCommandInput> {
  const object = validateObjectWithKeys(input, ["program", "args", "cwd"]);
  if (!object.ok) return object;

  const { program, args, cwd } = object.value;
  if (typeof program !== "string" || !PROGRAM_PATTERN.test(program) || hasUnsafeTerminalText(program)) {
    return { ok: false, error: "program 必须是简短的程序名，不能包含路径、空白或控制字符。" };
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    return { ok: false, error: "args 必须是字符串数组。" };
  }
  if (args.length > MAX_ARGUMENTS) {
    return { ok: false, error: `args 最多包含 ${MAX_ARGUMENTS} 项。` };
  }
  const stringArgs = args as string[];
  if (stringArgs.some((argument) => argument.length > MAX_ARGUMENT_CHARS)) {
    return { ok: false, error: `单个参数最多 ${MAX_ARGUMENT_CHARS} 个字符。` };
  }
  if (stringArgs.reduce((total, argument) => total + argument.length, 0) > MAX_TOTAL_ARGUMENT_CHARS) {
    return { ok: false, error: `参数总长度最多 ${MAX_TOTAL_ARGUMENT_CHARS} 个字符。` };
  }
  if (stringArgs.some(hasUnsafeTerminalText)) {
    return { ok: false, error: "args 不能包含换行、终端控制或双向文本控制字符。" };
  }
  if (typeof cwd !== "string" || cwd.trim() === "" || cwd.length > 500 || hasUnsafeTerminalText(cwd)) {
    return { ok: false, error: "cwd 必须是 500 字符以内、不含控制字符的工作区相对目录。" };
  }
  return { ok: true, value: { program, args: stringArgs, cwd } };
}

function displayCommand(program: ControlledProgram, args: readonly string[]): string {
  return [program, ...args.map((argument) => JSON.stringify(argument))].join(" ");
}

function blocked(
  message: string,
  auditReason: string,
  metadata: ToolExecutionMetadata = { action: "run_command" },
): ToolPolicyError {
  return new ToolPolicyError(
    `受控命令未执行：${message}`,
    { decision: "blocked", path: ".", reason: auditReason },
    metadata,
  );
}

async function prepareCommand(input: RunCommandInput, workspaceRoot: string): Promise<PreparedCommand> {
  const workspacePolicy = new WorkspacePolicy(workspaceRoot);
  let resolvedCwd;
  try {
    resolvedCwd = await workspacePolicy.resolveReadPath(input.cwd);
    const stats = await fs.stat(resolvedCwd.absolutePath);
    if (!stats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw blocked("工作目录未通过工作区路径策略，必须是工作区内已存在的目录。", "工作目录未通过工作区路径策略。");
  }

  const policy = evaluateCommandPolicy(input.program, input.args);
  if (!policy.allowed) {
    throw blocked(policy.message, policy.auditReason);
  }
  if (policy.nodeEntryPath) {
    if (path.isAbsolute(policy.nodeEntryPath)) {
      throw blocked("Node 入口脚本必须是工作区相对路径。", "Node 入口脚本未通过工作区路径策略。");
    }
    const entryFromWorkspace = resolvedCwd.relativePath === "."
      ? policy.nodeEntryPath
      : path.join(resolvedCwd.relativePath, policy.nodeEntryPath);
    try {
      const resolvedEntry = await workspacePolicy.resolveReadPath(entryFromWorkspace);
      const stats = await fs.stat(resolvedEntry.absolutePath);
      if (!stats.isFile()) throw new Error("not a file");
    } catch {
      throw blocked(
        "Node 入口脚本必须是工作目录中已存在、且真实路径仍位于工作区内的普通文件。",
        "Node 入口脚本未通过工作区路径策略。",
      );
    }
  }
  return {
    program: policy.program,
    args: [...input.args],
    cwd: resolvedCwd.absolutePath,
    relativeCwd: resolvedCwd.relativePath,
    command: displayCommand(policy.program, input.args),
    riskLevel: policy.riskLevel,
    risk: policy.risk,
    auditReason: policy.auditReason,
  };
}

class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    const npmCli = request.program === "npm" ? await resolveNpmCli() : undefined;
    const executableArgs = npmCli ? [npmCli, ...request.args] : [...request.args];
    return runBoundedProcess({
      executable: process.execPath,
      args: executableArgs,
      cwd: request.cwd,
      env: request.env,
      action: "run_command",
      startFailureLabel: "受控命令",
      timeoutMs: TIMEOUT_MS,
      maxOutputChars: MAX_OUTPUT_CHARS,
      signal: request.signal,
    });
  }
}

function metadata(riskLevel: CommandRiskLevel, result: CommandRunResult): ToolExecutionMetadata {
  return {
    action: "run_command",
    riskLevel,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputLength: result.outputLength,
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled ?? false,
  };
}

function renderOutput(prepared: PreparedCommand, result: CommandRunResult): string {
  const output = result.output || "（命令没有输出）";
  const truncationNotice = result.outputTruncated ? "\n[输出已截断]" : "";
  return [
    `命令：${prepared.command}`,
    `工作目录：${prepared.relativeCwd}`,
    `风险等级：${prepared.riskLevel}`,
    `退出码：${result.exitCode ?? "无"}`,
    `耗时：${result.durationMs}ms`,
    "输出：",
    `${output}${truncationNotice}`,
  ].join("\n");
}

export function createRunCommandTool(
  runner: CommandRunner = new NodeCommandRunner(),
): AgentTool<RunCommandInput, ToolExecutionOutput> {
  return {
    name: "run_command",
    description: "在工作区内运行结构化的 node/npm 命令；MiniCode 不用 Shell 拼接模型参数，也不接受直接 Shell、管道、重定向、Git 或提权入口，并在执行前等待本地 RUN 确认。npm 脚本自身仍可能启动 Shell 或子进程。",
    parameters: {
      type: "object",
      properties: {
        program: { type: "string", description: "程序名；第一版只允许 node、node.exe、npm 或 npm.cmd。" },
        args: { type: "array", items: { type: "string" }, description: "逐项传给进程的参数；不会拼成 Shell 命令。" },
        cwd: { type: "string", description: "工作区内已存在的相对目录，例如 . 或 packages/app。" },
      },
      required: ["program", "args", "cwd"],
      additionalProperties: false,
    },
    validate,
    async getCommandApprovalRequest(input, workspaceRoot) {
      const prepared = await prepareCommand(input, workspaceRoot);
      return {
        kind: "command",
        action: "run_command",
        command: prepared.command,
        workingDirectory: prepared.cwd,
        riskLevel: prepared.riskLevel,
        risk: prepared.risk,
      };
    },
    async execute(input, context): Promise<ToolExecutionOutput> {
      const prepared = await prepareCommand(input, context.workspaceRoot);
      context.recordPolicyDecision?.({
        decision: "allowed",
        path: prepared.relativeCwd,
        reason: prepared.auditReason,
      });

      let result: CommandRunResult;
      try {
        result = await runner.run({
          program: prepared.program,
          args: prepared.args,
          cwd: prepared.cwd,
          env: createSanitizedChildEnvironment(),
          signal: context.signal,
        });
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw new ToolExecutionError(error.message, {
            ...error.metadata,
            action: "run_command",
            riskLevel: prepared.riskLevel,
          });
        }
        throw new ToolExecutionError("受控命令无法启动。", {
          action: "run_command",
          riskLevel: prepared.riskLevel,
        });
      }

      const resultMetadata = metadata(prepared.riskLevel, result);
      const content = renderOutput(prepared, result);
      if (result.cancelled) {
        throw new ToolExecutionError(`受控命令已取消。\n${content}`, resultMetadata);
      }
      if (result.timedOut) {
        throw new ToolExecutionError(`受控命令超时（${TIMEOUT_MS}ms）。\n${content}`, resultMetadata);
      }
      if (result.exitCode !== 0) {
        throw new ToolExecutionError(`受控命令失败。\n${content}`, resultMetadata);
      }
      return { content, metadata: resultMetadata };
    },
  };
}

export const runCommand = createRunCommandTool();
