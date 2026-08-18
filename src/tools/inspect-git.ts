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
import { ToolExecutionError, ToolPolicyError } from "../agent/contracts.ts";
import { WorkspacePolicy } from "../workspace/workspace-policy.ts";
import {
  createSanitizedChildEnvironment,
  runBoundedProcess,
  type BoundedProcessResult,
} from "./child-process-safety.ts";
import { validateObjectWithKeys } from "./input-validation.ts";

export type GitInspectionAction = "status" | "diff" | "staged_diff";

export interface InspectGitInput {
  action: GitInspectionAction;
}

export interface GitRunRequest {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  action: string;
  maxOutputChars: number;
}

export interface GitRunner {
  run(request: GitRunRequest): Promise<BoundedProcessResult>;
}

interface PreparedRepository {
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  configurationProbeEnv: NodeJS.ProcessEnv;
}

const ACTIONS = new Set<GitInspectionAction>(["status", "diff", "staged_diff"]);
const MINIMUM_GIT_MAJOR = 2;
const MINIMUM_GIT_MINOR = 45;
const TIMEOUT_MS = 15_000;
const PREFLIGHT_OUTPUT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_LOCAL_CONFIG_SCAN_BYTES = 1_000_000;
const DANGEROUS_LOCAL_CONFIG_PATTERN =
  "^(filter\\..*\\.(clean|process|smudge)|diff\\.external|diff\\..*\\.(command|textconv))$";
const SAFE_NORMALIZATION_CONFIG_PATTERN = "^core\\.(autocrlf|eol|safecrlf)$";
const SAFE_NORMALIZATION_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  "core.autocrlf": new Set(["true", "false", "input"]),
  "core.eol": new Set(["lf", "crlf", "native"]),
  "core.safecrlf": new Set(["true", "false", "warn"]),
};

const PROTECTED_PATHSPECS = [
  ":(exclude,icase).env",
  ":(exclude,icase).env.*",
  ":(exclude,glob,icase)**/.env",
  ":(exclude,glob,icase)**/.env.*",
  ":(exclude,icase).npmrc",
  ":(exclude,glob,icase)**/.npmrc",
  ":(exclude,icase).yarnrc",
  ":(exclude,icase).yarnrc.yml",
  ":(exclude,glob,icase)**/.yarnrc",
  ":(exclude,glob,icase)**/.yarnrc.yml",
  ":(exclude,icase).pypirc",
  ":(exclude,glob,icase)**/.pypirc",
  ":(exclude,icase).netrc",
  ":(exclude,icase)_netrc",
  ":(exclude,glob,icase)**/.netrc",
  ":(exclude,glob,icase)**/_netrc",
  ":(exclude,icase).git-credentials",
  ":(exclude,glob,icase)**/.git-credentials",
  ":(exclude,glob,icase).aws/**",
  ":(exclude,glob,icase)**/.aws/**",
  ":(exclude,glob,icase).ssh/**",
  ":(exclude,glob,icase)**/.ssh/**",
  ":(exclude,glob,icase).gnupg/**",
  ":(exclude,glob,icase)**/.gnupg/**",
  ":(exclude,glob,icase)node_modules/**",
  ":(exclude,glob,icase)**/node_modules/**",
  ":(exclude,icase).git",
  ":(exclude,glob,icase)**/.git/**",
] as const;

function validate(input: JsonValue): ValidationResult<InspectGitInput> {
  const object = validateObjectWithKeys(input, ["action"]);
  if (!object.ok) return object;
  const action = object.value.action;
  if (typeof action !== "string" || !ACTIONS.has(action as GitInspectionAction)) {
    return { ok: false, error: "action 只能是 status、diff 或 staged_diff。" };
  }
  return { ok: true, value: { action: action as GitInspectionAction } };
}

function actionName(action: GitInspectionAction): string {
  switch (action) {
    case "status":
      return "git_status";
    case "diff":
      return "git_diff";
    case "staged_diff":
      return "git_staged_diff";
  }
}

