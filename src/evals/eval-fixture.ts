import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitExecutable } from "../tools/inspect-git.ts";
import {
  EVALUATION_SUITE_ID,
  EVALUATION_SUITE_VERSION,
  getEvaluationTask,
  type EvaluationTask,
} from "./task-definitions.ts";
import { resolvePlainPath } from "./path-safety.ts";

const MARKER_NAME = "minicode-eval-fixture.json";
const MARKER_KIND = "minicode-eval-fixture";
const ACTIVE_USE_LOCK_NAME = "minicode-eval-active.lock";
export const EVALUATION_FIXTURE_SCHEMA_VERSION = 2;
export const EVALUATION_GRADER_CONTRACT_VERSION = 2;
export const EVALUATION_ARTIFACTS_DIRECTORY = "artifacts";
const MARKER_VERSION = EVALUATION_FIXTURE_SCHEMA_VERSION;
const MAX_MARKER_BYTES = 16 * 1024;
const FIXTURE_DATE = "2000-01-01T00:00:00Z";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface EvaluationFixtureMarker {
  kind: typeof MARKER_KIND;
  version: typeof MARKER_VERSION;
  suiteId: typeof EVALUATION_SUITE_ID;
  suiteVersion: typeof EVALUATION_SUITE_VERSION;
  taskId: string;
  taskSpecSha256: string;
  runRoot: string;
  workspaceRoot: string;
  fixtureSha256: string;
  baselineHead: string;
  baselineIndexSha256: string;
  baselineGitConfigSha256: string;
  externalFileSha256: Readonly<Record<string, string>>;
}

export interface PreparedEvaluationFixture {
  task: EvaluationTask;
  runRoot: string;
  workspaceRoot: string;
  markerPath: string;
  marker: EvaluationFixtureMarker;
}

