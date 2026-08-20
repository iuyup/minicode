import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { ToolExecutionError, type AgentTool, type JsonValue, type ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy } from "../workspace/workspace-policy.ts";
import { validateObjectWithKeys } from "./input-validation.ts";
import { decodeUtf8Strict, InvalidUtf8Error } from "./text-decoding.ts";

interface ApplyPatchInput {
  path: string;
  oldText: string;
  newText: string;
}

interface RenderedBlock {
  complete: boolean;
  lines: string[];
}

interface RenderedPreview {
  complete: boolean;
  text: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
}

interface TargetSnapshot {
  bytes: Buffer;
  identity: FileIdentity;
}

interface PreparedPatchTarget {
  absolutePath: string;
  relativePath: string;
  file: TargetSnapshot;
  parent: FileIdentity;
}

const MAX_CHANGE_CHARS = 8_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_LINE_CHARS = 200;
const CHANGED_DURING_APPROVAL_MESSAGE = "文件或父目录在确认期间发生变化，已取消写入以避免覆盖其他对象。";

function validateText(value: JsonValue | undefined, key: string, allowEmpty: boolean): ValidationResult<string> {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return { ok: false, error: `${key} 必须是${allowEmpty ? "字符串" : "非空字符串"}。` };
  }
  if (value.length > MAX_CHANGE_CHARS) {
    return { ok: false, error: `${key} 超过 ${MAX_CHANGE_CHARS} 字符限制。` };
  }
  return { ok: true, value };
}

function validate(input: JsonValue): ValidationResult<ApplyPatchInput> {
  const object = validateObjectWithKeys(input, ["path", "oldText", "newText"]);
  if (!object.ok) {
    return object;
  }

  const path = validateText(object.value.path, "path", false);
  const oldText = validateText(object.value.oldText, "oldText", false);
  const newText = validateText(object.value.newText, "newText", true);
  if (!path.ok) {
    return path;
  }
  if (!oldText.ok) {
    return oldText;
  }
  if (!newText.ok) {
    return newText;
  }
  return { ok: true, value: { path: path.value, oldText: oldText.value, newText: newText.value } };
}

function countOccurrences(content: string, target: string): number {
  let count = 0;
  let start = 0;
  while (start <= content.length - target.length) {
    const index = content.indexOf(target, start);
    if (index === -1) {
      return count;
    }
    count += 1;
    if (count > 1) {
      return count;
    }
    start = index + 1;
  }
  return count;
}

function renderBlock(prefix: string, content: string): RenderedBlock {
  const allLines = content.split(/\r\n|\r|\n/);
  const rendered: string[] = [];
  let complete = allLines.length <= MAX_PREVIEW_LINES;

  for (const line of allLines.slice(0, MAX_PREVIEW_LINES)) {
    if (line.length > MAX_PREVIEW_LINE_CHARS) {
      complete = false;
      rendered.push(`${prefix}${line.slice(0, MAX_PREVIEW_LINE_CHARS)}[预览已截断]`);
    } else {
      rendered.push(`${prefix}${line}`);
    }
  }
  if (allLines.length > MAX_PREVIEW_LINES) {
    rendered.push(`${prefix}[预览已截断]`);
  }
  return { complete, lines: rendered };
}

function renderPreview(relativePath: string, oldText: string, newText: string): RenderedPreview {
  const oldBlock = renderBlock("-", oldText);
  const newBlock = renderBlock("+", newText);
  return {
    complete: oldBlock.complete && newBlock.complete,
    text: [
      `--- ${relativePath}`,
      `+++ ${relativePath}`,
      "@@ 精确文本替换 @@",
      ...oldBlock.lines,
      ...newBlock.lines,
    ].join("\n"),
  };
}

function identityFrom(stats: { dev: bigint; ino: bigint; mode: bigint; size: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size };
}

function sameIdentity(left: FileIdentity, right: FileIdentity, compareSize = true): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && (!compareSize || left.size === right.size)
  );
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function changedDuringApproval(): WorkspaceAccessError {
  return new WorkspaceAccessError(CHANGED_DURING_APPROVAL_MESSAGE);
}

