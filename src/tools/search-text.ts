import fs from "node:fs/promises";
import path from "node:path";

import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy, shouldSkipWorkspaceEntry } from "../workspace/workspace-policy.ts";
import { validateObjectWithKeys, validateOptionalPath } from "./input-validation.ts";

interface SearchTextInput {
  query: string;
  path?: string;
}

const MAX_FILES_TO_SCAN = 200;
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

async function collectFiles(directory: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES_TO_SCAN) {
    return;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= MAX_FILES_TO_SCAN) {
      return;
    }
    if (entry.isSymbolicLink() || shouldSkipWorkspaceEntry(entry.name)) {
      continue;
    }

    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

function containsBinaryMarker(content: Buffer): boolean {
  return content.includes(0);
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
    const scope = await policy.resolveReadPath(input.path ?? ".");
    const scopeStat = await fs.stat(scope.absolutePath);
    if (!scopeStat.isDirectory()) {
      throw new WorkspaceAccessError(`search_text 只能搜索目录：${scope.relativePath}`);
    }

    const files: string[] = [];
    await collectFiles(scope.absolutePath, files);
    const workspaceRoot = await fs.realpath(context.workspaceRoot);
    const matches: string[] = [];
    let scannedFileCount = 0;
    let skippedFileCount = 0;

    for (const filePath of files) {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        skippedFileCount += 1;
        continue;
      }

      const content = await fs.readFile(filePath);
      if (containsBinaryMarker(content)) {
        skippedFileCount += 1;
        continue;
      }

      scannedFileCount += 1;
      const displayPath = path.relative(workspaceRoot, filePath).split(path.sep).join("/");
      const lines = content.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(input.query)) {
          continue;
        }
        const excerpt = lines[index].trim().slice(0, MAX_LINE_CHARS);
        matches.push(`${displayPath}:${index + 1}: ${excerpt}`);
        if (matches.length >= MAX_MATCHES) {
          break;
        }
      }
      if (matches.length >= MAX_MATCHES) {
        break;
      }
    }

    return [
      `查询：${JSON.stringify(input.query)}`,
      `范围：${scope.relativePath}`,
      `已扫描文件：${scannedFileCount}，跳过文件：${skippedFileCount}`,
      matches.length === 0 ? "未找到匹配。" : "匹配结果：",
      ...matches,
      ...(matches.length >= MAX_MATCHES ? [`[已截断：最多返回 ${MAX_MATCHES} 条匹配]`] : []),
      ...(files.length >= MAX_FILES_TO_SCAN ? [`[已截断：最多扫描 ${MAX_FILES_TO_SCAN} 个文件]`] : []),
    ].join("\n");
  },
};