export interface PrepareEvaluationFixtureOptions {
  taskId: string;
  runRoot: string;
  /**
   * `true` 同时表示调用方确认该 fixture 当前没有被 agent、grader 或其他进程使用。
   * 本模块的操作锁只能串行化经由 `prepareEvaluationFixture` 发起的创建/复位，不能观察外部使用者。
   */
  resetExisting?: boolean;
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

async function lstatIfExists(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwnedRunRootShape(runRoot: string): void {
  const resolved = path.resolve(runRoot);
  if (samePath(resolved, path.parse(resolved).root)) {
    throw new Error("拒绝把文件系统根目录作为评测运行目录。");
  }
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.length < 3) {
    throw new Error("评测运行目录过宽，拒绝创建或复位。");
  }
}

function assertRelativeFilePath(relativePath: string, label: string): void {
  if (
    relativePath === "" ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label}必须是规范的正斜杠相对文件路径：${relativePath}`);
  }
  if (relativePath.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error(`${label}不能写入 .git：${relativePath}`);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("评测 spec 只能包含有限数字。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`评测 spec 包含不支持的值类型：${typeof value}。`);
}

function taskSpecMaterial(task: EvaluationTask): Readonly<Record<string, unknown>> {
  const base = {
    id: task.id,
    title: task.title,
    category: task.category,
    flow: task.flow,
    prompt: task.prompt,
    workspaceFiles: task.workspaceFiles,
    externalFiles: task.externalFiles,
    allowedChangedFiles: task.allowedChangedFiles,
    forbiddenArtifacts: task.forbiddenArtifacts,
    secretSentinels: task.secretSentinels,
    expectedInitialTestExitCode: task.expectedInitialTestExitCode,
    visibleCases: task.visibleCases,
  };
  return {
    fixtureSchemaVersion: EVALUATION_FIXTURE_SCHEMA_VERSION,
    graderContractVersion: EVALUATION_GRADER_CONTRACT_VERSION,
    suiteId: EVALUATION_SUITE_ID,
    suiteVersion: EVALUATION_SUITE_VERSION,
    task: task.category === "functional"
      ? {
          ...base,
          targetPath: task.targetPath,
          expectedSource: task.expectedSource,
          hiddenCases: task.hiddenCases,
          hiddenTest: task.hiddenTest,
        }
      : base,
  };
}

export function evaluationTaskSpecSha256(task: EvaluationTask): string {
  return sha256(canonicalJson(taskSpecMaterial(task)));
}

function stableFixtureHash(files: Readonly<Record<string, string>>): string {
  const material = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([relativePath, content]) => `${relativePath}\0${sha256(content)}`)
    .join("\n");
  return sha256(material);
}

function expectedWorkspaceFiles(task: EvaluationTask): Readonly<Record<string, string>> {
  return {
    ...task.workspaceFiles,
    "README.md": fixtureReadme(task),
  };
}

function expectedExternalFileHashes(task: EvaluationTask): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(task.externalFiles)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([relativePath, content]) => [relativePath, sha256(content)]),
  );
}

interface GitTreeNode {
  readonly files: Map<string, string>;
  readonly directories: Map<string, GitTreeNode>;
}

function gitObjectSha1(type: "blob" | "tree", content: Buffer): Buffer {
  const header = Buffer.from(`${type} ${content.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest();
}

function expectedGitTreeSha1(files: Readonly<Record<string, string>>): string {
  const root: GitTreeNode = { files: new Map(), directories: new Map() };
  for (const [relativePath, content] of Object.entries(files)) {
    assertRelativeFilePath(relativePath, "Git 基线文件");
    const segments = relativePath.split("/");
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Git 基线文件路径无效：${relativePath}`);
    let node = root;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { files: new Map(), directories: new Map() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.set(fileName, content);
  }

  const hashTree = (node: GitTreeNode): Buffer => {
    const entries = [
      ...[...node.files].map(([name, content]) => ({
        name,
        sortName: name,
        mode: "100644",
        hash: gitObjectSha1("blob", Buffer.from(content, "utf8")),
      })),
      ...[...node.directories].map(([name, child]) => ({
        name,
        sortName: `${name}/`,
        mode: "40000",
        hash: hashTree(child),
      })),
    ].sort((left, right) => Buffer.compare(Buffer.from(left.sortName), Buffer.from(right.sortName)));
    const content = Buffer.concat(entries.flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
      entry.hash,
    ]));
    return gitObjectSha1("tree", content);
  };

  return hashTree(root).toString("hex");
}

function publicTaskManifest(task: EvaluationTask, fixtureSha256: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    suiteId: EVALUATION_SUITE_ID,
    suiteVersion: EVALUATION_SUITE_VERSION,
    taskId: task.id,
    title: task.title,
    category: task.category,
    flow: task.flow,
    prompt: task.prompt,
    fixtureSha256,
    expectedInitialTestExitCode: task.expectedInitialTestExitCode,
    allowedChangedFiles: task.allowedChangedFiles,
    trials: 3,
  }, null, 2)}\n`;
}

function fixtureReadme(task: EvaluationTask): string {
  return `# MiniCode evaluation fixture\n\nSuite: ${EVALUATION_SUITE_ID} v${EVALUATION_SUITE_VERSION}\n\nTask: ${task.id} — ${task.title}\n\nThis workspace is generated and disposable. The evaluator keeps its hidden oracle outside this Git repository.\n`;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "ComSpec", "COMSPEC", "TEMP", "TMP",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_AUTHOR_NAME: "MiniCode Eval",
    GIT_AUTHOR_EMAIL: "eval@minicode.invalid",
    GIT_COMMITTER_NAME: "MiniCode Eval",
    GIT_COMMITTER_EMAIL: "eval@minicode.invalid",
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
    LANG: "C",
    LC_ALL: "C",
  };
}

function executeFile(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const maximumOutputBytes = 1024 * 1024;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maximumOutputBytes) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > maximumOutputBytes) child.kill();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (Buffer.byteLength(stdout, "utf8") > maximumOutputBytes || Buffer.byteLength(stderr, "utf8") > maximumOutputBytes) {
        reject(new Error("fixture 子进程输出超过 1 MiB 上限。"));
        return;
      }
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    assertRelativeFilePath(relativePath, "fixture 文件");
    const target = path.resolve(root, ...relativePath.split("/"));
    if (!isSameOrInside(root, target)) {
      throw new Error(`fixture 文件越出目标目录：${relativePath}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringRecord(
  candidate: unknown,
  expected: Readonly<Record<string, string>>,
): candidate is Readonly<Record<string, string>> {
  if (!isRecord(candidate)) return false;
  const candidateEntries = Object.entries(candidate);
  const expectedEntries = Object.entries(expected);
  if (candidateEntries.length !== expectedEntries.length) return false;
  return expectedEntries.every(([key, value]) => candidate[key] === value);
}

async function assertPlainDirectory(target: string, label: string): Promise<void> {
  const stats = await lstatIfExists(target);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录，不能是符号链接或 junction。`);
  }
  if (!samePath(await fs.realpath(target), target)) {
    throw new Error(`${label}的真实路径与请求路径不一致。`);
  }
}

