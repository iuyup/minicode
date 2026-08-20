import fs from "node:fs/promises";

import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy } from "../workspace/workspace-policy.ts";
import { validateObjectWithKeys, validateOptionalPath } from "./input-validation.ts";

interface ListFilesInput {
  path?: string;
}

const MAX_ENTRIES = 80;

function childRelativePath(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function validate(input: JsonValue): ValidationResult<ListFilesInput> {
  const object = validateObjectWithKeys(input, ["path"]);
  if (!object.ok) {
    return object;
  }
  const path = validateOptionalPath(object.value);
  return path.ok ? { ok: true, value: { ...(path.value ? { path: path.value } : {}) } } : path;
}

export const listFiles: AgentTool<ListFilesInput> = {
  name: "list_files",
  description: "列出工作区中指定目录的一层内容；不显示受保护目录或符号链接。",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "工作区内的相对目录，默认根目录。" } },
    additionalProperties: false,
  },
  validate,
  async execute(input, context): Promise<string> {
    const policy = new WorkspacePolicy(context.workspaceRoot);
    const directory = await policy.resolveReadPath(input.path ?? ".");
    const stat = await fs.stat(directory.absolutePath);
    if (!stat.isDirectory()) {
      throw new WorkspaceAccessError(`list_files 只能读取目录：${directory.relativePath}`);
    }

    const entries = await fs.readdir(directory.absolutePath, { withFileTypes: true });
    const visibleEntries = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = childRelativePath(directory.relativePath, entry.name);
      if (await policy.shouldSkipPath(relativePath)) continue;
      visibleEntries.push(entry);
    }
    visibleEntries.sort((left, right) => left.name.localeCompare(right.name));
    const visible = visibleEntries
      .slice(0, MAX_ENTRIES)
      .map((entry) => `${entry.isDirectory() ? "目录" : "文件"} ${entry.name}`);
    const truncated = visibleEntries.length > MAX_ENTRIES;
    const renderedEntries = visible.length === 0 ? ["（没有可见条目）"] : visible;

    return [
      `目录：${directory.relativePath}`,
      ...renderedEntries,
      ...(truncated ? [`[已截断：最多显示 ${MAX_ENTRIES} 个条目]`] : []),
    ].join("\n");
  },
};
