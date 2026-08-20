import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
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
  /** 由审批前准备阶段解析并绑定；自定义 runner 可忽略。 */
  nodeExecutablePath?: string;
  /** npm 命令实际由已绑定的 Node 执行该 CLI；自定义 runner 可忽略。 */
  npmCliPath?: string;
}

export interface CommandRunResult extends BoundedProcessResult {}

export interface CommandRunner {
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

export interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtimeNs: bigint;
}

export interface DirectoryBinding extends PathIdentity {
  readonly path: string;
}

export interface FileBinding extends PathIdentity {
  readonly path: string;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly contentHash: string;
}

interface PreparedCommand {
  readonly program: ControlledProgram;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly relativeCwd: string;
  readonly command: string;
  readonly riskLevel: CommandRiskLevel;
  readonly risk: string;
  readonly auditReason: string;
  readonly cwdBinding: DirectoryBinding;
  readonly nodeExecutable: FileBinding;
  readonly npmCli?: FileBinding;
  readonly packageJson?: FileBinding & { readonly workspacePath: string };
  readonly nodeEntry?: FileBinding & { readonly workspacePath: string };
}

export interface PreparedNpmRuntimeBinding {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly relativeCwd: string;
  readonly cwdBinding: DirectoryBinding;
  readonly nodeExecutable: FileBinding;
  readonly npmCli: FileBinding;
  readonly packageJson: FileBinding & { readonly workspacePath: string };
}

const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_CHARS = 1_000;
const MAX_TOTAL_ARGUMENT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 12_000;
const TIMEOUT_MS = 60_000;
const PROGRAM_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/u;
const FILE_HASH_SAMPLE_BYTES = 64 * 1024;
const NPM_PACKAGE_BOUND_ACTIONS = new Set([
  "test",
  "t",
  "run",
  "run-script",
  "start",
  "stop",
  "restart",
  "install",
  "i",
  "ci",
  "update",
  "up",
  "uninstall",
  "remove",
  "rm",
  "prune",
  "dedupe",
]);

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

function pathIdentity(stats: BigIntStats): PathIdentity {
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    birthtimeNs: stats.birthtimeNs,
  });
}

function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function npmActionRequiresPackageBinding(args: readonly string[]): boolean {
  return NPM_PACKAGE_BOUND_ACTIONS.has(args[0]?.toLowerCase() ?? "");
}

