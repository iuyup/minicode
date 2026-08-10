import fs from "node:fs/promises";

import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy } from "../workspace/workspace-policy.ts";
import { validateLineNumber, validateObjectWithKeys } from "./input-validation.ts";

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_LINES = 80;
const MAX_LINE_CHARS = 240;

function validate(input: JsonValue): ValidationResult<ReadFileInput> {
  const object = validateObjectWithKeys(input, ["path", "startLine", "endLine"]);
  if (!object.ok) {
    return object;
  }
  if (typeof object.value.path !== "string" || object.value.path.trim() === "") {
    return { ok: false, error: "path 必须是非空字符串。" };
  }

  const startLine = validateLineNumber(object.value, "startLine");
  const endLine = validateLineNumber(object.value, "endLine");
  if (!startLine.ok) {
    return startLine;
  }
  if (!endLine.ok) {
    return endLine;
  }
  if (startLine.value !== undefined && endLine.value !== undefined && endLine.value < startLine.value) {
    return { ok: false, error: "endLine 不能小于 startLine。" };
  }

  return {
    ok: true,
    value: {
      path: object.value.path,
      ...(startLine.value === undefined ? {} : { startLine: startLine.value }),
      ...(endLine.value === undefined ? {} : { endLine: endLine.value }),
    },
  };
}

export const readFile: AgentTool<ReadFileInput> = {
  name: "read_file",
  description: "读取工作区内的文本文件，可按行号范围读取；输出带行号并限制长度。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内的相对文件路径。" },
      startLine: { type: "integer", minimum: 1, description: "起始行号，默认 1。" },
      endLine: { type: "integer", minimum: 1, description: "结束行号。" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  validate,
  async execute(input, context): Promise<string> {
    const policy = new WorkspacePolicy(context.workspaceRoot);
    const file = await policy.resolveReadPath(input.path);
    const stat = await fs.stat(file.absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceAccessError(`read_file 只能读取普通文件：${file.relativePath}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new WorkspaceAccessError(`文件超过 ${MAX_FILE_BYTES} 字节限制，请先使用 search_text。`);
    }

    const content = await fs.readFile(file.absolutePath);
    if (content.includes(0)) {
      throw new WorkspaceAccessError("拒绝读取可能是二进制的文件。");
    }

    const lines = content.toString("utf8").split(/\r?\n/);
    const startLine = input.startLine ?? 1;
    if (startLine > lines.length) {
      throw new WorkspaceAccessError(`startLine 超出文件范围：文件共 ${lines.length} 行。`);
    }

    const requestedEndLine = Math.min(input.endLine ?? startLine + MAX_READ_LINES - 1, lines.length);
    const actualEndLine = Math.min(requestedEndLine, startLine + MAX_READ_LINES - 1);
    const renderedLines = lines.slice(startLine - 1, actualEndLine).map((line, index) => {
      const number = startLine + index;
      const truncated = line.length > MAX_LINE_CHARS;
      return `${file.relativePath}:${number} | ${line.slice(0, MAX_LINE_CHARS)}${truncated ? " [行内容已截断]" : ""}`;
    });

    return [
      `文件：${file.relativePath}`,
      `读取范围：${startLine}-${actualEndLine} / 共 ${lines.length} 行`,
      ...renderedLines,
      ...(actualEndLine < requestedEndLine
        ? [`[已截断：单次最多读取 ${MAX_READ_LINES} 行，请从第 ${actualEndLine + 1} 行继续读取]`]
        : []),
    ].join("\n");
  },
};
