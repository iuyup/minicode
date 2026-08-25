import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveGitExecutable } from "../tools/inspect-git.ts";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/u;
const MAX_GIT_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_GIT_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_CONFIG_SCAN_BYTES = 128 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export interface EvaluationSourceProvenance {
  schemaVersion: 1;
  sourceCommit: string;
  dirty: boolean;
  /** 仅公开摘要；其输入包括状态、双向 diff 与未跟踪普通文件的路径和字节。 */
  dirtyStateSha256: string;
}

interface Digest {
  sha256: string;
  byteLength: number;
}

interface GitOutput extends Digest {
  output: Buffer;
}

const SAFE_ENVIRONMENT_NAMES = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function provenanceFailure(): Error {
  return new Error("无法安全采集评测源码来源快照；未读取 API Key，也未发送网络请求。");
}

function sameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasIncludeDirective(contents: string): boolean {
  return contents.split(/\r?\n/u).some((line) => {
    const candidate = line.replace(/^\uFEFF/u, "").trimStart();
    if (candidate.startsWith("#") || candidate.startsWith(";")) return false;
    return /^\[\s*include(?:if\b[^\]]*)?\s*\]/iu.test(candidate) ||
      /^include(?:if\b[^=]*)?\.path\s*=/iu.test(candidate);
  });
}

async function assertSafeRepositoryMetadata(root: string): Promise<void> {
  const rootStats = await fs.lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw provenanceFailure();
  const gitDirectory = path.join(root, ".git");
  const gitStats = await fs.lstat(gitDirectory);
  if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) throw provenanceFailure();

  for (const fileName of ["config", "config.worktree"] as const) {
    const target = path.join(gitDirectory, fileName);
    try {
      const stats = await fs.lstat(target);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_LOCAL_CONFIG_SCAN_BYTES) {
        throw provenanceFailure();
      }
      if (hasIncludeDirective(await fs.readFile(target, "utf8"))) throw provenanceFailure();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }

  for (const fileName of ["alternates", "http-alternates"] as const) {
    try {
      await fs.lstat(path.join(gitDirectory, "objects", "info", fileName));
      throw provenanceFailure();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

/** 只读取白名单变量，避免计划阶段枚举或读取 API Key。 */
function createGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (!SAFE_ENVIRONMENT_NAMES.has(name.toUpperCase())) continue;
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
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

function gitArguments(root: string, command: readonly string[]): string[] {
  const gitRoot = root.replaceAll("\\", "/");
  return [
    "-c", `safe.directory=${gitRoot}`,
    "-C", root,
    "--no-pager",
    "--no-optional-locks",
    "--no-lazy-fetch",
    "--no-replace-objects",
    "-c", "color.ui=false",
    "-c", `core.attributesFile=${nullDevice()}`,
    "-c", `core.excludesFile=${nullDevice()}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${nullDevice()}`,
    "-c", "diff.external=",
    "-c", "interactive.diffFilter=",
    ...command,
  ];
}

async function runGit(
  executable: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  command: readonly string[],
  captureOutput: true,
): Promise<GitOutput>;
async function runGit(
  executable: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  command: readonly string[],
  captureOutput: false,
): Promise<Digest>;
async function runGit(
  executable: string,
  root: string,
  environment: NodeJS.ProcessEnv,
  command: readonly string[],
  captureOutput: boolean,
): Promise<Digest | GitOutput> {
  const maxBytes = captureOutput ? MAX_GIT_CAPTURE_BYTES : MAX_GIT_STREAM_BYTES;
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let child;
  try {
    child = spawn(executable, gitArguments(root, command), {
      cwd: root,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw provenanceFailure();
  }

  return new Promise<Digest | GitOutput>((resolve, reject) => {
    let settled = false;
    let terminalError: Error | undefined;
    let forcedSettlement: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedSettlement) clearTimeout(forcedSettlement);
      if (error) {
        reject(error);
        return;
      }
      const result: Digest = { sha256: digest.digest("hex"), byteLength };
      resolve(captureOutput ? { ...result, output: Buffer.concat(chunks) } : result);
    };
    const stop = (): void => {
      if (terminalError) return;
      terminalError = provenanceFailure();
      child.kill();
      forcedSettlement = setTimeout(() => finish(terminalError), 1_000);
      forcedSettlement.unref();
    };
    const timeout = setTimeout(stop, GIT_TIMEOUT_MS);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminalError) return;
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        stop();
        return;
      }
      digest.update(chunk);
      if (captureOutput) chunks.push(chunk);
    });
    // 仅排空 stderr；其内容不能进入公开错误或产物。
    child.stderr.on("data", () => {});
    child.once("error", () => finish(provenanceFailure()));
    child.once("close", (exitCode) => {
      if (terminalError) finish(terminalError);
      else if (exitCode !== 0) finish(provenanceFailure());
      else finish();
    });
  });
}

function updateSizedBytes(hash: Hash, value: Uint8Array): void {
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(size);
  hash.update(value);
}