function noResultMessage(action: GitInspectionAction): string {
  switch (action) {
    case "status":
      return "工作区干净（受保护路径不计入结果）。";
    case "diff":
      return "没有未暂存差异。";
    case "staged_diff":
      return "没有已暂存差异。";
  }
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function blocked(action: GitInspectionAction, message: string, reason: string): ToolPolicyError {
  return new ToolPolicyError(
    `Git 只读检查未执行：${message}`,
    { decision: "blocked", path: ".", reason },
    { action: actionName(action) },
  );
}

function metadata(action: GitInspectionAction, result: BoundedProcessResult): ToolExecutionMetadata {
  return {
    action: actionName(action),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputLength: result.outputLength,
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
  };
}

function createGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...createSanitizedChildEnvironment(),
    GCM_INTERACTIVE: "Never",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PAGER: "cat",
    TERM: "dumb",
  };
}

/**
 * 只用于读取三项换行规范化配置。继承常规用户配置位置，但调用方必须同时使用
 * `git config --no-includes` 和固定键名白名单；任何值都不能直接成为 Git 参数。
 */
function createGitConfigurationProbeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...createSanitizedChildEnvironment(),
    GCM_INTERACTIVE: "Never",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PAGER: "cat",
    TERM: "dumb",
  };
}

function repositoryGitArgs(): string[] {
  return [
    "--no-pager",
    "--no-optional-locks",
    "--no-lazy-fetch",
    "--no-replace-objects",
    "--git-dir=.git",
    "--work-tree=.",
  ];
}

function commonGitArgs(normalizationConfig: readonly string[] = []): string[] {
  return [
    ...repositoryGitArgs(),
    ...normalizationConfig.flatMap((configuration) => ["-c", configuration]),
    "-c",
    "color.ui=false",
    "-c",
    "core.quotepath=true",
    "-c",
    `core.attributesFile=${nullDevice()}`,
    "-c",
    `core.excludesFile=${nullDevice()}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${nullDevice()}`,
    "-c",
    "diff.external=",
    "-c",
    "interactive.diffFilter=",
  ];
}

function actionArgs(action: GitInspectionAction, normalizationConfig: readonly string[]): string[] {
  const visiblePaths = ["--", ".", ...PROTECTED_PATHSPECS];
  if (action === "status") {
    return [
      ...commonGitArgs(normalizationConfig),
      "status",
      "--porcelain=v1",
      "--branch",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=all",
      "--no-ahead-behind",
      ...visiblePaths,
    ];
  }
  return [
    ...commonGitArgs(normalizationConfig),
    "diff",
    ...(action === "staged_diff" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=all",
    ...visiblePaths,
  ];
}

function hasIncludeDirective(contents: string): boolean {
  return contents.split(/\r?\n/u).some((line) => {
    const candidate = line.replace(/^\uFEFF/u, "").trimStart();
    if (candidate.startsWith("#") || candidate.startsWith(";")) return false;
    return (
      /^\[\s*include(?:if\b[^\]]*)?\s*\]/iu.test(candidate) ||
      /^include(?:if\b[^=]*)?\.path\s*=/iu.test(candidate)
    );
  });
}

async function assertLocalConfigHasNoIncludes(
  action: GitInspectionAction,
  gitDirectory: string,
): Promise<void> {
  for (const fileName of ["config", "config.worktree"] as const) {
    const configPath = path.join(gitDirectory, fileName);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw blocked(action, "无法安全读取仓库配置。", "Git 配置文件未通过本地预扫描。");
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_CONFIG_SCAN_BYTES) {
      throw blocked(action, "仓库配置文件类型或大小不受支持。", "Git 配置文件未通过本地预扫描。");
    }
    let contents: string;
    try {
      contents = await fs.readFile(configPath, "utf8");
    } catch {
      throw blocked(action, "无法安全读取仓库配置。", "Git 配置文件未通过本地预扫描。");
    }
    if (hasIncludeDirective(contents)) {
      throw blocked(
        action,
        "仓库配置包含 include 或 includeIf；为避免读取工作区外或网络位置，本工具不会处理该仓库。",
        "Git 仓库配置包含外部 include 指令。",
      );
    }
  }
}