async function readTargetSnapshot(targetPath: string, relativePath: string): Promise<TargetSnapshot> {
  const initialPathStats = await fs.lstat(targetPath, { bigint: true });
  if (!initialPathStats.isFile() || initialPathStats.isSymbolicLink()) {
    throw new WorkspaceAccessError(`apply_patch 只能修改普通文件：${relativePath}`);
  }
  const initialRealPath = await fs.realpath(targetPath);
  if (!samePath(initialRealPath, targetPath)) {
    throw new WorkspaceAccessError(`无法安全确认补丁目标的真实路径：${relativePath}`);
  }

  const openFlags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const targetFile = await fs.open(targetPath, openFlags);
  let beforeRead: BigIntStats;
  let afterRead: BigIntStats;
  let bytes: Buffer;
  try {
    beforeRead = await targetFile.stat({ bigint: true });
    if (!beforeRead.isFile()) {
      throw new WorkspaceAccessError(`apply_patch 只能修改普通文件：${relativePath}`);
    }
    if (beforeRead.size > BigInt(MAX_FILE_BYTES)) {
      throw new WorkspaceAccessError(`文件超过 ${MAX_FILE_BYTES} 字节限制，拒绝修改。`);
    }
    bytes = await targetFile.readFile();
    afterRead = await targetFile.stat({ bigint: true });
  } finally {
    await targetFile.close();
  }

  const finalPathStats = await fs.lstat(targetPath, { bigint: true });
  const finalRealPath = await fs.realpath(targetPath);
  const beforeIdentity = identityFrom(beforeRead);
  const afterIdentity = identityFrom(afterRead);
  const finalPathIdentity = identityFrom(finalPathStats);
  if (
    !finalPathStats.isFile()
    || finalPathStats.isSymbolicLink()
    || !samePath(finalRealPath, targetPath)
    || !sameIdentity(beforeIdentity, afterIdentity)
    || !sameIdentity(afterIdentity, finalPathIdentity)
    || BigInt(bytes.length) !== afterIdentity.size
  ) {
    throw new WorkspaceAccessError("文件在安全读取期间发生变化，未继续处理补丁。");
  }

  return { bytes, identity: afterIdentity };
}

async function readParentIdentity(targetPath: string): Promise<FileIdentity> {
  const parentPath = path.dirname(targetPath);
  const initialStats = await fs.lstat(parentPath, { bigint: true });
  if (!initialStats.isDirectory() || initialStats.isSymbolicLink()) {
    throw new WorkspaceAccessError("补丁目标的父目录不是可安全写入的普通目录。");
  }
  const realParentPath = await fs.realpath(parentPath);
  const finalStats = await fs.stat(parentPath, { bigint: true });
  if (
    !samePath(realParentPath, parentPath)
    || !finalStats.isDirectory()
    || !sameIdentity(identityFrom(initialStats), identityFrom(finalStats))
  ) {
    throw new WorkspaceAccessError("无法安全确认补丁目标的父目录身份。");
  }
  return identityFrom(finalStats);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ToolExecutionError("补丁写入已取消。", { action: "apply_patch", cancelled: true });
  }
}

async function assertPreparedTargetUnchanged(
  policy: WorkspacePolicy,
  inputPath: string,
  prepared: PreparedPatchTarget,
  expectedParent: FileIdentity,
  compareParentSize: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  try {
    const resolved = await policy.resolveWritePath(inputPath);
    if (
      !samePath(resolved.absolutePath, prepared.absolutePath)
      || resolved.relativePath !== prepared.relativePath
    ) {
      throw changedDuringApproval();
    }
    const parentIdentity = await readParentIdentity(resolved.absolutePath);
    if (!sameIdentity(parentIdentity, expectedParent, compareParentSize)) {
      throw changedDuringApproval();
    }
    const currentFile = await readTargetSnapshot(resolved.absolutePath, resolved.relativePath);
    if (
      !sameIdentity(currentFile.identity, prepared.file.identity)
      || !currentFile.bytes.equals(prepared.file.bytes)
    ) {
      throw changedDuringApproval();
    }
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throwIfCancelled(signal);
    throw changedDuringApproval();
  }
  throwIfCancelled(signal);
}

