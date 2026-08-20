import type { CommandRiskLevel } from "../agent/contracts.ts";

export type ControlledProgram = "node" | "npm";

export interface AllowedCommandPolicy {
  allowed: true;
  program: ControlledProgram;
  riskLevel: CommandRiskLevel;
  risk: string;
  auditReason: string;
  nodeEntryPath?: string;
}

export interface BlockedCommandPolicy {
  allowed: false;
  message: string;
  auditReason: string;
}

export type CommandPolicyResult = AllowedCommandPolicy | BlockedCommandPolicy;

const LOW_RISK = "该命令不会经过 Shell，但仍会启动本地进程并可能访问网络。这是可信工作区中的逐次确认，不是操作系统沙箱。";
const MEDIUM_RISK = "该命令可能执行工作区中的 Node/npm 项目代码，代码仍可修改文件、访问网络或启动子进程。这是逐次确认，不是操作系统沙箱。";
const HIGH_RISK = "该依赖操作可能修改 package.json、锁文件和 node_modules，访问网络并执行安装脚本。只在信任工作区时确认；这不是操作系统沙箱。";

const NPM_LOW_RISK_ACTIONS = new Set([
  "--version",
  "-v",
  "help",
  "list",
  "ls",
  "outdated",
  "explain",
  "why",
  "view",
  "info",
  "search",
]);
const NPM_SCRIPT_ACTIONS = new Set([
  "test",
  "t",
  "run",
  "run-script",
  "start",
  "stop",
  "restart",
]);
const NPM_DEPENDENCY_ACTIONS = new Set([
  "install",
  "i",
  "ci",
  "update",
  "up",
  "uninstall",
  "remove",
  "rm",
  "prune",
  "dedupe",
]);

function block(message: string, auditReason: string): BlockedCommandPolicy {
  return { allowed: false, message, auditReason };
}

function normalizeProgram(program: string): ControlledProgram | undefined {
  switch (program.toLowerCase()) {
    case "node":
    case "node.exe":
      return "node";
    case "npm":
    case "npm.cmd":
      return "npm";
    default:
      return undefined;
  }
}

function isNodeInlineCodeArgument(argument: string): boolean {
  return argument === "-e"
    || argument === "-p"
    || argument === "--eval"
    || argument === "--print"
    || argument.startsWith("--eval=")
    || argument.startsWith("--print=")
    || /^-[ep].+/u.test(argument);
}

function isNpmLocationOverride(argument: string): boolean {
  return /^-g(?:=|$)/u.test(argument)
    || /^-w/u.test(argument)
    || /^--global(?:=|$)/u.test(argument)
    || /^--workspace(?:=|$)/u.test(argument)
    || /^--workspaces(?:=|$)/u.test(argument)
    || argument === "--prefix"
    || argument.startsWith("--prefix=")
    || argument === "--location"
    || argument.startsWith("--location=")
    || argument === "--userconfig"
    || argument.startsWith("--userconfig=")
    || argument === "--globalconfig"
    || argument.startsWith("--globalconfig=");
}

export function evaluateCommandPolicy(programInput: string, args: readonly string[]): CommandPolicyResult {
  const program = normalizeProgram(programInput);
  if (!program) {
    return block(
      "程序不在第一版允许列表中；目前只支持 node 与 npm。",
      "程序不在受控允许列表中。",
    );
  }

  if (program === "node") {
    // Node 在入口脚本之后不再解析运行时参数；-e/--print 等值此时只是脚本自己的参数。
    if (args[0] !== undefined && isNodeInlineCodeArgument(args[0])) {
      return block(
        "不允许使用 Node 的 eval/print 内联代码参数；请运行工作区中的可审查脚本。",
        "Node 内联代码参数已被策略阻断。",
      );
    }
    if (args.length === 1 && ["--version", "-v", "--help", "-h"].includes(args[0])) {
      return {
        allowed: true,
        program,
        riskLevel: "low",
        risk: LOW_RISK,
        auditReason: "允许低风险 Node 查询动作。",
      };
    }
    const entryPath = args[0];
    if (!entryPath || entryPath.startsWith("-")) {
      return block(
        "Node 只允许版本/帮助查询，或以工作区相对脚本作为第一个参数；预加载、调试和其他运行时选项暂不支持。",
        "Node 入口不符合工作区脚本策略。",
      );
    }
    return {
      allowed: true,
      program,
      riskLevel: "medium",
      risk: MEDIUM_RISK,
      auditReason: "允许中风险 Node 工作区进程。",
      nodeEntryPath: entryPath,
    };
  }

  // `--` 后的内容会原样传给 npm script，不应再按 npm 自身的目录覆盖参数处理。
  const passthroughIndex = args.indexOf("--");
  const npmArguments = passthroughIndex === -1 ? args : args.slice(0, passthroughIndex);
  if (npmArguments.some(isNpmLocationOverride)) {
    return block(
      "不允许 npm 全局操作、配置文件覆盖或工作目录覆盖。",
      "npm 工作区边界覆盖参数已被策略阻断。",
    );
  }

  const action = args[0]?.toLowerCase();
  if (!action) {
    return block("npm 必须提供明确且受支持的动作。", "缺少明确的 npm 动作。");
  }
  if (NPM_LOW_RISK_ACTIONS.has(action)) {
    return {
      allowed: true,
      program,
      riskLevel: "low",
      risk: LOW_RISK,
      auditReason: "允许低风险 npm 查询动作。",
    };
  }
  if (NPM_SCRIPT_ACTIONS.has(action)) {
    return {
      allowed: true,
      program,
      riskLevel: "medium",
      risk: MEDIUM_RISK,
      auditReason: "允许中风险 npm 工作区脚本动作。",
    };
  }
  if (NPM_DEPENDENCY_ACTIONS.has(action)) {
    return {
      allowed: true,
      program,
      riskLevel: "high",
      risk: HIGH_RISK,
      auditReason: "允许高风险 npm 依赖动作。",
    };
  }
  return block(
    "该 npm 动作不在第一版允许列表中；发布、版本、账号、配置、动态执行与未知动作均被拒绝。",
    "npm 动作不在受控允许列表中。",
  );
}