function updateDigest(hash: Hash, label: string, value: Digest): void {
  updateSizedBytes(hash, Buffer.from(label, "utf8"));
  updateSizedBytes(hash, Buffer.from(value.sha256, "hex"));
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(size);
}

async function digestRegularFile(target: string): Promise<Digest> {
  const stats = await fs.lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_UNTRACKED_FILE_BYTES) {
    throw provenanceFailure();
  }
  return new Promise<Digest>((resolve, reject) => {
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = createReadStream(target, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      byteLength += bytes.byteLength;
      if (byteLength > MAX_UNTRACKED_FILE_BYTES) {
        stream.destroy(provenanceFailure());
        return;
      }
      hash.update(bytes);
    });
    stream.once("error", () => reject(provenanceFailure()));
    stream.once("end", () => resolve({ sha256: hash.digest("hex"), byteLength }));
  });
}

function untrackedPaths(output: Buffer): Buffer[] {
  const paths = output.subarray(0, -1).toString("binary").split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => Buffer.from(entry, "binary"));
  if (output.length > 0 && output.at(-1) !== 0) throw provenanceFailure();
  return paths.sort(Buffer.compare);
}

async function dirtyStateSha256(
  root: string,
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ dirty: boolean; dirtyStateSha256: string }> {
  const [status, staged, unstaged, untracked] = await Promise.all([
    runGit(
      executable,
      root,
      environment,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none", "--no-renames", "--"],
      true,
    ),
    runGit(
      executable,
      root,
      environment,
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--", "."],
      false,
    ),
    runGit(
      executable,
      root,
      environment,
      ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--", "."],
      false,
    ),
    runGit(executable, root, environment, ["ls-files", "--others", "--exclude-standard", "-z", "--"], true),
  ]);
  const state = createHash("sha256");
  updateSizedBytes(state, Buffer.from("minicode-eval-dirty-state-v1", "utf8"));
  updateDigest(state, "status", status);
  updateDigest(state, "staged", staged);
  updateDigest(state, "unstaged", unstaged);
  const paths = untrackedPaths(untracked.output);
  updateSizedBytes(state, Buffer.from("untracked", "utf8"));
  for (const rawPath of paths) {
    const relative = rawPath.toString("utf8");
    if (!Buffer.from(relative, "utf8").equals(rawPath) || relative === "" || relative.includes("\0") ||
        path.isAbsolute(relative)) {
      throw provenanceFailure();
    }
    const target = path.resolve(root, relative);
    if (!sameOrInside(root, target)) throw provenanceFailure();
    const digest = await digestRegularFile(target);
    updateSizedBytes(state, rawPath);
    updateDigest(state, "file", digest);
  }
  return { dirty: status.byteLength > 0, dirtyStateSha256: state.digest("hex") };
}

export function assertEvaluationSourceProvenance(value: unknown): asserts value is EvaluationSourceProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw provenanceFailure();
  const candidate = value as Partial<EvaluationSourceProvenance>;
  if (candidate.schemaVersion !== 1 || typeof candidate.sourceCommit !== "string" ||
      !GIT_OBJECT_ID_PATTERN.test(candidate.sourceCommit) || typeof candidate.dirty !== "boolean" ||
      typeof candidate.dirtyStateSha256 !== "string" || !SHA256_PATTERN.test(candidate.dirtyStateSha256)) {
    throw provenanceFailure();
  }
}

export function sameEvaluationSourceProvenance(
  left: EvaluationSourceProvenance,
  right: EvaluationSourceProvenance,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.sourceCommit === right.sourceCommit &&
    left.dirty === right.dirty &&
    left.dirtyStateSha256 === right.dirtyStateSha256;
}

/**
 * 计划阶段的本地只读来源快照。所有原始 Git 输出和源码字节只参与哈希，绝不写入公开产物。
 */
export async function captureEvaluationSourceProvenance(
  workspaceRoot = process.cwd(),
): Promise<EvaluationSourceProvenance> {
  try {
    const root = await fs.realpath(workspaceRoot);
    await assertSafeRepositoryMetadata(root);
    const environment = createGitEnvironment();
    const executable = await resolveGitExecutable(root, environment);
    const readCommit = async (): Promise<string> => {
      const commit = await runGit(executable, root, environment, ["rev-parse", "--verify", "HEAD"], true);
      const sourceCommit = commit.output.toString("ascii").trim();
      if (!GIT_OBJECT_ID_PATTERN.test(sourceCommit)) throw provenanceFailure();
      return sourceCommit;
    };
    const sourceCommit = await readCommit();
    const state = await dirtyStateSha256(root, executable, environment);
    if (sourceCommit !== await readCommit()) throw provenanceFailure();
    const provenance: EvaluationSourceProvenance = {
      schemaVersion: 1,
      sourceCommit,
      ...state,
    };
    assertEvaluationSourceProvenance(provenance);
    return provenance;
  } catch {
    throw provenanceFailure();
  }
}