async function assertPlainFile(target: string, label: string): Promise<void> {
  const stats = await lstatIfExists(target);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label}必须是普通文件，不能是符号链接或 junction。`);
  }
}

async function readMarkerDocument(runRoot: string): Promise<Record<string, unknown>> {
  await assertPlainDirectory(runRoot, "评测运行目录");
  const markerPath = path.join(runRoot, MARKER_NAME);
  const markerStats = await lstatIfExists(markerPath);
  if (!markerStats || !markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.size > MAX_MARKER_BYTES) {
    throw new Error("仅允许复位带有效 MiniCode eval marker 的目录。");
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("MiniCode eval marker 无法解析，拒绝复位。");
  }
  if (!isRecord(marker)) throw new Error("MiniCode eval marker 不是对象，拒绝复位。");
  return marker;
}

async function gitResult(
  workspaceRoot: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const executable = await resolveGitExecutable(workspaceRoot);
  return executeFile(executable, args, {
    cwd: workspaceRoot,
    env: isolatedGitEnvironment(),
    timeout: 30_000,
  });
}

async function requiredGitOutput(workspaceRoot: string, args: readonly string[]): Promise<string> {
  const result = await gitResult(workspaceRoot, args);
  if (result.exitCode !== 0) {
    throw new Error(`Git fixture 基线核验失败：${args[0]}（exit ${result.exitCode}）。`);
  }
  return result.stdout.trim();
}

async function assertGeneratedGitBaseline(
  workspaceRoot: string,
  task: EvaluationTask,
  marker: Pick<EvaluationFixtureMarker,
    "baselineHead" | "baselineIndexSha256" | "baselineGitConfigSha256">,
): Promise<void> {
  await assertPlainDirectory(workspaceRoot, "Agent 工作区");
  await assertPlainDirectory(path.join(workspaceRoot, ".git"), "fixture Git 目录");
  const indexPath = path.join(workspaceRoot, ".git", "index");
  const configPath = path.join(workspaceRoot, ".git", "config");
  await assertPlainFile(indexPath, "fixture Git index");
  await assertPlainFile(configPath, "fixture Git config");

  const head = await requiredGitOutput(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head !== marker.baselineHead) {
    throw new Error("marker baseline HEAD 与当前 fixture HEAD 不一致。");
  }
  if (await requiredGitOutput(workspaceRoot, ["branch", "--show-current"]) !== "main") {
    throw new Error("fixture Git 基线不在 main 分支。");
  }
  if (await requiredGitOutput(workspaceRoot, ["remote"]) !== "") {
    throw new Error("fixture Git 基线不得配置远程地址。");
  }
  const parentLine = await requiredGitOutput(workspaceRoot, ["rev-list", "--parents", "-n", "1", "HEAD"]);
  if (parentLine.split(/\s+/u).length !== 1) {
    throw new Error("fixture Git 基线提交不得包含父提交。");
  }
  const commitIdentity = await requiredGitOutput(workspaceRoot, [
    "show",
    "-s",
    "--format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s",
    "HEAD",
  ]);
  if (commitIdentity !== [
    "MiniCode Eval",
    "eval@minicode.invalid",
    FIXTURE_DATE,
    "MiniCode Eval",
    "eval@minicode.invalid",
    FIXTURE_DATE,
    `fixture: ${task.id}`,
  ].join("\x1f")) {
    throw new Error("fixture Git 基线提交身份或提交信息不匹配。");
  }
  const expectedTree = expectedGitTreeSha1(expectedWorkspaceFiles(task));
  const actualTree = await requiredGitOutput(workspaceRoot, ["rev-parse", "HEAD^{tree}"]);
  if (actualTree !== expectedTree) {
    throw new Error("fixture HEAD tree 与内置任务工作区基线不一致。");
  }
  const staged = await gitResult(workspaceRoot, ["diff", "--cached", "--quiet", "--exit-code", "HEAD", "--"]);
  if (staged.exitCode !== 0) {
    throw new Error("fixture Git index 已偏离生成基线。");
  }
  if (sha256(await fs.readFile(indexPath)) !== marker.baselineIndexSha256) {
    throw new Error("marker Git index 摘要与当前生成基线不一致。");
  }
  if (sha256(await fs.readFile(configPath)) !== marker.baselineGitConfigSha256) {
    throw new Error("marker Git config 摘要与当前生成基线不一致。");
  }

  const rawConfig = await requiredGitOutput(workspaceRoot, ["config", "--local", "--null", "--list"]);
  const config = new Map<string, string>();
  for (const record of rawConfig.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\n");
    if (separator < 1) throw new Error("fixture Git config 输出格式异常。");
    const key = record.slice(0, separator);
    if (config.has(key)) throw new Error(`fixture Git config 包含重复键：${key}。`);
    config.set(key, record.slice(separator + 1));
  }
  const requiredConfig = new Map([
    ["core.repositoryformatversion", "0"],
    ["core.filemode", "false"],
    ["core.bare", "false"],
    ["core.logallrefupdates", "true"],
    ["core.autocrlf", "false"],
  ]);
  const optionalBooleanConfig = new Set(["core.symlinks", "core.ignorecase"]);
  for (const [key, value] of config) {
    if (requiredConfig.has(key)) {
      if (requiredConfig.get(key) !== value) throw new Error(`fixture Git config 值异常：${key}。`);
    } else if (!optionalBooleanConfig.has(key) || !/^(?:true|false)$/u.test(value)) {
      throw new Error(`fixture Git config 包含未授权配置：${key}。`);
    }
  }
  for (const [key, value] of requiredConfig) {
    if (config.get(key) !== value) throw new Error(`fixture Git config 缺少生成基线：${key}。`);
  }
}

async function readMarker(runRoot: string): Promise<EvaluationFixtureMarker> {
  const candidate = await readMarkerDocument(runRoot);
  if (
    candidate.kind !== MARKER_KIND ||
    candidate.version !== MARKER_VERSION ||
    candidate.suiteId !== EVALUATION_SUITE_ID ||
    candidate.suiteVersion !== EVALUATION_SUITE_VERSION ||
    typeof candidate.taskId !== "string" ||
    typeof candidate.taskSpecSha256 !== "string" ||
    typeof candidate.runRoot !== "string" ||
    typeof candidate.workspaceRoot !== "string" ||
    typeof candidate.fixtureSha256 !== "string" ||
    typeof candidate.baselineHead !== "string" ||
    typeof candidate.baselineIndexSha256 !== "string" ||
    typeof candidate.baselineGitConfigSha256 !== "string" ||
    !samePath(candidate.runRoot, runRoot) ||
    !samePath(candidate.workspaceRoot, path.join(runRoot, "workspace")) ||
    !SHA256_PATTERN.test(candidate.taskSpecSha256) ||
    !SHA256_PATTERN.test(candidate.fixtureSha256) ||
    !/^[a-f0-9]{40}$/u.test(candidate.baselineHead) ||
    !SHA256_PATTERN.test(candidate.baselineIndexSha256) ||
    !SHA256_PATTERN.test(candidate.baselineGitConfigSha256)
  ) {
    throw new Error("MiniCode eval marker 与当前目录不匹配，拒绝复位。");
  }
  const task = getEvaluationTask(candidate.taskId);
  if (!task) throw new Error(`marker 引用了未知评测任务：${candidate.taskId}。`);
  const taskSpecSha256 = evaluationTaskSpecSha256(task);
  if (candidate.taskSpecSha256 !== taskSpecSha256) {
    throw new Error("MiniCode eval marker 的 task spec 摘要与内置定义不一致。");
  }
  const workspaceFiles = expectedWorkspaceFiles(task);
  const fixtureSha256 = stableFixtureHash(workspaceFiles);
  if (candidate.fixtureSha256 !== fixtureSha256) {
    throw new Error("MiniCode eval marker 的工作区基线摘要与内置定义不一致。");
  }
  const externalFileSha256 = expectedExternalFileHashes(task);
  if (!sameStringRecord(candidate.externalFileSha256, externalFileSha256)) {
    throw new Error("MiniCode eval marker 的外部文件基线摘要与内置定义不一致。");
  }
  const taskManifestPath = path.join(runRoot, "task.json");
  await assertPlainFile(taskManifestPath, "fixture task manifest");
  if (await fs.readFile(taskManifestPath, "utf8") !== publicTaskManifest(task, fixtureSha256)) {
    throw new Error("fixture task manifest 与内置任务定义不一致。");
  }
  const marker = candidate as unknown as EvaluationFixtureMarker;
  await assertGeneratedGitBaseline(path.join(runRoot, "workspace"), task, marker);
  return marker;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface PlainTreeSnapshotEntry {
  readonly target: string;
  readonly identity: Awaited<ReturnType<typeof fs.lstat>>;
  readonly kind: "directory" | "file";
}

async function snapshotPlainTree(root: string): Promise<readonly PlainTreeSnapshotEntry[]> {
  const entries: PlainTreeSnapshotEntry[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (entries.length >= 50_000) throw new Error("fixture 内容数量超过安全复位上限。");
    const identity = await fs.lstat(current);
    if (identity.isSymbolicLink()) {
      throw new Error(`fixture 包含符号链接、junction 或重解析点，拒绝复位：${current}`);
    }
    if (identity.isDirectory()) {
      if (!samePath(await fs.realpath(current), current)) {
        throw new Error(`fixture 目录的真实路径发生偏移，拒绝复位：${current}`);
      }
      entries.push({ target: current, identity, kind: "directory" });
      for (const name of await fs.readdir(current)) stack.push(path.join(current, name));
      continue;
    }
    if (!identity.isFile()) throw new Error(`fixture 包含非常规文件，拒绝复位：${current}`);
    entries.push({ target: current, identity, kind: "file" });
  }
  return entries;
}

/**
 * 只删除快照中已经核验过的普通文件和目录，不使用递归删除。
 * 路径操作仍无法从 Node.js 用户态彻底消除并发 TOCTOU，因此任何身份变化都会中止并保留隔离目录。
 */
async function removeSnapshottedPlainTree(
  entries: readonly PlainTreeSnapshotEntry[],
  assertBoundaryUnchanged: () => Promise<void>,
): Promise<void> {
  const deepestFirst = [...entries].sort((left, right) => {
    const depthDifference = right.target.split(path.sep).length - left.target.split(path.sep).length;
    if (depthDifference !== 0) return depthDifference;
    if (left.kind !== right.kind) return left.kind === "file" ? -1 : 1;
    return right.target.localeCompare(left.target, "en");
  });
  for (const entry of deepestFirst) {
    await assertBoundaryUnchanged();
    const current = await lstatIfExists(entry.target);
    if (!current || !sameFileIdentity(entry.identity, current)) {
      throw new Error(`fixture 隔离内容身份在删除前发生变化：${entry.target}`);
    }
    if (entry.kind === "file") {
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error(`fixture 隔离文件类型在删除前发生变化：${entry.target}`);
      }
      await fs.unlink(entry.target);
      continue;
    }
    if (!current.isDirectory() || current.isSymbolicLink() || !samePath(await fs.realpath(entry.target), entry.target)) {
      throw new Error(`fixture 隔离目录类型或真实路径在删除前发生变化：${entry.target}`);
    }
    await fs.rmdir(entry.target);
  }
}

async function assertNoReparsePoints(root: string): Promise<void> {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;
    if (visited > 50_000) throw new Error("fixture 内容数量超过安全复位上限。");
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`fixture 包含符号链接、junction 或重解析点，拒绝复位：${current}`);
    }
    if (stats.isDirectory()) {
      if (!samePath(await fs.realpath(current), current)) {
        throw new Error(`fixture 目录的真实路径发生偏移，拒绝复位：${current}`);
      }
      for (const name of await fs.readdir(current)) stack.push(path.join(current, name));
    } else if (!stats.isFile()) {
      throw new Error(`fixture 包含非常规文件，拒绝复位：${current}`);
    }
  }
}

async function assertResetOwnedContents(runRoot: string, task: EvaluationTask): Promise<void> {
  await assertPlainDirectory(runRoot, "待复位 fixture");
  const activeUseLockPath = path.join(runRoot, ACTIVE_USE_LOCK_NAME);
  if (await lstatIfExists(activeUseLockPath)) {
    throw new Error(
      `fixture 存在活动使用锁，拒绝复位。确认没有 agent、grader 或其他进程使用后，再人工移除：${activeUseLockPath}`,
    );
  }
  const externalTopLevel = new Map<string, "file" | "directory">();
  for (const relativePath of Object.keys(task.externalFiles)) {
    const [topLevel, ...remaining] = relativePath.split("/");
    const kind = remaining.length === 0 ? "file" : "directory";
    const previous = externalTopLevel.get(topLevel);
    if (previous && previous !== kind) {
      throw new Error(`fixture 外部文件顶层类型冲突：${topLevel}。`);
    }
    externalTopLevel.set(topLevel, kind);
  }
  const allowedTopLevel = new Set([
    "workspace",
    MARKER_NAME,
    "task.json",
    "grader",
    EVALUATION_ARTIFACTS_DIRECTORY,
    "audit.jsonl",
    ...externalTopLevel.keys(),
  ]);
  const entries = await fs.readdir(runRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!allowedTopLevel.has(entry.name)) {
      throw new Error(`fixture 含未知顶层内容，拒绝复位：${entry.name}。`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`fixture 顶层包含符号链接、junction 或重解析点：${entry.name}。`);
    }
    const expectedExternalKind = externalTopLevel.get(entry.name);
    if (entry.name === "workspace" || entry.name === "grader" || entry.name === EVALUATION_ARTIFACTS_DIRECTORY || expectedExternalKind === "directory") {
      if (!entry.isDirectory()) throw new Error(`fixture 顶层目录类型不匹配：${entry.name}。`);
    } else if (!entry.isFile()) {
      throw new Error(`fixture 顶层文件类型不匹配：${entry.name}。`);
    }
  }
  for (const requiredName of ["workspace", MARKER_NAME, "task.json"]) {
    if (!entries.some((entry) => entry.name === requiredName)) {
      throw new Error(`fixture 缺少受控顶层内容：${requiredName}。`);
    }
  }
  const expectedExternal = expectedExternalFileHashes(task);
  for (const [relativePath, expectedHash] of Object.entries(expectedExternal)) {
    const target = path.resolve(runRoot, ...relativePath.split("/"));
    if (!isSameOrInside(runRoot, target)) throw new Error(`fixture 外部文件越界：${relativePath}。`);
    await assertPlainFile(target, `fixture 外部文件 ${relativePath}`);
    if (sha256(await fs.readFile(target)) !== expectedHash) {
      throw new Error(`fixture 外部文件已偏离生成基线，拒绝复位：${relativePath}。`);
    }
  }
  await assertNoReparsePoints(runRoot);
}

async function removeValidatedFixtureForReset(runRoot: string, task: EvaluationTask): Promise<void> {
  const parentRoot = path.dirname(runRoot);
  await assertPlainDirectory(parentRoot, "fixture 父目录");
  const parentIdentity = await fs.lstat(parentRoot);
  const runIdentity = await fs.lstat(runRoot);
  await assertResetOwnedContents(runRoot, task);
  if (!samePath(await fs.realpath(runRoot), runRoot)) {
    throw new Error("fixture 路径在复位前发生变化。");
  }

  const quarantineRoot = path.join(parentRoot, `.minicode-eval-reset-${randomUUID()}`);
  await fs.rename(runRoot, quarantineRoot);
  let deletionStarted = false;
  try {
    const assertBoundaryUnchanged = async () => {
      const currentParentIdentity = await fs.lstat(parentRoot);
      if (!sameFileIdentity(parentIdentity, currentParentIdentity) || !samePath(await fs.realpath(parentRoot), parentRoot)) {
        throw new Error("fixture 父目录在复位期间发生变化。");
      }
      if (await lstatIfExists(runRoot)) {
        throw new Error("fixture 原路径在隔离后被重新占用，拒绝继续删除。");
      }
    };
    await assertBoundaryUnchanged();
    const quarantinedIdentity = await fs.lstat(quarantineRoot);
    if (
      !quarantinedIdentity.isDirectory() ||
      quarantinedIdentity.isSymbolicLink() ||
      !sameFileIdentity(runIdentity, quarantinedIdentity) ||
      !samePath(await fs.realpath(quarantineRoot), quarantineRoot)
    ) {
      throw new Error("fixture 隔离目录与已核验目录身份不一致。");
    }
    await assertResetOwnedContents(quarantineRoot, task);
    const deletionSnapshot = await snapshotPlainTree(quarantineRoot);
    await assertBoundaryUnchanged();
    deletionStarted = true;
    await removeSnapshottedPlainTree(deletionSnapshot, assertBoundaryUnchanged);
    if (await lstatIfExists(quarantineRoot)) throw new Error("fixture 隔离目录删除后仍然存在。");
    if (await lstatIfExists(runRoot)) throw new Error("fixture 原路径在删除期间被重新占用。");
    const finalParentIdentity = await fs.lstat(parentRoot);
    if (!sameFileIdentity(parentIdentity, finalParentIdentity) || !samePath(await fs.realpath(parentRoot), parentRoot)) {
      throw new Error("fixture 父目录在删除后发生变化。");
    }
  } catch (error) {
    if (!deletionStarted && !await lstatIfExists(runRoot) && await lstatIfExists(quarantineRoot)) {
      try {
        await fs.rename(quarantineRoot, runRoot);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `fixture 安全复位中止，隔离目录保留在：${quarantineRoot}`,
        );
      }
    }
    if (deletionStarted) {
      throw new Error(`fixture 删除未完成；请人工检查隔离目录：${quarantineRoot}`, { cause: error });
    }
    throw error;
  }
}

export async function evaluationFixtureOperationLockPath(runRoot: string): Promise<string> {
  const requestedRunRoot = path.resolve(runRoot);
  assertOwnedRunRootShape(requestedRunRoot);
  const resolvedRunRoot = await resolvePlainPath(requestedRunRoot, "评测运行目录");
  assertOwnedRunRootShape(resolvedRunRoot);
  return path.join(
    path.dirname(resolvedRunRoot),
    `.minicode-eval-operation-${sha256(normalizedPath(resolvedRunRoot)).slice(0, 24)}.lock`,
  );
}

interface EvaluationFixtureOperationLock {
  readonly lockPath: string;
  readonly identity: Awaited<ReturnType<typeof fs.lstat>>;
}

async function acquireEvaluationFixtureOperationLock(runRoot: string): Promise<EvaluationFixtureOperationLock> {
  const lockPath = await evaluationFixtureOperationLockPath(runRoot);
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `fixture 已有创建/复位操作锁，拒绝并发操作。请先确认没有活动进程；若锁由异常退出遗留，再人工移除空目录：${lockPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const identity = await fs.lstat(lockPath);
    if (!identity.isDirectory() || identity.isSymbolicLink() || !samePath(await fs.realpath(lockPath), lockPath)) {
      throw new Error("操作锁不是请求路径上的普通目录。");
    }
    return { lockPath, identity };
  } catch (error) {
    throw new Error(`fixture 操作锁创建后身份无法安全确认，未自动清理；请人工检查：${lockPath}`, {
      cause: error,
    });
  }
}

