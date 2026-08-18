import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { ToolExecutionError } from "../agent/contracts.ts";

export interface BoundedProcessResult {
  exitCode: number | null;
  durationMs: number;
  output: string;
  outputLength: number;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled?: boolean;
}

export interface BoundedProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  action: string;
  startFailureLabel: string;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

const FORCE_SETTLEMENT_MS = 5_000;
const POSIX_FORCE_KILL_MS = 1_000;
type CapturedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function requestProcessTreeTermination(child: CapturedChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    const taskkillPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => child.kill());
    const killerTimeout = setTimeout(() => {
      killer.kill();
      child.kill();
    }, POSIX_FORCE_KILL_MS);
    killerTimeout.unref();
    killer.once("close", (exitCode) => {
      clearTimeout(killerTimeout);
      if (exitCode !== 0) child.kill();
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceKill = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, POSIX_FORCE_KILL_MS);
  forceKill.unref();
}

/**
 * 启动一个不经过 Shell 的有界进程，并在超时时尽力终止整棵进程树。
 * 进程树清理仍依赖宿主操作系统，不构成隔离或绝对终止保证。
 */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const startedAt = Date.now();
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: null,
      durationMs: 0,
      output: "",
      outputLength: 0,
      outputTruncated: false,
      timedOut: false,
      cancelled: true,
    });
  }
  let child: CapturedChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new ToolExecutionError(`无法启动${options.startFailureLabel}。`, { action: options.action });
  }

  let output = "";
  let outputLength = 0;
  let outputTruncated = false;
  let timedOut = false;
  let cancelled = false;
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let decodersFlushed = false;
  const appendOutput = (decoded: string): void => {
    const text = sanitizeProcessOutput(decoded);
    outputLength += text.length;
    const remaining = Math.max(0, options.maxOutputChars - output.length);
    if (remaining > 0) output += text.slice(0, remaining);
    if (text.length > remaining) outputTruncated = true;
  };
  const flushDecoders = (): void => {
    if (decodersFlushed) return;
    decodersFlushed = true;
    appendOutput(stdoutDecoder.end());
    appendOutput(stderrDecoder.end());
  };
  child.stdout.on("data", (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)));
  child.stderr.on("data", (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)));

  return new Promise<BoundedProcessResult>((resolve, reject) => {
    let settled = false;
    let terminationRequested = false;
    let forceSettlement: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      flushDecoders();
      settled = true;
      resolve({
        exitCode,
        durationMs: Date.now() - startedAt,
        output,
        outputLength,
        outputTruncated,
        timedOut,
        cancelled,
      });
    };
    const requestTermination = (reason: "timeout" | "cancelled"): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      requestProcessTreeTermination(child);
      forceSettlement = setTimeout(() => {
        if (settled) return;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        clearTimers();
        finish(null);
      }, FORCE_SETTLEMENT_MS);
    };
    const timeout = setTimeout(() => requestTermination("timeout"), options.timeoutMs);
    const abortListener = (): void => requestTermination("cancelled");
    options.signal?.addEventListener("abort", abortListener, { once: true });
    // 补上“启动前检查”和“监听器注册”之间的取消竞态。
    if (options.signal?.aborted) abortListener();

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (forceSettlement) clearTimeout(forceSettlement);
      options.signal?.removeEventListener("abort", abortListener);
    };
    child.once("error", (error) => {
      if (settled) return;
      if (terminationRequested) {
        clearTimers();
        finish(null);
        return;
      }
      clearTimers();
      flushDecoders();
      settled = true;
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      reject(new ToolExecutionError(`无法启动${options.startFailureLabel}（${code}）。`, {
        action: options.action,
        durationMs: Date.now() - startedAt,
      }));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      clearTimers();
      finish(exitCode);
    });
  });
}

const SAFE_ENVIRONMENT_NAMES = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

/**
 * 子进程只继承运行 Node/npm 所需的基础系统变量。
 * 这是凭据减暴露措施，不是进程或网络沙箱。
 */
export function createSanitizedChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalizedName = name.toUpperCase();
    if (SAFE_ENVIRONMENT_NAMES.has(normalizedName) || normalizedName.startsWith("LC_")) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

/** 移除会改写终端的控制字符；保留普通换行与制表符。 */
export function sanitizeProcessOutput(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/gu, "");
}

export async function resolveNpmCli(): Promise<string> {
  const nodeDirectory = path.dirname(await fs.realpath(process.execPath));
  const candidates = [
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.platform === "win32" ? [] : ["/usr/share/nodejs/npm/bin/npm-cli.js"]),
  ];

  for (const candidate of candidates) {
    try {
      const realCandidate = await fs.realpath(candidate);
      if (path.basename(realCandidate).toLowerCase() !== "npm-cli.js") continue;
      const binDirectory = path.dirname(realCandidate);
      const npmDirectory = path.dirname(binDirectory);
      if (path.basename(binDirectory).toLowerCase() !== "bin") continue;
      if (path.basename(npmDirectory).toLowerCase() !== "npm") continue;
      const packageJson = JSON.parse(await fs.readFile(path.join(npmDirectory, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name !== "npm") continue;
      await fs.access(realCandidate);
      return realCandidate;
    } catch {
      // 尝试下一个由本地 Node/npm 安装提供的位置。
    }
  }
  throw new ToolExecutionError("未找到 npm CLI，命令未执行。");
}
