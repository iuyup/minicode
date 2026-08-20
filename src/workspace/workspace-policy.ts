import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

export interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
}

const CUSTOM_IGNORE_FILE = ".minicodeignore";
const MAX_CUSTOM_IGNORE_BYTES = 64 * 1024;

const PROTECTED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".git",
  ".gnupg",
  ".ssh",
  "node_modules",
]);

const PROTECTED_FILE_NAMES = new Set([
  CUSTOM_IGNORE_FILE,
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "_netrc",
]);

interface LiteralIgnoreSegment {
  readonly kind: "pattern";
  readonly matcher: RegExp;
}

interface RecursiveIgnoreSegment {
  readonly kind: "recursive";
}

type IgnoreSegment = LiteralIgnoreSegment | RecursiveIgnoreSegment;

interface CustomIgnoreRule {
  readonly source: string;
  readonly segments: readonly IgnoreSegment[];
}

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

function normalizeDisplayPath(relativePath: string): string {
  return relativePath === "" || relativePath === "."
    ? "."
    : relativePath.replaceAll("\\", "/");
}

function pathSegments(relativePath: string): string[] {
  const normalized = normalizeDisplayPath(relativePath);
  return normalized === "." ? [] : normalized.split("/");
}

function isProtectedFileName(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    PROTECTED_FILE_NAMES.has(normalizedName)
    || normalizedName === ".env"
    || normalizedName.startsWith(".env.")
    || /^credentials.*\.json$/iu.test(normalizedName)
    || /^secrets\.(?:json|ya?ml)$/iu.test(normalizedName)
    || /^service-account.*\.json$/iu.test(normalizedName)
    || /\.(?:pem|key|p12|pfx)$/iu.test(normalizedName)
  );
}

/**
 * Built-in protection is deliberately basename-oriented and applies at every
 * directory depth. Custom ignore rules are evaluated separately against the
 * complete workspace-relative path.
 */
export function shouldSkipWorkspaceEntry(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => {
    const normalizedSegment = segment.toLowerCase();
    return PROTECTED_DIRECTORY_NAMES.has(normalizedSegment) || isProtectedFileName(segment);
  });
}

function escapeRegExp(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function compileSegment(segment: string): IgnoreSegment {
  if (segment === "**") {
    return { kind: "recursive" };
  }
  if (segment.includes("**")) {
    throw new WorkspaceAccessError(".minicodeignore 中的 ** 只能作为完整路径段使用。");
  }

  let expression = "^";
  for (const character of segment) {
    if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegExp(character);
    }
  }
  expression += "$";
  return { kind: "pattern", matcher: new RegExp(expression, "iu") };
}