async function assertNoExternalObjectAlternates(
  action: GitInspectionAction,
  gitDirectory: string,
): Promise<void> {
  for (const fileName of ["alternates", "http-alternates"] as const) {
    const alternatePath = path.join(gitDirectory, "objects", "info", fileName);
    try {
      await fs.lstat(alternatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw blocked(action, "无法安全检查 Git 外部对象库配置。", "Git 对象库边界未通过本地预扫描。");
    }
    throw blocked(
      action,
      "仓库声明了外部 Git 对象库；为避免读取工作区外或网络位置，本工具不会处理该仓库。",
      "Git 仓库声明了外部对象库。",
    );
  }
}

function parseSafeNormalizationConfig(output: string): string[] {
  const effectiveValues = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^([^\s]+)\s+(.+)$/u);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().toLowerCase();
    const allowedValues = SAFE_NORMALIZATION_VALUES[key];
    if (!allowedValues) continue;
    if (allowedValues.has(value)) effectiveValues.set(key, value);
    else effectiveValues.delete(key);
  }
  return Object.keys(SAFE_NORMALIZATION_VALUES)
    .flatMap((key) => {
      const value = effectiveValues.get(key);
      return value === undefined ? [] : [`${key}=${value}`];
    });
}

function findEnvironmentValue(source: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(source).find(([key]) => key.toUpperCase() === name)?.[1];
}

function executableCandidates(source: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const root of [
      findEnvironmentValue(source, "PROGRAMFILES"),
      findEnvironmentValue(source, "PROGRAMW6432"),
      findEnvironmentValue(source, "LOCALAPPDATA"),
    ]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Git", "cmd", "git.exe"),
        path.join(root, "Git", "bin", "git.exe"),
        path.join(root, "Programs", "Git", "cmd", "git.exe"),
      );
    }
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
  }

  const pathValue = findEnvironmentValue(source, "PATH") ?? "";
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/gu, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    candidates.push(path.join(directory, executableName));
  }
  return [...new Set(candidates)];
}

/**
 * 将 Git 解析为工作区外的绝对普通文件，避免 Windows 当前目录中的同名程序劫持。
 */
export async function resolveGitExecutable(
  workspaceRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  const expectedName = process.platform === "win32" ? "git.exe" : "git";
  for (const candidate of executableCandidates(source)) {
    try {
      const realCandidate = await fs.realpath(candidate);
      const stats = await fs.stat(realCandidate);
      if (!stats.isFile()) continue;
      if (path.basename(realCandidate).toLowerCase() !== expectedName) continue;
      if (isInside(realWorkspaceRoot, realCandidate)) continue;
      return realCandidate;
    } catch {
      // 尝试下一个本机安装位置。
    }
  }
  throw new ToolExecutionError("未找到可信的 Git 可执行文件，未运行只读检查。", {
    action: "inspect_git",
  });
}

class BoundedGitRunner implements GitRunner {
  #executable: string | undefined;

  async run(request: GitRunRequest): Promise<BoundedProcessResult> {
    this.#executable ??= await resolveGitExecutable(request.cwd);
    return runBoundedProcess({
      executable: this.#executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      action: request.action,
      startFailureLabel: "Git 只读检查",
      timeoutMs: TIMEOUT_MS,
      maxOutputChars: request.maxOutputChars,
    });
  }
}