async function writeAtomically(
  targetPath: string,
  content: string,
  mode: bigint,
  expectedParent: FileIdentity,
  verifyBeforeRename: (parentWithTemporaryFile: FileIdentity) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const permissionBits = Number(mode & 0o7777n);
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.minicode-${randomUUID()}.tmp`,
  );
  let temporaryFileExists = false;
  try {
    const temporaryFile = await fs.open(temporaryPath, "wx", permissionBits);
    temporaryFileExists = true;
    try {
      await temporaryFile.writeFile(content, "utf8");
      await temporaryFile.sync();
      await temporaryFile.chmod(permissionBits);
    } finally {
      await temporaryFile.close();
    }

    const parentWithTemporaryFile = await readParentIdentity(targetPath);
    if (!sameIdentity(parentWithTemporaryFile, expectedParent, false)) {
      throw changedDuringApproval();
    }
    throwIfCancelled(signal);
    await verifyBeforeRename(parentWithTemporaryFile);
    throwIfCancelled(signal);

    // Best effort：Node 没有跨平台 dirfd/renameat；最后一次身份检查与 rename 之间仍有极小父目录竞态窗口。
    await fs.rename(temporaryPath, targetPath);
    temporaryFileExists = false;
  } finally {
    if (temporaryFileExists) {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}

export const applyPatch: AgentTool<ApplyPatchInput> = {
  name: "apply_patch",
  description: "精确文本替换工具。准备好 path、oldText 和 newText 后必须直接调用；终端会展示预览、等待用户精确输入 APPLY，并在获批后写入。不要在普通回答中请求 APPLY 或用 Markdown 补丁替代工具调用。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "工作区内的相对文件路径。" },
      oldText: { type: "string", description: "目标文件中唯一出现的原文本。" },
      newText: { type: "string", description: "替换后的文本，可为空。" },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  validate,
  async execute(input, context): Promise<string> {
    const policy = new WorkspacePolicy(context.workspaceRoot);
    let target;
    try {
      target = await policy.resolveWritePath(input.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      context.recordPolicyDecision?.({ decision: "blocked", path: input.path, reason });
      throw error;
    }

    context.recordPolicyDecision?.({
      decision: "allowed",
      path: target.relativePath,
      reason: "目标位于工作区内，且不属于受保护路径。",
    });

    throwIfCancelled(context.signal);
    const initialParent = await readParentIdentity(target.absolutePath);
    const initialFile = await readTargetSnapshot(target.absolutePath, target.relativePath);
    const stableParent = await readParentIdentity(target.absolutePath);
    if (!sameIdentity(initialParent, stableParent)) {
      throw new WorkspaceAccessError("补丁目标的父目录在准备期间发生变化，未继续处理补丁。");
    }
    const prepared: PreparedPatchTarget = {
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      file: initialFile,
      parent: stableParent,
    };
    await assertPreparedTargetUnchanged(
      new WorkspacePolicy(context.workspaceRoot),
      input.path,
      prepared,
      prepared.parent,
      true,
      context.signal,
    );

    const sourceBytes = prepared.file.bytes;
    if (sourceBytes.includes(0)) {
      throw new WorkspaceAccessError("拒绝修改可能是二进制的文件。");
    }

    let source: string;
    try {
      source = decodeUtf8Strict(sourceBytes);
    } catch (error) {
      if (error instanceof InvalidUtf8Error) {
        throw new WorkspaceAccessError("拒绝修改不是有效 UTF-8 文本的文件。");
      }
      throw error;
    }
    const occurrences = countOccurrences(source, input.oldText);
    if (occurrences === 0) {
      throw new WorkspaceAccessError("oldText 未在目标文件中找到，未修改文件。");
    }
    if (occurrences > 1) {
      throw new WorkspaceAccessError("oldText 在目标文件中出现多次，无法安全确定替换位置。");
    }

    const updated = source.replace(input.oldText, input.newText);
    const preview = renderPreview(target.relativePath, input.oldText, input.newText);
    if ((context.executionMode ?? "propose") === "propose") {
      return ["补丁预览，未写入文件。", preview.text].join("\n");
    }

    if (!preview.complete) {
      throw new WorkspaceAccessError(
        `补丁预览超过 ${MAX_PREVIEW_LINES} 行或包含超过 ${MAX_PREVIEW_LINE_CHARS} 字符的行，`
        + "无法无损展示并确认；请将修改拆成更小的补丁。",
      );
    }

    if (!context.requestEditApproval) {
      throw new WorkspaceAccessError("当前为 apply 模式，但没有可用的人工确认回调，未修改文件。");
    }
    const approved = await context.requestEditApproval(
      { path: target.relativePath, preview: preview.text },
      context.signal,
    );
    if (!approved) {
      throw new WorkspaceAccessError("用户未确认补丁，未修改文件。");
    }
    throwIfCancelled(context.signal);

    await assertPreparedTargetUnchanged(
      policy,
      input.path,
      prepared,
      prepared.parent,
      true,
      context.signal,
    );
    await writeAtomically(
      prepared.absolutePath,
      updated,
      prepared.file.identity.mode,
      prepared.parent,
      async (parentWithTemporaryFile) => assertPreparedTargetUnchanged(
        new WorkspacePolicy(context.workspaceRoot),
        input.path,
        prepared,
        parentWithTemporaryFile,
        true,
        context.signal,
      ),
      context.signal,
    );
    return ["补丁已应用。", preview.text].join("\n");
  },
};
