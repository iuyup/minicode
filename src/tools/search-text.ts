import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";
import { ToolExecutionError } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy, shouldSkipWorkspaceEntry } from "../workspace/workspace-policy.ts";
import { validateObjectWithKeys, validateOptionalPath } from "./input-validation.ts";
import { decodeUtf8Strict, InvalidUtf8Error } from "./text-decoding.ts";

interface SearchTextInput {
  query: string;
  path?: string;
}

const MAX_FILES_TO_SCAN = 200;
const MAX_DIRECTORIES_TO_SCAN = 400;
const MAX_SEARCH_DEPTH = 12;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_SEARCH_MS = 5_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_MATCHES = 20;
const MAX_LINE_CHARS = 220;

function validate(input: JsonValue): ValidationResult<SearchTextInput> {
  const object = validateObjectWithKeys(input, ["query", "path"]);
  if (!object.ok) {
    return object;
  }
  if (typeof object.value.query !== "string" || object.value.query.trim() === "") {
    return { ok: false, error: "query 必须是非空字符串。" };
  }
  const searchPath = validateOptionalPath(object.value);
  return searchPath.ok
    ? {
        ok: true,
        value: {
          query: object.value.query,
          ...(searchPath.value ? { path: searchPath.value } : {}),
        },
      }
    : searchPath;
}

interface SearchBudget {
  readonly files: string[];
  readonly deadline: number;
  readonly signal?: AbortSignal;
  directoriesVisited: number;
  fileLimitReached: boolean;
  directoryLimitReached: boolean;
  depthLimitReached: boolean;
  directoryEntryLimitReached: boolean;
  timeLimitReached: boolean;
  cancelled: boolean;
}

function shouldStop(budget: SearchBudget): boolean {
  if (budget.signal?.aborted) {
    budget.cancelled = true;
    return true;
  }
  if (performance.now() <= budget.deadline) return false;
  budget.timeLimitReached = true;
  return true;
}

async function readDirectoryBounded(directory: string, budget: SearchBudget): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const handle = await fs.opendir(directory);
  for await (const entry of handle) {
    if (shouldStop(budget)) break;
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      budget.directoryEntryLimitReached = true;
      break;
    }
    entries.push(entry);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectFiles(directory: string, budget: SearchBudget, depth: number): Promise<void> {
  if (shouldStop(budget)) return;
  if (budget.directoriesVisited >= MAX_DIRECTORIES_TO_SCAN) {
    budget.directoryLimitReached = true;
    return;
  }
  budget.directoriesVisited += 1;

  const entries = await readDirectoryBounded(directory, budget);
  for (const entry of entries) {
    if (shouldStop(budget)) return;
    if (entry.isSymbolicLink() || shouldSkipWorkspaceEntry(entry.name)) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth >= MAX_SEARCH_DEPTH) {
        budget.depthLimitReached = true;
        continue;
      }
      if (budget.files.length >= MAX_FILES_TO_SCAN) {
        budget.fileLimitReached = true;
        continue;
      }
      await collectFiles(fullPath, budget, depth + 1);
    } else if (entry.isFile()) {
      if (budget.files.length >= MAX_FILES_TO_SCAN) {
        budget.fileLimitReached = true;
        continue;
      }
      budget.files.push(fullPath);
    }
  }
}

function containsBinaryMarker(content: Buffer): boolean {
  return content.includes(0);
}

function isSourcePath(relativePath: string): boolean {
  return relativePath === "src" || relativePath.startsWith("src/");
}

