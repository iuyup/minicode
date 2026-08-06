import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentTool, JsonObject, JsonValue, ValidationResult } from "../agent/contracts.ts";
import { WorkspaceAccessError, WorkspacePolicy } from "../workspace/workspace-policy.ts";
import { validateObjectWithKeys } from "./input-validation.ts";

interface ApplyPatchInput {
  path: string;
  oldText: string;
  newText: string;
}

const MAX_CHANGE_CHARS = 8_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PREVIEW_LINES = 40;
const MAX_PREVIEW_LINE_CHARS = 200;

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
    start = index + target.length;
  }
  return count;
}

function renderBlock(prefix: string, content: string): string[] {
  const lines = content.split(/\r?\n/).slice(0, MAX_PREVIEW_LINES);
  const rendered = lines.map((line) => `${prefix}${line.slice(0, MAX_PREVIEW_LINE_CHARS)}`);
  if (content.split(/\r?\n/).length > MAX_PREVIEW_LINES) {
    rendered.push(`${prefix}[预览已截断]`);
  }
  return rendered;
}

function renderPreview(relativePath: string, oldText: string, newText: string): string {
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    "@@ 精确文本替换 @@",
    ...renderBlock("-", oldText),
    ...renderBlock("+", newText),
  ].join("\n");
}

async function writeAtomically(targetPath: string, content: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.minicode-${randomUUID()}.tmp`,
  );
  let temporaryFileExists = false;
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    temporaryFileExists = true;
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
  description: "按精确旧文本替换为新文本；默认只生成预览，写入前必须经过人工确认。",
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

    const stat = await fs.stat(target.absolutePath);
    if (!stat.isFile()) {
      throw new WorkspaceAccessError(`apply_patch 只能修改普通文件：${target.relativePath}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new WorkspaceAccessError(`文件超过 ${MAX_FILE_BYTES} 字节限制，拒绝修改。`);
    }

    const sourceBytes = await fs.readFile(target.absolutePath);
    if (sourceBytes.includes(0)) {
      throw new WorkspaceAccessError("拒绝修改可能是二进制的文件。");
    }

    const source = sourceBytes.toString("utf8");
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
      return ["补丁预览，未写入文件。", preview].join("\n");
    }

    if (!context.requestEditApproval) {
      throw new WorkspaceAccessError("当前为 apply 模式，但没有可用的人工确认回调，未修改文件。");
    }
    const approved = await context.requestEditApproval({ path: target.relativePath, preview });
    if (!approved) {
      throw new WorkspaceAccessError("用户未确认补丁，未修改文件。");
    }

    const latestBytes = await fs.readFile(target.absolutePath);
    if (!latestBytes.equals(sourceBytes)) {
      throw new WorkspaceAccessError("文件在确认期间发生变化，已取消写入以避免覆盖他人修改。");
    }

    await writeAtomically(target.absolutePath, updated);
    return ["补丁已应用。", preview].join("\n");
  },
};
