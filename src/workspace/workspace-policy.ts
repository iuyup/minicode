import fs from "node:fs/promises";
import path from "node:path";

export interface WorkspacePath {
  absolutePath: string;
  relativePath: string;
}

const PROTECTED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

export class WorkspaceAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export function shouldSkipWorkspaceEntry(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    PROTECTED_DIRECTORY_NAMES.has(normalizedName) ||
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.")
  );
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function toDisplayPath(relativePath: string): string {
  return relativePath === "" ? "." : relativePath.split(path.sep).join("/");
}

/**
 * 这是一层 Agent 路径策略，不是操作系统沙箱。
 * 所有实际读取前都解析真实路径，以防符号链接逃逸工作区。
 */
export class WorkspacePolicy {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
  }

  async resolveReadPath(inputPath: string): Promise<WorkspacePath> {
    return this.resolveExistingPath(inputPath, "读取");
  }

  async resolveWritePath(inputPath: string): Promise<WorkspacePath> {
    return this.resolveExistingPath(inputPath, "写入");
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

    const relativePath = path.relative(realWorkspaceRoot, realCandidate);
    const segments = relativePath === "" ? [] : relativePath.split(path.sep);
    if (segments.some(shouldSkipWorkspaceEntry)) {
      throw new WorkspaceAccessError(`目标路径受保护，已拒绝${operation}。`);
    }

    return {
      absolutePath: realCandidate,
      relativePath: toDisplayPath(relativePath),
    };
  }
}
