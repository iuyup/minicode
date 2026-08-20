import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";

import type { AgentTool, JsonValue, ToolExecutionOutput, ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy } from "../workspace/workspace-policy.ts";
import { validateLineNumber, validateObjectWithKeys } from "./input-validation.ts";
import { decodeUtf8Strict, InvalidUtf8Error } from "./text-decoding.ts";

interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_LINES = 80;
const MAX_LINE_CHARS = 240;

const PATH_CHANGED_MESSAGE = "目标文件在读取期间发生变化，已拒绝返回内容，请重新读取。";

function readOnlyOpenFlags(): number {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  return fsConstants.O_RDONLY | noFollow;
}

function isSameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

async function statPathIdentity(absolutePath: string): Promise<BigIntStats> {
  try {
    return await fs.stat(absolutePath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      throw new WorkspaceAccessError(PATH_CHANGED_MESSAGE);
    }
    throw error;
  }
}

/**
 * Best-effort TOCTOU protection for a single read. Pure Node does not expose a
 * portable openat2-style API, so a hostile parent directory can still race by
 * changing away and back between checks. No content is returned until the
 * opened handle and the re-resolved path have matching bigint identity and
 * content-related stat values.
 */
async function readVerifiedFile(
  policy: WorkspacePolicy,
  inputPath: string,
  initialAbsolutePath: string,
  initialRelativePath: string,
): Promise<Buffer> {
  const initialIdentity = await statPathIdentity(initialAbsolutePath);

  let handle;
  try {
    handle = await fs.open(initialAbsolutePath, readOnlyOpenFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      throw new WorkspaceAccessError(PATH_CHANGED_MESSAGE);
    }
    throw error;
  }

  try {
    const openedIdentity = await handle.stat({ bigint: true });
    if (!openedIdentity.isFile()) {
      throw new WorkspaceAccessError(`read_file 只能读取普通文件：${initialRelativePath}`);
    }
    if (openedIdentity.size > BigInt(MAX_FILE_BYTES)) {
      throw new WorkspaceAccessError(`文件超过 ${MAX_FILE_BYTES} 字节限制，请先使用 search_text。`);
    }
    if (!isSameSnapshot(initialIdentity, openedIdentity)) {
      throw new WorkspaceAccessError(PATH_CHANGED_MESSAGE);
    }

    const content = await handle.readFile();
    if (content.byteLength > MAX_FILE_BYTES) {
      throw new WorkspaceAccessError(`文件超过 ${MAX_FILE_BYTES} 字节限制，请先使用 search_text。`);
    }
    const afterReadIdentity = await handle.stat({ bigint: true });
    if (
      !isSameSnapshot(openedIdentity, afterReadIdentity)
      || BigInt(content.byteLength) !== afterReadIdentity.size
    ) {
      throw new WorkspaceAccessError(PATH_CHANGED_MESSAGE);
    }

    const current = await policy.resolveReadPath(inputPath);
    const currentIdentity = await statPathIdentity(current.absolutePath);
    if (
      current.absolutePath !== initialAbsolutePath ||
      current.relativePath !== initialRelativePath ||
      !isSameSnapshot(afterReadIdentity, currentIdentity)
    ) {
      throw new WorkspaceAccessError(PATH_CHANGED_MESSAGE);
    }

    return content;
  } finally {
    await handle.close();
  }
}

function isSourcePath(relativePath: string): boolean {
  return relativePath === "src" || relativePath.startsWith("src/");
}

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

export const readFile: AgentTool<ReadFileInput, ToolExecutionOutput> = {
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
  async execute(input, context): Promise<ToolExecutionOutput> {
    const policy = new WorkspacePolicy(context.workspaceRoot);
    const file = await policy.resolveReadPath(input.path);
    if (context.requireSourceEvidence && !isSourcePath(file.relativePath)) {
      throw new WorkspaceAccessError("源码证据模式只允许读取 src 目录内的文件。");
    }
    const content = await readVerifiedFile(
      policy,
      input.path,
      file.absolutePath,
      file.relativePath,
    );
    if (content.includes(0)) {
      throw new WorkspaceAccessError("拒绝读取可能是二进制的文件。");
    }

    let decoded: string;
    try {
      decoded = decodeUtf8Strict(content);
    } catch (error) {
      if (error instanceof InvalidUtf8Error) {
        throw new WorkspaceAccessError("拒绝读取不是有效 UTF-8 文本的文件。");
      }
      throw error;
    }
    const lines = decoded.split(/\r?\n/);
    const startLine = input.startLine ?? 1;
    if (startLine > lines.length) {
      throw new WorkspaceAccessError(`startLine 超出文件范围：文件共 ${lines.length} 行。`);
    }

    const requestedEndLine = Math.min(input.endLine ?? startLine + MAX_READ_LINES - 1, lines.length);
    const actualEndLine = Math.min(requestedEndLine, startLine + MAX_READ_LINES - 1);
    const truncatedLines: number[] = [];
    const renderedLines = lines.slice(startLine - 1, actualEndLine).map((line, index) => {
      const number = startLine + index;
      const truncated = line.length > MAX_LINE_CHARS;
      if (truncated) truncatedLines.push(number);
      return `${file.relativePath}:${number} | ${line.slice(0, MAX_LINE_CHARS)}${truncated ? " [行内容已截断]" : ""}`;
    });

    return {
      content: [
        `文件：${file.relativePath}`,
        `读取范围：${startLine}-${actualEndLine} / 共 ${lines.length} 行`,
        ...renderedLines,
        ...(actualEndLine < requestedEndLine
          ? [`[已截断：单次最多读取 ${MAX_READ_LINES} 行，请从第 ${actualEndLine + 1} 行继续读取]`]
          : []),
      ].join("\n"),
      sourceEvidence: [{
        path: file.relativePath,
        startLine,
        endLine: actualEndLine,
        ...(truncatedLines.length > 0 ? { truncatedLines } : {}),
      }],
    };
  },
};