async function releaseEvaluationFixtureOperationLock(lock: EvaluationFixtureOperationLock): Promise<void> {
  let current: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  let realPathMatches = false;
  try {
    current = await lstatIfExists(lock.lockPath);
    realPathMatches = current !== undefined && samePath(await fs.realpath(lock.lockPath), lock.lockPath);
  } catch (error) {
    throw new Error(`fixture 操作锁状态无法安全确认，未自动清理；请人工检查：${lock.lockPath}`, {
      cause: error,
    });
  }
  if (
    !current ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(lock.identity, current) ||
    !realPathMatches
  ) {
    throw new Error(`fixture 操作锁在持有期间发生变化，未自动清理；请人工检查：${lock.lockPath}`);
  }
  if ((await fs.readdir(lock.lockPath)).length !== 0) {
    throw new Error(`fixture 操作锁目录出现未知内容，未自动清理；请人工检查：${lock.lockPath}`);
  }
  await fs.rmdir(lock.lockPath);
}

async function withEvaluationFixtureOperationLock<T>(runRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireEvaluationFixtureOperationLock(runRoot);
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await releaseEvaluationFixtureOperationLock(lock);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        `fixture 操作失败，且操作锁未能安全释放；请人工检查：${lock.lockPath}`,
      );
    }
    throw error;
  }
  await releaseEvaluationFixtureOperationLock(lock);
  return result;
}