export const searchText: AgentTool<SearchTextInput> = {
  name: "search_text",
  description: "在工作区目录中按字面文本搜索，返回路径、行号和有限上下文。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要查找的非空字面文本。" },
      path: { type: "string", description: "工作区内的相对目录，默认根目录。" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  validate,
  async execute(input, context): Promise<string> {
    const policy = new WorkspacePolicy(context.workspaceRoot);
    const requestedPath = input.path ?? (context.requireSourceEvidence ? "src" : ".");
    const scope = await policy.resolveReadPath(requestedPath);
    if (context.requireSourceEvidence && !isSourcePath(scope.relativePath)) {
      throw new WorkspaceAccessError("源码证据模式只允许在 src 目录内搜索。");
    }
    const scopeStat = await fs.stat(scope.absolutePath);
    if (!scopeStat.isDirectory()) {
      throw new WorkspaceAccessError(`search_text 只能搜索目录：${scope.relativePath}`);
    }

    const budget: SearchBudget = {
      files: [],
      deadline: performance.now() + MAX_SEARCH_MS,
      signal: context.signal,
      directoriesVisited: 0,
      fileLimitReached: false,
      directoryLimitReached: false,
      depthLimitReached: false,
      directoryEntryLimitReached: false,
      timeLimitReached: false,
      cancelled: false,
    };
    await collectFiles(scope.absolutePath, budget, 0);
    if (budget.cancelled) {
      throw new ToolExecutionError("文本搜索已取消。", { action: "search_text", cancelled: true });
    }
    const files = budget.files;
    const workspaceRoot = await fs.realpath(context.workspaceRoot);
    const matches: string[] = [];
    let scannedFileCount = 0;
    let skippedFileCount = 0;
    let invalidUtf8FileCount = 0;

    for (const filePath of files) {
      if (shouldStop(budget)) break;
      const collectedRelativePath = path.relative(workspaceRoot, filePath);
      const safeFile = await policy.resolveReadPath(collectedRelativePath);
      if (context.requireSourceEvidence && !isSourcePath(safeFile.relativePath)) {
        throw new WorkspaceAccessError("源码证据模式下，待搜索文件解析后越出了 src 目录。");
      }
      const stat = await fs.stat(safeFile.absolutePath);
      if (stat.size > MAX_FILE_BYTES) {
        skippedFileCount += 1;
        continue;
      }

      if (!stat.isFile()) {
        skippedFileCount += 1;
        continue;
      }
      const content = await fs.readFile(safeFile.absolutePath);
      if (containsBinaryMarker(content)) {
        skippedFileCount += 1;
        continue;
      }

      const displayPath = safeFile.relativePath;
      let decoded: string;
      try {
        decoded = decodeUtf8Strict(content);
      } catch (error) {
        if (!(error instanceof InvalidUtf8Error)) throw error;
        skippedFileCount += 1;
        invalidUtf8FileCount += 1;
        continue;
      }
      scannedFileCount += 1;
      const lines = decoded.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(input.query)) {
          continue;
        }
        const excerpt = lines[index].trim().slice(0, MAX_LINE_CHARS);
        matches.push(`${displayPath}:${index + 1}: ${excerpt}`);
        if (matches.length > MAX_MATCHES) {
          break;
        }
      }
      if (matches.length > MAX_MATCHES) {
        break;
      }
    }
    if (budget.cancelled) {
      throw new ToolExecutionError("文本搜索已取消。", { action: "search_text", cancelled: true });
    }
    const visibleMatches = matches.slice(0, MAX_MATCHES);

    return [
      `查询：${JSON.stringify(input.query)}`,
      `范围：${scope.relativePath}`,
      `已扫描文件：${scannedFileCount}，跳过文件：${skippedFileCount}，已访问目录：${budget.directoriesVisited}`,
      ...(invalidUtf8FileCount > 0 ? [`非 UTF-8 文本：${invalidUtf8FileCount} 个（已拒绝搜索其内容）`] : []),
      matches.length === 0 ? "未找到匹配。" : "匹配结果：",
      ...visibleMatches,
      ...(matches.length > MAX_MATCHES ? [`[已截断：最多返回 ${MAX_MATCHES} 条匹配]`] : []),
      ...(budget.fileLimitReached ? [`[扫描范围已截断：最多收集 ${MAX_FILES_TO_SCAN} 个文件]`] : []),
      ...(budget.directoryLimitReached
        ? [`[扫描范围已截断：最多访问 ${MAX_DIRECTORIES_TO_SCAN} 个目录]`]
        : []),
      ...(budget.depthLimitReached ? [`[扫描范围已截断：最大目录深度 ${MAX_SEARCH_DEPTH}]`] : []),
      ...(budget.directoryEntryLimitReached
        ? [`[扫描范围已截断：单个目录最多检查 ${MAX_DIRECTORY_ENTRIES} 个条目]`]
        : []),
      ...(budget.timeLimitReached ? [`[扫描范围已截断：搜索超过 ${MAX_SEARCH_MS}ms 时间预算]`] : []),
    ].join("\n");
  },
};
