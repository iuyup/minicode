import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveGitExecutable } from "../src/tools/inspect-git.ts";

const execFileAsync = promisify(execFile);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const templateRoot = path.resolve(projectRoot, "fixtures", "edit-smoke");
const playgroundRoot = path.resolve(projectRoot, "playground");
const defaultWorkspaceRoot = path.resolve(playgroundRoot, "edit-smoke");
const FIXTURE_DATE = "2000-01-01T00:00:00Z";
const FIXTURE_MARKER_NAME = "minicode-edit-smoke-fixture.json";
const FIXTURE_MARKER_KIND = "minicode-edit-smoke-fixture";
const FIXTURE_MARKER_VERSION = 1;
const MAX_FIXTURE_MARKER_BYTES = 4_096;
const MINIMUM_GIT_MAJOR = 2;
const MINIMUM_GIT_MINOR = 45;

function parseWorkspaceRequest(args) {
  if (args.length === 0) {
    return { mode: "default", workspaceRoot: defaultWorkspaceRoot };
  }
  if (args.length !== 2 || !args[1]) {
    throw new Error("仅支持无参数、--output <尚不存在的目录> 或 --reset-output <已标记目录>。");
  }
  if (args[0] === "--output") {
    return { mode: "output", workspaceRoot: path.resolve(args[1]) };
  }
  if (args[0] === "--reset-output") {
    return { mode: "reset-output", workspaceRoot: path.resolve(args[1]) };
  }
  throw new Error("仅支持无参数、--output <尚不存在的目录> 或 --reset-output <已标记目录>。");
}