async function prepareRepository(
  action: GitInspectionAction,
  workspaceRoot: string,
): Promise<PreparedRepository> {
  const workspacePolicy = new WorkspacePolicy(workspaceRoot);
  let resolvedRoot;
  try {
    resolvedRoot = await workspacePolicy.resolveReadPath(".");
    const rootStats = await fs.stat(resolvedRoot.absolutePath);
    if (!rootStats.isDirectory()) throw new Error("not a directory");
  } catch {
    throw blocked(action, "工作区根目录不存在或未通过真实路径校验。", "工作区根目录未通过路径策略。");
  }

  const gitDirectory = path.join(resolvedRoot.absolutePath, ".git");
  try {
    const gitStats = await fs.lstat(gitDirectory);
    if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) throw new Error("not a local git directory");
    const realGitDirectory = await fs.realpath(gitDirectory);
    if (!samePath(realGitDirectory, path.join(resolvedRoot.absolutePath, ".git"))) {
      throw new Error("git directory escaped workspace");
    }
    try {
      await fs.lstat(path.join(realGitDirectory, "commondir"));
      throw new Error("linked worktree metadata");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await assertLocalConfigHasNoIncludes(action, realGitDirectory);
    await assertNoExternalObjectAlternates(action, realGitDirectory);
  } catch (error) {
    // 具体的策略错误需要保留，避免被下面的通用仓库边界错误覆盖。
    if (error instanceof ToolPolicyError) throw error;
    throw blocked(
      action,
      "第一版只支持工作区根目录内包含普通 .git 目录的仓库；非仓库、父级仓库和 linked worktree 均已拒绝。",
      "Git 元数据目录未通过工作区边界策略。",
    );
  }

  return {
    workspaceRoot: resolvedRoot.absolutePath,
    env: createGitEnvironment(),
    configurationProbeEnv: createGitConfigurationProbeEnvironment(),
  };
}