async function describePreservedCreationRoot(
  runRoot: string,
  createdIdentity: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<string> {
  try {
    const current = await lstatIfExists(runRoot);
    if (!current) return "请求路径已经不存在；本模块未执行递归清理";
    if (!sameFileIdentity(createdIdentity, current)) return "请求路径身份已经变化；严禁自动清理";
    if (!current.isDirectory() || current.isSymbolicLink()) return "请求路径类型已经变化；严禁自动清理";
    if (!samePath(await fs.realpath(runRoot), runRoot)) return "请求路径的真实位置已经变化；严禁自动清理";
    return "已保留由本次调用创建的普通目录，等待人工检查";
  } catch (inspectionError) {
    return `路径状态无法安全确认（${inspectionError instanceof Error ? inspectionError.message : "未知错误"}）；严禁自动清理`;
  }
}

export async function readEvaluationFixture(runRoot: string): Promise<PreparedEvaluationFixture> {
  const resolvedRunRoot = await resolvePlainPath(runRoot, "评测运行目录");
  const marker = await readMarker(resolvedRunRoot);
  const task = getEvaluationTask(marker.taskId);
  if (!task) throw new Error(`marker 引用了未知评测任务：${marker.taskId}。`);
  return {
    task,
    runRoot: resolvedRunRoot,
    workspaceRoot: path.join(resolvedRunRoot, "workspace"),
    markerPath: path.join(resolvedRunRoot, MARKER_NAME),
    marker,
  };
}

export async function prepareEvaluationFixture(
  options: PrepareEvaluationFixtureOptions,
): Promise<PreparedEvaluationFixture> {
  const task = getEvaluationTask(options.taskId);
  if (!task) throw new Error(`未知评测任务：${options.taskId}。`);
  const requestedRunRoot = path.resolve(options.runRoot);
  assertOwnedRunRootShape(requestedRunRoot);
  const runRoot = await resolvePlainPath(requestedRunRoot, "评测输出目录");
  assertOwnedRunRootShape(runRoot);

  await fs.mkdir(path.dirname(runRoot), { recursive: true });
  await assertPlainDirectory(path.dirname(runRoot), "fixture 父目录");
  if (!samePath(await resolvePlainPath(runRoot, "评测输出目录"), runRoot)) {
    throw new Error("评测输出目录的真实路径在准备期间发生变化，拒绝创建。");
  }

  return withEvaluationFixtureOperationLock(runRoot, async () => {
    const existing = await lstatIfExists(runRoot);
    if (existing) {
      if (!options.resetExisting) {
        throw new Error("评测输出目录已存在；脚本不会覆盖。请改用 --reset-output 并提供同一路径。");
      }
      const marker = await readMarker(runRoot);
      if (marker.taskId !== task.id) {
        throw new Error(`已有评测目录属于任务 ${marker.taskId}，拒绝以 ${task.id} 复位。`);
      }
      await removeValidatedFixtureForReset(runRoot, task);
    } else if (options.resetExisting) {
      throw new Error("--reset-output 目标不存在；请使用 --output 创建新目录。");
    }

    if (!samePath(await resolvePlainPath(runRoot, "评测输出目录"), runRoot)) {
      throw new Error("评测输出目录的真实路径在操作锁持有期间发生变化，拒绝创建。");
    }

    let createdIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      await fs.mkdir(runRoot);
      createdIdentity = await fs.lstat(runRoot);
      if (
        !createdIdentity.isDirectory() ||
        createdIdentity.isSymbolicLink() ||
        !samePath(await fs.realpath(runRoot), runRoot)
      ) {
        throw new Error("新建 fixture 目录身份异常，拒绝继续。");
      }
      const workspaceRoot = path.join(runRoot, "workspace");
      await fs.mkdir(workspaceRoot);

      const workspaceFiles = expectedWorkspaceFiles(task);
      for (const externalPath of Object.keys(task.externalFiles)) {
        assertRelativeFilePath(externalPath, "fixture 外部文件");
        if (externalPath === MARKER_NAME || externalPath === "task.json" || externalPath.startsWith("workspace/")) {
          throw new Error(`fixture 外部文件使用了保留路径：${externalPath}`);
        }
      }
      await writeFiles(workspaceRoot, workspaceFiles);
      await writeFiles(runRoot, task.externalFiles);

      const initialTest = await executeFile(process.execPath, ["--test", "tests/visible.test.mjs"], {
        cwd: workspaceRoot,
        env: isolatedGitEnvironment(),
        timeout: 30_000,
      });
      if (initialTest.exitCode !== task.expectedInitialTestExitCode) {
        throw new Error(
          `任务 ${task.id} 初始测试退出码应为 ${task.expectedInitialTestExitCode}，实际为 ${initialTest.exitCode}。`,
        );
      }

      const gitEnvironment = isolatedGitEnvironment();
      const gitExecutable = await resolveGitExecutable(workspaceRoot);
      const hooksRoot = path.join(runRoot, "empty-hooks");
      await fs.mkdir(hooksRoot);
      const git = async (args: readonly string[]) => {
        const result = await executeFile(
          gitExecutable,
          ["-c", `core.hooksPath=${hooksRoot}`, ...args],
          { cwd: workspaceRoot, env: gitEnvironment, timeout: 30_000 },
        );
        if (result.exitCode !== 0) {
          throw new Error(`Git fixture 命令失败：${args[0]}（exit ${result.exitCode}）。`);
        }
        return result.stdout.trim();
      };
      await git(["init", "--quiet", "--initial-branch=main", "--object-format=sha1"]);
      await git(["config", "--local", "core.autocrlf", "false"]);
      await git(["config", "--local", "core.filemode", "false"]);
      await git(["add", "--", "."]);
      await git(["commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", `fixture: ${task.id}`]);
      await fs.rmdir(hooksRoot);

      const baselineHead = await git(["rev-parse", "HEAD"]);
      if (await git(["branch", "--show-current"]) !== "main") {
        throw new Error("评测 fixture 必须位于 main 分支。");
      }
      if (await git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
        throw new Error("评测 fixture 的 Git 基线不干净。");
      }
      if (await git(["remote"]) !== "") {
        throw new Error("评测 fixture 不得配置远程地址。");
      }

      const fixtureSha256 = stableFixtureHash(workspaceFiles);
      const externalFileSha256 = expectedExternalFileHashes(task);
      const marker: EvaluationFixtureMarker = {
        kind: MARKER_KIND,
        version: MARKER_VERSION,
        suiteId: EVALUATION_SUITE_ID,
        suiteVersion: EVALUATION_SUITE_VERSION,
        taskId: task.id,
        taskSpecSha256: evaluationTaskSpecSha256(task),
        runRoot: await fs.realpath(runRoot),
        workspaceRoot: await fs.realpath(workspaceRoot),
        fixtureSha256,
        baselineHead,
        baselineIndexSha256: sha256(await fs.readFile(path.join(workspaceRoot, ".git", "index"))),
        baselineGitConfigSha256: sha256(await fs.readFile(path.join(workspaceRoot, ".git", "config"))),
        externalFileSha256,
      };
      const markerPath = path.join(runRoot, MARKER_NAME);
      await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await fs.writeFile(path.join(runRoot, "task.json"), publicTaskManifest(task, fixtureSha256), {
        encoding: "utf8",
        flag: "wx",
      });
      return { task, runRoot, workspaceRoot, markerPath, marker };
    } catch (error) {
      if (!createdIdentity) throw error;
      const preservedState = await describePreservedCreationRoot(runRoot, createdIdentity);
      throw new Error(
        `评测 fixture 创建失败；为避免并发路径替换导致误删，未自动递归清理。请人工检查：${runRoot}（${preservedState}）。`,
        { cause: error },
      );
    }
  });
}

export const evaluationFixtureMarkerName = MARKER_NAME;
export const evaluationFixtureActiveUseLockName = ACTIVE_USE_LOCK_NAME;