function normalizedPath(target) {
  const normalized = path.normalize(path.resolve(target));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isSameOrInside(parent, candidate) {
  const relative = path.relative(normalizedPath(parent), normalizedPath(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function projectedRealPath(target) {
  let cursor = path.resolve(target);
  const missingSegments = [];

  while (true) {
    const stats = await lstatIfExists(cursor);
    if (stats) {
      if (missingSegments.length > 0) {
        const followedStats = await fs.stat(cursor);
        if (!followedStats.isDirectory()) {
          throw new Error(`目标路径的既有祖先不是目录：${cursor}`);
        }
      }
      const realAncestor = await fs.realpath(cursor);
      return path.resolve(realAncestor, ...missingSegments);
    }

    const parent = path.dirname(cursor);
    if (samePath(parent, cursor)) {
      throw new Error(`无法解析目标路径的既有祖先：${target}`);
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
  }
}

async function assertPlainDirectory(target, label) {
  const stats = await lstatIfExists(target);
  if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label}必须是普通目录，不能是符号链接或 junction：${target}`);
  }
  return stats;
}

function assertNoTemplateOverlap(realTemplateRoot, projectedWorkspaceRoot) {
  if (
    isSameOrInside(realTemplateRoot, projectedWorkspaceRoot) ||
    isSameOrInside(projectedWorkspaceRoot, realTemplateRoot)
  ) {
    throw new Error("冒烟工作区不能与模板目录重叠（已按真实路径检查）。");
  }
}

function isolatedGitEnvironment() {
  const source = process.env;
  const env = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_AUTHOR_NAME: "MiniCode Fixture",
    GIT_AUTHOR_EMAIL: "fixture@minicode.invalid",
    GIT_COMMITTER_NAME: "MiniCode Fixture",
    GIT_COMMITTER_EMAIL: "fixture@minicode.invalid",
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
    LANG: "C",
    LC_ALL: "C",
  };
}

async function assertSupportedGit(gitExecutable, gitEnvironment) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(gitExecutable, ["--version"], {
      cwd: templateRoot,
      env: gitEnvironment,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }));
  } catch {
    throw new Error("无法确认 Git 版本；未删除或创建冒烟工作区。");
  }

  const match = stdout.trim().match(/^git version (\d+)\.(\d+)/iu);
  if (!match) {
    throw new Error("无法识别 Git 版本；未删除或创建冒烟工作区。");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MINIMUM_GIT_MAJOR || (major === MINIMUM_GIT_MAJOR && minor < MINIMUM_GIT_MINOR)) {
    throw new Error(
      `需要 Git ${MINIMUM_GIT_MAJOR}.${MINIMUM_GIT_MINOR} 或更高版本；未删除或创建冒烟工作区。`,
    );
  }
}

async function assertDefaultPathBoundary(realProjectRoot, realTemplateRoot) {
  const expectedPlaygroundRoot = path.join(realProjectRoot, "playground");
  let playgroundStats = await lstatIfExists(playgroundRoot);
  if (!playgroundStats) {
    await fs.mkdir(playgroundRoot);
    playgroundStats = await lstatIfExists(playgroundRoot);
  }
  if (!playgroundStats || !playgroundStats.isDirectory() || playgroundStats.isSymbolicLink()) {
    throw new Error("默认 playground 必须是普通目录，不能是符号链接或 junction。");
  }

  const realPlaygroundRoot = await fs.realpath(playgroundRoot);
  if (!samePath(realPlaygroundRoot, expectedPlaygroundRoot)) {
    throw new Error("默认 playground 的真实路径偏离项目目录，已停止操作。");
  }

  const expectedWorkspaceRoot = path.join(realPlaygroundRoot, "edit-smoke");
  const workspaceStats = await lstatIfExists(defaultWorkspaceRoot);
  if (workspaceStats) {
    if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) {
      throw new Error("默认冒烟工作区必须是普通目录，不能是符号链接或 junction。");
    }
    const realWorkspaceRoot = await fs.realpath(defaultWorkspaceRoot);
    if (!samePath(realWorkspaceRoot, expectedWorkspaceRoot)) {
      throw new Error("默认冒烟工作区的真实路径偏离 playground，已停止操作。");
    }
    await readFixtureMarker(defaultWorkspaceRoot, realWorkspaceRoot);
  } else {
    const projectedWorkspaceRoot = await projectedRealPath(defaultWorkspaceRoot);
    if (!samePath(projectedWorkspaceRoot, expectedWorkspaceRoot)) {
      throw new Error("默认冒烟工作区的目标路径偏离 playground，已停止操作。");
    }
  }

  assertNoTemplateOverlap(realTemplateRoot, expectedWorkspaceRoot);
  return { projectedWorkspaceRoot: expectedWorkspaceRoot, resetExisting: Boolean(workspaceStats) };
}

async function assertTemplateContainsOnlyPlainEntries(directory = templateRoot) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`fixture 模板不能包含符号链接或 junction：${entryPath}`);
    }
    if (stats.isDirectory()) {
      await assertTemplateContainsOnlyPlainEntries(entryPath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`fixture 模板只能包含普通文件和目录：${entryPath}`);
    }
  }
}

async function readFixtureMarker(workspaceRoot, realWorkspaceRoot) {
  const gitDirectory = path.join(workspaceRoot, ".git");
  await assertPlainDirectory(gitDirectory, "冒烟工作区的 .git");
  const realGitDirectory = await fs.realpath(gitDirectory);
  if (!samePath(realGitDirectory, path.join(realWorkspaceRoot, ".git"))) {
    throw new Error("冒烟工作区的 .git 真实路径越出了目标目录，拒绝复位。");
  }

  const markerPath = path.join(gitDirectory, FIXTURE_MARKER_NAME);
  const markerStats = await lstatIfExists(markerPath);
  if (
    !markerStats ||
    !markerStats.isFile() ||
    markerStats.isSymbolicLink() ||
    markerStats.size > MAX_FIXTURE_MARKER_BYTES
  ) {
    throw new Error("--reset-output 仅允许复位带有效 MiniCode fixture marker 的目录。");
  }

  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("MiniCode fixture marker 无法解析，拒绝复位。");
  }
  if (
    marker?.kind !== FIXTURE_MARKER_KIND ||
    marker?.version !== FIXTURE_MARKER_VERSION ||
    typeof marker?.workspaceRoot !== "string" ||
    !samePath(marker.workspaceRoot, realWorkspaceRoot)
  ) {
    throw new Error("MiniCode fixture marker 与当前目录不匹配，拒绝复位。");
  }
}

async function assertCustomPathBoundary(mode, workspaceRoot, realTemplateRoot) {
  if (samePath(workspaceRoot, defaultWorkspaceRoot)) {
    throw new Error("playground/edit-smoke 是默认工作区；请无参数运行，不要使用自定义输出参数。");
  }

  const existingStats = await lstatIfExists(workspaceRoot);
  if (mode === "output" && existingStats) {
    throw new Error("--output 目标必须尚不存在；脚本不会覆盖或删除该目录。");
  }
  if (mode === "reset-output") {
    await assertPlainDirectory(workspaceRoot, "--reset-output 目标");
  }

  const projectedWorkspaceRoot = await projectedRealPath(workspaceRoot);
  assertNoTemplateOverlap(realTemplateRoot, projectedWorkspaceRoot);

  if (mode === "reset-output") {
    await readFixtureMarker(workspaceRoot, projectedWorkspaceRoot);
  }
  return { projectedWorkspaceRoot, resetExisting: mode === "reset-output" };
}

async function copyTemplateContents(workspaceRoot) {
  const entries = await fs.readdir(templateRoot, { withFileTypes: true });
  for (const entry of entries) {
    await fs.cp(
      path.join(templateRoot, entry.name),
      path.join(workspaceRoot, entry.name),
      { recursive: true, force: false, errorOnExist: true, dereference: false },
    );
  }
}

async function runWithHooksCleanup(emptyHooksRoot, callback) {
  let operationError;
  try {
    await fs.mkdir(emptyHooksRoot);
    await callback();
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    await fs.rm(emptyHooksRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    cleanupError = error;
  }

  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], "Git 初始化失败，且临时 hooks 目录清理失败。");
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}

async function cleanupFailedWorkspace(workspaceRoot, originalError) {
  try {
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `冒烟工作区创建失败，且半成品清理失败：${workspaceRoot}`,
    );
  }
  throw originalError;
}

const request = parseWorkspaceRequest(process.argv.slice(2));
const { mode, workspaceRoot } = request;

if (samePath(workspaceRoot, path.parse(workspaceRoot).root)) {
  throw new Error("拒绝把文件系统根目录作为冒烟工作区。");
}

const gitEnvironment = isolatedGitEnvironment();
const gitExecutable = await resolveGitExecutable(templateRoot);
await assertSupportedGit(gitExecutable, gitEnvironment);

const realTemplateRoot = await fs.realpath(templateRoot);
const realProjectRoot = await fs.realpath(projectRoot);
await assertTemplateContainsOnlyPlainEntries();
const boundary = mode === "default"
  ? await assertDefaultPathBoundary(realProjectRoot, realTemplateRoot)
  : await assertCustomPathBoundary(mode, workspaceRoot, realTemplateRoot);

let workspaceCreated = false;
let baselineHead;
try {
  if (boundary.resetExisting) {
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  await fs.mkdir(path.dirname(workspaceRoot), { recursive: true });
  const projectedAfterParentCreation = await projectedRealPath(workspaceRoot);
  if (!samePath(projectedAfterParentCreation, boundary.projectedWorkspaceRoot)) {
    throw new Error("目标目录的真实路径在准备期间发生变化，已停止操作。");
  }
  assertNoTemplateOverlap(realTemplateRoot, projectedAfterParentCreation);

  await fs.mkdir(workspaceRoot);
  workspaceCreated = true;
  await copyTemplateContents(workspaceRoot);

  const realWorkspaceRoot = await fs.realpath(workspaceRoot);
  if (!samePath(realWorkspaceRoot, boundary.projectedWorkspaceRoot)) {
    throw new Error("新建工作区的真实路径与预检结果不一致，已停止操作。");
  }

  const emptyHooksRoot = path.join(workspaceRoot, ".minicode-empty-hooks");
  async function git(args) {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ["-c", `core.hooksPath=${emptyHooksRoot}`, ...args],
      {
        cwd: workspaceRoot,
        env: gitEnvironment,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    return stdout.trim();
  }

  await runWithHooksCleanup(emptyHooksRoot, async () => {
    await git(["init", "--quiet", "--initial-branch=main", "--object-format=sha1"]);
    await git(["config", "--local", "core.autocrlf", "false"]);
    await git(["config", "--local", "core.filemode", "false"]);
    await git([
      "add",
      "--",
      ".gitattributes",
      "README.md",
      "package.json",
      "src/greeting.js",
      "tests/greeting.test.mjs",
    ]);
    await git([
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "fixture: baseline broken greeting",
    ]);
  });

  const topLevel = await fs.realpath(await git(["rev-parse", "--show-toplevel"]));
  if (!samePath(topLevel, realWorkspaceRoot)) {
    throw new Error("Git 根目录与冒烟工作区不一致，已停止。");
  }
  if (await git(["branch", "--show-current"]) !== "main") {
    throw new Error("冒烟仓库必须位于 main 分支。");
  }
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("冒烟仓库基线不是干净状态。");
  }
  if (await git(["remote"]) !== "") {
    throw new Error("冒烟仓库不得配置远程地址。");
  }
  baselineHead = await git(["rev-parse", "HEAD"]);

  const gitDirectory = path.join(workspaceRoot, ".git");
  await assertPlainDirectory(gitDirectory, "新建冒烟工作区的 .git");
  if (!samePath(await fs.realpath(gitDirectory), path.join(realWorkspaceRoot, ".git"))) {
    throw new Error("新建冒烟工作区的 .git 真实路径越出了目标目录。");
  }
  await fs.writeFile(
    path.join(gitDirectory, FIXTURE_MARKER_NAME),
    `${JSON.stringify({
      kind: FIXTURE_MARKER_KIND,
      version: FIXTURE_MARKER_VERSION,
      workspaceRoot: realWorkspaceRoot,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
} catch (error) {
  if (workspaceCreated) await cleanupFailedWorkspace(workspaceRoot, error);
  throw error;
}

console.log(`已创建可复位测试工作区：${workspaceRoot}`);
console.log(`基线：main @ ${baselineHead.slice(0, 12)}（本地 fixture commit）`);
if (mode === "output") {
  console.log(`需要复位时运行：node scripts/create-edit-smoke-workspace.mjs --reset-output "${workspaceRoot}"`);
} else {
  console.log("该目录不访问网络；重复运行会恢复带缺陷的初始状态并丢弃目标目录中的改动。");
}