function parseCustomIgnoreRule(sourceLine: string, lineNumber: number): CustomIgnoreRule | undefined {
  const source = sourceLine.trim();
  if (source === "" || source.startsWith("#")) {
    return undefined;
  }
  if (source.startsWith("!")) {
    throw new WorkspaceAccessError(
      `.minicodeignore 第 ${lineNumber} 行使用了不支持的 ! 反向规则。`,
    );
  }
  if (/\p{Cc}/u.test(source)) {
    throw new WorkspaceAccessError(`.minicodeignore 第 ${lineNumber} 行包含控制字符。`);
  }

  let normalized = source.replaceAll("\\", "/");
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (
    normalized === ""
    || normalized.startsWith("/")
    || /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new WorkspaceAccessError(`.minicodeignore 第 ${lineNumber} 行不是有效的根目录相对规则。`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorkspaceAccessError(`.minicodeignore 第 ${lineNumber} 行包含无效路径段。`);
  }
  if (segments.some((segment) => /[\[\]{}]/u.test(segment))) {
    throw new WorkspaceAccessError(
      `.minicodeignore 第 ${lineNumber} 行使用了不支持的字符类或花括号语法。`,
    );
  }

  return { source, segments: segments.map(compileSegment) };
}

function parseCustomIgnoreFile(content: string): readonly CustomIgnoreRule[] {
  const rules: CustomIgnoreRule[] = [];
  const lines = content.split(/\r\n|\n|\r/u);
  for (let index = 0; index < lines.length; index += 1) {
    const rule = parseCustomIgnoreRule(lines[index], index + 1);
    if (rule) rules.push(rule);
  }
  return rules;
}

function matchesRule(rule: CustomIgnoreRule, candidateSegments: readonly string[]): boolean {
  const memo = new Map<string, boolean>();
  const visit = (ruleIndex: number, candidateIndex: number): boolean => {
    const key = `${ruleIndex}:${candidateIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (ruleIndex === rule.segments.length) {
      result = candidateIndex === candidateSegments.length;
    } else {
      const segment = rule.segments[ruleIndex];
      if (segment.kind === "recursive") {
        result = visit(ruleIndex + 1, candidateIndex)
          || (candidateIndex < candidateSegments.length && visit(ruleIndex, candidateIndex + 1));
      } else {
        result = candidateIndex < candidateSegments.length
          && segment.matcher.test(candidateSegments[candidateIndex])
          && visit(ruleIndex + 1, candidateIndex + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  return visit(0, 0);
}

function matchesCustomIgnore(relativePath: string, rules: readonly CustomIgnoreRule[]): boolean {
  const segments = pathSegments(relativePath);
  for (const rule of rules) {
    if (matchesRule(rule, segments)) return true;
    // A rule matching a directory also protects every descendant. This keeps
    // direct reads consistent with list/search traversal pruning.
    for (let length = 1; length < segments.length; length += 1) {
      if (matchesRule(rule, segments.slice(0, length))) return true;
    }
  }
  return false;
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function toDisplayPath(relativePath: string): string {
  return normalizeDisplayPath(relativePath);
}

/**
 * 这是一层 Agent 路径策略，不是操作系统沙箱。
 * 所有实际读取前都解析真实路径，以防符号链接逃逸工作区。
 */
export class WorkspacePolicy {
  readonly #workspaceRoot: string;
  #customRulesPromise?: Promise<readonly CustomIgnoreRule[]>;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
  }

  async hasCustomIgnoreRules(): Promise<boolean> {
    return (await this.loadCustomIgnoreRules()).length > 0;
  }

  async shouldSkipPath(relativePath: string): Promise<boolean> {
    if (shouldSkipWorkspaceEntry(relativePath)) return true;
    return matchesCustomIgnore(relativePath, await this.loadCustomIgnoreRules());
  }

  async resolveReadPath(inputPath: string): Promise<WorkspacePath> {
    return this.resolveExistingPath(inputPath, "读取");
  }

  async resolveWritePath(inputPath: string): Promise<WorkspacePath> {
    return this.resolveExistingPath(inputPath, "写入");
  }

  private loadCustomIgnoreRules(): Promise<readonly CustomIgnoreRule[]> {
    this.#customRulesPromise ??= this.readCustomIgnoreRules();
    return this.#customRulesPromise;
  }

  private async readCustomIgnoreRules(): Promise<readonly CustomIgnoreRule[]> {
    const ignorePath = path.join(this.#workspaceRoot, CUSTOM_IGNORE_FILE);
    let initialStat;
    try {
      initialStat = await fs.lstat(ignorePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
      throw new WorkspaceAccessError("根目录 .minicodeignore 必须是普通文件，不能是链接或目录。");
    }
    if (initialStat.size > MAX_CUSTOM_IGNORE_BYTES) {
      throw new WorkspaceAccessError(`.minicodeignore 超过 ${MAX_CUSTOM_IGNORE_BYTES} 字节限制。`);
    }

    const handle = await fs.open(ignorePath, "r");
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > MAX_CUSTOM_IGNORE_BYTES) {
        throw new WorkspaceAccessError(`.minicodeignore 超过 ${MAX_CUSTOM_IGNORE_BYTES} 字节限制。`);
      }
      const buffer = Buffer.alloc(MAX_CUSTOM_IGNORE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_CUSTOM_IGNORE_BYTES) {
        throw new WorkspaceAccessError(`.minicodeignore 超过 ${MAX_CUSTOM_IGNORE_BYTES} 字节限制。`);
      }

      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new WorkspaceAccessError(".minicodeignore 不是有效的 UTF-8 文本。");
      }
      return parseCustomIgnoreFile(decoded);
    } finally {
      await handle.close();
    }
  }

  private async resolveExistingPath(
    inputPath: string,
    operation: "读取" | "写入",
  ): Promise<WorkspacePath> {
    if (inputPath.trim() === "") {
      throw new WorkspaceAccessError("路径不能为空。");
    }
    if (path.isAbsolute(inputPath)) {
      throw new WorkspaceAccessError("只允许传入相对于工作区的路径。");
    }

    const lexicalCandidate = path.resolve(this.#workspaceRoot, inputPath);
    if (!isInside(this.#workspaceRoot, lexicalCandidate)) {
      throw new WorkspaceAccessError("路径越出了工作区。");
    }

    let realWorkspaceRoot: string;
    let realCandidate: string;
    try {
      [realWorkspaceRoot, realCandidate] = await Promise.all([
        fs.realpath(this.#workspaceRoot),
        fs.realpath(lexicalCandidate),
      ]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new WorkspaceAccessError(`路径不存在：${inputPath}`);
      }
      throw error;
    }

    if (!isInside(realWorkspaceRoot, realCandidate)) {
      throw new WorkspaceAccessError(`解析真实路径后越出了工作区，已拒绝${operation}。`);
    }

    const relativePath = toDisplayPath(path.relative(realWorkspaceRoot, realCandidate));
    if (await this.shouldSkipPath(relativePath)) {
      throw new WorkspaceAccessError(`目标路径受保护，已拒绝${operation}。`);
    }

    return {
      absolutePath: realCandidate,
      relativePath,
    };
  }
}