async function readFileSegment(
  handle: Awaited<ReturnType<typeof fs.open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

/**
 * 小文件哈希全文；对 Node 可执行文件等大文件绑定大小、首尾各 64 KiB，
 * 避免每次命令确认都读取整个宿主可执行文件。文件句柄前后的 stat 会检测采样期间的替换或修改。
 */
async function captureFileBinding(
  filePath: string,
  hashMode: "sampled" | "full" = "sampled",
): Promise<FileBinding> {
  const openFlags = process.platform === "win32"
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await fs.open(filePath, openFlags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("not a regular file");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("file is too large to bind");

    const size = Number(before.size);
    const hash = createHash("sha256");
    hash.update(`size:${before.size.toString()}\n`, "utf8");
    if (hashMode === "full") {
      hash.update("full\n", "utf8");
      for (let position = 0; position < size; position += FILE_HASH_SAMPLE_BYTES) {
        const length = Math.min(FILE_HASH_SAMPLE_BYTES, size - position);
        hash.update(await readFileSegment(handle, length, position));
      }
    } else if (size <= FILE_HASH_SAMPLE_BYTES * 2) {
      hash.update(await readFileSegment(handle, size, 0));
    } else {
      hash.update("first\n", "utf8");
      hash.update(await readFileSegment(handle, FILE_HASH_SAMPLE_BYTES, 0));
      hash.update("last\n", "utf8");
      hash.update(await readFileSegment(handle, FILE_HASH_SAMPLE_BYTES, size - FILE_HASH_SAMPLE_BYTES));
    }

    const after = await handle.stat({ bigint: true });
    if (
      !samePathIdentity(pathIdentity(before), pathIdentity(after)) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("file changed while binding");
    }
    const [pathStats, realPath] = await Promise.all([
      fs.lstat(filePath, { bigint: true }),
      fs.realpath(filePath),
    ]);
    if (
      pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || !samePathIdentity(pathIdentity(after), pathIdentity(pathStats))
      || !samePath(realPath, filePath)
    ) {
      throw new Error("file path changed while binding");
    }
    return Object.freeze({
      path: filePath,
      ...pathIdentity(after),
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      contentHash: hash.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function captureDirectoryBinding(directoryPath: string): Promise<DirectoryBinding> {
  const stats = await fs.stat(directoryPath, { bigint: true });
  if (!stats.isDirectory()) throw new Error("not a directory");
  return Object.freeze({ path: directoryPath, ...pathIdentity(stats) });
}

async function verifyFileBinding(binding: FileBinding): Promise<void> {
  const current = await captureFileBinding(binding.path);
  if (
    !samePathIdentity(binding, current) ||
    binding.size !== current.size ||
    binding.mtimeNs !== current.mtimeNs ||
    binding.ctimeNs !== current.ctimeNs ||
    binding.contentHash !== current.contentHash
  ) {
    throw new Error("file binding changed");
  }
}

async function verifyFullFileBinding(binding: FileBinding): Promise<void> {
  const current = await captureFileBinding(binding.path, "full");
  if (
    !samePathIdentity(binding, current)
    || binding.size !== current.size
    || binding.mtimeNs !== current.mtimeNs
    || binding.ctimeNs !== current.ctimeNs
    || binding.contentHash !== current.contentHash
  ) {
    throw new Error("file binding changed");
  }
}

async function verifyDirectoryBinding(binding: DirectoryBinding): Promise<void> {
  const current = await captureDirectoryBinding(binding.path);
  if (!samePathIdentity(binding, current)) throw new Error("directory binding changed");
}

async function captureNearestPackageJsonBinding(
  policy: WorkspacePolicy,
  workspaceRoot: string,
  cwd: string,
): Promise<FileBinding & { readonly workspacePath: string }> {
  let directory = cwd;
  while (isInside(workspaceRoot, directory)) {
    const candidate = path.join(directory, "package.json");
    try {
      const pathStats = await fs.lstat(candidate, { bigint: true });
      if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
        throw new Error("package.json is not a regular file");
      }
      const workspacePath = path.relative(workspaceRoot, candidate).split(path.sep).join("/");
      const resolved = await policy.resolveReadPath(workspacePath);
      if (!samePath(resolved.absolutePath, candidate)) {
        throw new Error("package.json path changed");
      }
      return Object.freeze({
        ...(await captureFileBinding(resolved.absolutePath, "full")),
        workspacePath,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (samePath(directory, workspaceRoot)) break;
    const parent = path.dirname(directory);
    if (samePath(parent, directory)) break;
    directory = parent;
  }
  throw new Error("package.json not found");
}

async function verifyNearestPackageJsonBinding(
  binding: FileBinding & { readonly workspacePath: string },
  policy: WorkspacePolicy,
  workspaceRoot: string,
  cwd: string,
): Promise<void> {
  const current = await captureNearestPackageJsonBinding(policy, workspaceRoot, cwd);
  if (!samePath(current.path, binding.path) || current.workspacePath !== binding.workspacePath) {
    throw new Error("nearest package.json changed");
  }
  await verifyFullFileBinding(binding);
}

export async function prepareNpmRuntimeBinding(
  workspaceRoot: string,
  cwdInput: string,
): Promise<PreparedNpmRuntimeBinding> {
  const policy = new WorkspacePolicy(workspaceRoot);
  const [resolvedRoot, resolvedCwd] = await Promise.all([
    policy.resolveReadPath("."),
    policy.resolveReadPath(cwdInput),
  ]);
  const cwdBinding = await captureDirectoryBinding(resolvedCwd.absolutePath);
  const nodeExecutable = await captureFileBinding(await fs.realpath(process.execPath));
  const npmCli = await captureFileBinding(await resolveNpmCli());
  const packageJson = await captureNearestPackageJsonBinding(
    policy,
    resolvedRoot.absolutePath,
    resolvedCwd.absolutePath,
  );
  return Object.freeze({
    workspaceRoot: resolvedRoot.absolutePath,
    cwd: resolvedCwd.absolutePath,
    relativeCwd: resolvedCwd.relativePath,
    cwdBinding,
    nodeExecutable,
    npmCli,
    packageJson,
  });
}

export async function verifyNpmRuntimeBinding(
  binding: PreparedNpmRuntimeBinding,
  workspaceRoot: string,
): Promise<void> {
  const policy = new WorkspacePolicy(workspaceRoot);
  const [resolvedRoot, resolvedCwd] = await Promise.all([
    policy.resolveReadPath("."),
    policy.resolveReadPath(binding.relativeCwd),
  ]);
  if (
    !samePath(resolvedRoot.absolutePath, binding.workspaceRoot)
    || !samePath(resolvedCwd.absolutePath, binding.cwd)
  ) {
    throw new Error("npm cwd path changed");
  }
  await verifyDirectoryBinding(binding.cwdBinding);
  await verifyFileBinding(binding.nodeExecutable);
  await verifyFileBinding(binding.npmCli);
  await verifyNearestPackageJsonBinding(
    binding.packageJson,
    policy,
    resolvedRoot.absolutePath,
    resolvedCwd.absolutePath,
  );
}

async function prepareCommand(input: RunCommandInput, workspaceRoot: string): Promise<PreparedCommand> {
  const workspacePolicy = new WorkspacePolicy(workspaceRoot);
  let resolvedCwd;
  let cwdBinding: DirectoryBinding;
  try {
    resolvedCwd = await workspacePolicy.resolveReadPath(input.cwd);
    cwdBinding = await captureDirectoryBinding(resolvedCwd.absolutePath);
  } catch {
    throw blocked("工作目录未通过工作区路径策略，必须是工作区内已存在的目录。", "工作目录未通过工作区路径策略。");
  }

  const policy = evaluateCommandPolicy(input.program, input.args);
  if (!policy.allowed) {
    throw blocked(policy.message, policy.auditReason);
  }
  let nodeEntry: PreparedCommand["nodeEntry"];
  if (policy.nodeEntryPath) {
    if (path.isAbsolute(policy.nodeEntryPath)) {
      throw blocked("Node 入口脚本必须是工作区相对路径。", "Node 入口脚本未通过工作区路径策略。");
    }
    const entryFromWorkspace = resolvedCwd.relativePath === "."
      ? policy.nodeEntryPath
      : path.join(resolvedCwd.relativePath, policy.nodeEntryPath);
    try {
      const resolvedEntry = await workspacePolicy.resolveReadPath(entryFromWorkspace);
      nodeEntry = Object.freeze({
        ...(await captureFileBinding(resolvedEntry.absolutePath)),
        workspacePath: entryFromWorkspace,
      });
    } catch {
      throw blocked(
        "Node 入口脚本必须是工作目录中已存在、且真实路径仍位于工作区内的普通文件。",
        "Node 入口脚本未通过工作区路径策略。",
      );
    }
  }

  let nodeExecutable: FileBinding;
  let npmCli: FileBinding | undefined;
  let packageJson: PreparedCommand["packageJson"];
  try {
    nodeExecutable = await captureFileBinding(await fs.realpath(process.execPath));
    if (policy.program === "npm") {
      npmCli = await captureFileBinding(await resolveNpmCli());
    }
  } catch {
    throw blocked(
      "无法安全绑定本机 Node/npm 执行入口。",
      "Node/npm 执行入口未通过身份与内容绑定。",
    );
  }
  if (policy.program === "npm" && npmActionRequiresPackageBinding(input.args)) {
    try {
      const resolvedRoot = await workspacePolicy.resolveReadPath(".");
      packageJson = await captureNearestPackageJsonBinding(
        workspacePolicy,
        resolvedRoot.absolutePath,
        resolvedCwd.absolutePath,
      );
    } catch {
      throw blocked(
        "npm 脚本或生命周期动作需要工作区内可安全绑定的最近 package.json。",
        "npm 项目定义未通过身份与完整内容绑定。",
      );
    }
  }

  const args = Object.freeze([...input.args]);
  return Object.freeze({
    program: policy.program,
    args,
    cwd: resolvedCwd.absolutePath,
    relativeCwd: resolvedCwd.relativePath,
    command: displayCommand(policy.program, args),
    riskLevel: policy.riskLevel,
    risk: policy.risk,
    auditReason: policy.auditReason,
    cwdBinding,
    nodeExecutable,
    ...(npmCli ? { npmCli } : {}),
    ...(packageJson ? { packageJson } : {}),
    ...(nodeEntry ? { nodeEntry } : {}),
  });
}

async function verifyPreparedCommand(prepared: PreparedCommand, workspaceRoot: string): Promise<void> {
  try {
    const resolvedCwd = await new WorkspacePolicy(workspaceRoot).resolveReadPath(prepared.relativeCwd);
    if (!samePath(resolvedCwd.absolutePath, prepared.cwd)) throw new Error("cwd path changed");
    await verifyDirectoryBinding(prepared.cwdBinding);
  } catch {
    throw blocked(
      "工作目录未通过工作区路径策略；审批期间可能已失效或被替换。",
      "工作目录在审批期间失效或身份发生变化。",
    );
  }

  if (prepared.nodeEntry) {
    try {
      const resolvedEntry = await new WorkspacePolicy(workspaceRoot).resolveReadPath(prepared.nodeEntry.workspacePath);
      if (!samePath(resolvedEntry.absolutePath, prepared.nodeEntry.path)) throw new Error("entry path changed");
      await verifyFileBinding(prepared.nodeEntry);
    } catch {
      throw blocked(
        "Node 入口脚本在审批期间失效、被替换或内容发生变化。",
        "Node 入口脚本未通过审批后身份与内容复核。",
      );
    }
  }

  try {
    await verifyFileBinding(prepared.nodeExecutable);
    if (prepared.npmCli) await verifyFileBinding(prepared.npmCli);
  } catch {
    throw blocked(
      "本机 Node/npm 执行入口在审批期间发生变化。",
      "Node/npm 执行入口未通过审批后身份与内容复核。",
    );
  }

  if (prepared.packageJson) {
    try {
      const freshPolicy = new WorkspacePolicy(workspaceRoot);
      const [resolvedRoot, resolvedCwd] = await Promise.all([
        freshPolicy.resolveReadPath("."),
        freshPolicy.resolveReadPath(prepared.relativeCwd),
      ]);
      await verifyNearestPackageJsonBinding(
        prepared.packageJson,
        freshPolicy,
        resolvedRoot.absolutePath,
        resolvedCwd.absolutePath,
      );
    } catch {
      throw blocked(
        "项目 package.json 在审批期间失效、被替换、内容发生变化，或出现了更近的包定义。",
        "npm 项目定义未通过审批后身份与完整内容复核。",
      );
    }
  }
}

class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    const npmCli = request.program === "npm" ? request.npmCliPath ?? await resolveNpmCli() : undefined;
    const executableArgs = npmCli ? [npmCli, ...request.args] : [...request.args];
    return runBoundedProcess({
      executable: request.nodeExecutablePath ?? process.execPath,
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

async function executePreparedCommand(
  prepared: PreparedCommand,
  context: Parameters<NonNullable<AgentTool<RunCommandInput, ToolExecutionOutput>["execute"]>>[1],
  runner: CommandRunner,
): Promise<ToolExecutionOutput> {
  await verifyPreparedCommand(prepared, context.workspaceRoot);
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
      nodeExecutablePath: prepared.nodeExecutable.path,
      ...(prepared.npmCli ? { npmCliPath: prepared.npmCli.path } : {}),
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
    async prepareCommandExecution(input, workspaceRoot) {
      const prepared = await prepareCommand(input, workspaceRoot);
      return {
        approvalRequest: {
          kind: "command",
          action: "run_command",
          command: prepared.command,
          workingDirectory: prepared.cwd,
          riskLevel: prepared.riskLevel,
          risk: prepared.risk,
        },
        execute: async (context) => executePreparedCommand(prepared, context, runner),
      };
    },
    async execute(input, context): Promise<ToolExecutionOutput> {
      const prepared = await prepareCommand(input, context.workspaceRoot);
      return executePreparedCommand(prepared, context, runner);
    },
  };
}

export const runCommand = createRunCommandTool();