async function runPreflight(
  runner: GitRunner,
  repository: PreparedRepository,
  action: GitInspectionAction,
): Promise<readonly string[]> {
  const execute = (
    args: readonly string[],
    maxOutputChars = PREFLIGHT_OUTPUT_CHARS,
    env = repository.env,
  ) => runner.run({
    args,
    cwd: repository.workspaceRoot,
    env,
    action: actionName(action),
    maxOutputChars,
  });

  const version = await execute(["--version"]);
  if (version.timedOut || version.exitCode !== 0) {
    throw new ToolExecutionError("无法确认 Git 版本，未运行只读检查。", metadata(action, version));
  }
  const versionMatch = version.output.match(/\bgit version (\d+)\.(\d+)/iu);
  if (!versionMatch) {
    throw blocked(action, "无法识别 Git 版本。", "Git 版本未通过策略校验。");
  }
  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  if (major < MINIMUM_GIT_MAJOR || (major === MINIMUM_GIT_MAJOR && minor < MINIMUM_GIT_MINOR)) {
    throw blocked(
      action,
      `需要 Git ${MINIMUM_GIT_MAJOR}.${MINIMUM_GIT_MINOR} 或更高版本。`,
      "Git 版本低于只读策略要求。",
    );
  }

  const rootCheck = await execute([...commonGitArgs(), "rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (rootCheck.timedOut || rootCheck.exitCode !== 0) {
    const ownershipRejected = /dubious ownership|safe\.directory/iu.test(rootCheck.output);
    throw new ToolExecutionError(
      ownershipRejected
        ? "Git 拒绝了仓库所有权；本工具不会绕过该安全检查。请确认工作区由当前用户拥有后重试。"
        : "无法确认工作区是受支持的 Git 仓库根目录。",
      metadata(action, rootCheck),
    );
  }
  let realReportedRoot: string;
  try {
    realReportedRoot = await fs.realpath(rootCheck.output.trim());
  } catch {
    throw blocked(action, "Git 返回了无效的仓库根目录。", "Git 仓库根目录未通过真实路径校验。");
  }
  if (!samePath(realReportedRoot, repository.workspaceRoot)) {
    throw blocked(
      action,
      "工作区必须与 Git 仓库根目录完全一致。",
      "Git 仓库根目录越出了工作区边界。",
    );
  }

  const normalizationConfigResult = await execute(
    [
      ...repositoryGitArgs(),
      "config",
      "--no-includes",
      "--get-regexp",
      SAFE_NORMALIZATION_CONFIG_PATTERN,
    ],
    PREFLIGHT_OUTPUT_CHARS,
    repository.configurationProbeEnv,
  );
  if (normalizationConfigResult.timedOut) {
    throw new ToolExecutionError(
      "Git 换行配置检查超时，未运行只读检查。",
      metadata(action, normalizationConfigResult),
    );
  }
  if (normalizationConfigResult.exitCode !== 0 && normalizationConfigResult.exitCode !== 1) {
    throw new ToolExecutionError(
      "无法读取安全的 Git 换行配置，未运行只读检查。",
      metadata(action, normalizationConfigResult),
    );
  }
  const normalizationConfig = normalizationConfigResult.exitCode === 0
    ? parseSafeNormalizationConfig(normalizationConfigResult.output)
    : [];

  const dangerousConfig = await execute([
    ...repositoryGitArgs(),
    "config",
    "--no-includes",
    "--get-regexp",
    DANGEROUS_LOCAL_CONFIG_PATTERN,
  ]);
  if (dangerousConfig.timedOut) {
    throw new ToolExecutionError("Git 配置安全检查超时，未运行只读检查。", metadata(action, dangerousConfig));
  }
  if (dangerousConfig.exitCode === 0) {
    throw blocked(
      action,
      "仓库配置了可能启动外部进程的 Git filter 或 diff driver。请先人工审查；本工具不会执行它们。",
      "仓库包含外部 Git filter 或 diff driver 配置。",
    );
  }
  if (dangerousConfig.exitCode !== 1) {
    throw new ToolExecutionError("无法完成 Git 配置安全检查，未运行只读检查。", metadata(action, dangerousConfig));
  }
  return normalizationConfig;
}

function renderResult(action: GitInspectionAction, result: BoundedProcessResult): string {
  const rawOutput = result.output.trimEnd();
  const statusLines = rawOutput.split("\n").filter((line) => line.length > 0);
  const statusIsClean = action === "status" && statusLines.length > 0 && statusLines.every((line) => line.startsWith("## "));
  const output = rawOutput.length === 0
    ? noResultMessage(action)
    : statusIsClean
      ? `${rawOutput}\n${noResultMessage(action)}`
      : rawOutput;
  const truncationNotice = result.outputTruncated ? "\n[Git 输出已截断]" : "";
  return [
    `Git 只读动作：${action}`,
    "范围：工作区根目录（.env、常见凭据配置、node_modules 与 .git 已排除）",
    "结果：",
    `${output}${truncationNotice}`,
  ].join("\n");
}

export function createInspectGitTool(
  runner: GitRunner = new BoundedGitRunner(),
): AgentTool<InspectGitInput, ToolExecutionOutput> {
  return {
    name: "inspect_git",
    description: "读取工作区根仓库的固定 Git 状态、未暂存差异或已暂存差异。只接受三个枚举动作，不开放路径、任意 Git 参数或写操作；受保护路径不会进入结果。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "diff", "staged_diff"],
          description: "status 查看分支与变更文件；diff 查看未暂存差异；staged_diff 查看已暂存差异。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    validate,
    async execute(input, context): Promise<ToolExecutionOutput> {
      const repository = await prepareRepository(input.action, context.workspaceRoot);
      const normalizationConfig = await runPreflight(runner, repository, input.action);
      context.recordPolicyDecision?.({
        decision: "allowed",
        path: ".",
        reason: `允许固定只读 Git 动作：${input.action}。`,
      });

      let result: BoundedProcessResult;
      try {
        result = await runner.run({
          args: actionArgs(input.action, normalizationConfig),
          cwd: repository.workspaceRoot,
          env: repository.env,
          action: actionName(input.action),
          maxOutputChars: MAX_OUTPUT_CHARS,
        });
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw new ToolExecutionError(error.message, {
            ...error.metadata,
            action: actionName(input.action),
          });
        }
        throw new ToolExecutionError("Git 只读检查无法启动。", { action: actionName(input.action) });
      }

      const resultMetadata = metadata(input.action, result);
      if (result.timedOut) {
        throw new ToolExecutionError(`Git 只读检查超时（${TIMEOUT_MS}ms）。`, resultMetadata);
      }
      if (result.exitCode !== 0) {
        throw new ToolExecutionError("Git 只读检查失败；底层错误输出未发送给模型。", resultMetadata);
      }
      return { content: renderResult(input.action, result), metadata: resultMetadata };
    },
  };
}

export const inspectGit = createInspectGitTool();
