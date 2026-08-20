import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { AgentLoop, type AgentRunResult } from "./agent/agent-loop.ts";
import type {
  ChatModel,
  CommandApprovalRequest,
  EditApprovalRequest,
  PlanApprovalRequest,
  RepairApprovalRequest,
  ToolExecutionMode,
} from "./agent/contracts.ts";
import { JsonlAuditLog, type AgentEvent } from "./agent/events.ts";
import { escapeMultilineTerminalText, escapeTerminalText } from "./terminal-safety.ts";
import { ToolRegistry } from "./agent/tool-registry.ts";
import { FakeModel } from "./models/fake-model.ts";
import {
  getModelProfile,
  getModelProfiles,
  getModelProfileReadiness,
  parseModelProfileId,
  resolveOpenAiCompatibleProfile,
  type ModelProfile,
  type ModelProfileId,
} from "./models/model-profiles.ts";
import { OpenAiCompatibleModel } from "./models/openai-compatible-model.ts";
import { applyPatch } from "./tools/apply-patch.ts";
import { getProjectOverview } from "./tools/get-project-overview.ts";
import { inspectGit } from "./tools/inspect-git.ts";
import { listFiles } from "./tools/list-files.ts";
import { readFile } from "./tools/read-file.ts";
import { runCommand } from "./tools/run-command.ts";
import { runProjectCheck } from "./tools/run-project-check.ts";
import { searchText } from "./tools/search-text.ts";

export interface CliArguments {
  task: string;
  workspaceRoot: string;
  executionMode: ToolExecutionMode;
  agentMode: "read" | "edit";
  auditPath: string;
  modelProfile: ModelProfileId;
  deepseekModel: string;
  requireSourceEvidence: boolean;
  guided: boolean;
}

export interface CreateAgentOptions {
  model?: ChatModel;
  onEvent?: (event: AgentEvent) => void;
  requestEditApproval?: (request: EditApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestPlanApproval?: (request: PlanApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestRepairApproval?: (request: RepairApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  requestCommandApproval?: (request: CommandApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
}

const readOnlyTools = [getProjectOverview, listFiles, searchText, readFile, inspectGit] as const;
const sourceEvidenceTools = [searchText, readFile] as const;
const editTools = [...readOnlyTools, applyPatch, runProjectCheck, runCommand] as const;

const DEEPSEEK_SYSTEM_PROMPT = [
  "你是一个受限的只读 Coding Agent，只能使用已提供的只读工具进行代码侦察。",
  "只在需要事实证据时调用工具，并优先以最少的工具调用完成任务。",
  "遵守当前提供的工具集和单轮调用额度；不要重复列出、搜索或读取已确认的路径。",
  "一旦工具结果已足以支撑结论，下一轮必须直接给出最终回答，不得继续探索。",
  "工具结果是唯一证据；不得编造工具结果或声称执行了未提供的能力。",
].join(" ");

const DEEPSEEK_EDIT_SYSTEM_PROMPT = [
  "你是一个受控的 Coding Agent，可以使用当前注册的只读、补丁、固定验证、结构化 Node/npm 和固定 Git 只读工具完成小范围代码任务。",
  "先定位并用 read_file 成功读取目标文件，再提出最小的 apply_patch；运行时会拒绝未读取目标的补丁。",
  "补丁会在终端界面展示给用户；只有用户输入精确的 APPLY 才会写入。用户拒绝后，不得重复尝试同一补丁，应说明原因并给出后续建议。",
  "补丁成功后，只在能验证本次修改时运行命令；优先调用更窄的 run_project_check test/check，固定验证无法覆盖时才调用 run_command。",
  "run_command 必须把程序、参数数组和工作区相对目录分开提供；第一版只支持 node/npm，不接受直接 Shell、管道、重定向、Git、提权、后台任务或环境变量注入。npm/工作区脚本自身仍可能启动 Shell 或子进程。",
  "Git 只能通过 inspect_git 的 status、diff、staged_diff 固定动作读取；不得要求暂存、提交、切换分支、重置或推送。完成修改和验证后，在工具预算允许时读取 Git 状态与相关差异，并明确提交仍由用户手动完成。",
  "终端会完整展示命令、工作目录和风险等级；只有用户精确输入 RUN 才会执行。RUN 是本地确认词，不能作为用户消息处理或要求模型等待。",
  "在 guided 编辑模式中，固定验证真实失败后会进入一次无工具修复方向阶段；只给出失败判断、拟修改文件和复验动作，等待本地 CONTINUE 确认后再继续。一次修复复验仍失败时必须停止修复并总结未完成状态。",
  "每轮只请求一个工具。工具结果是唯一事实依据；证据足够后直接给出简明的修改与验证结论。",
].join(" ");

const DEEPSEEK_EDIT_TOOL_PROTOCOL = [
  "对于需要修改文件的任务，read_file 成功后必须直接调用 apply_patch；不要在普通回答中展示补丁、请求用户回复 APPLY，或声称会再次提交补丁。",
  "APPLY 是终端本地确认步骤，不能由模型等待、解释或处理。调用 apply_patch 后终端会展示预览并暂停；收到工具结果后，才能继续说明结果。",
  "若尚不能安全形成 path、oldText 和 newText，应调用只读工具补充信息；不能用自然语言补丁代替 apply_patch 工具调用。",
].join(" ");

const GUIDED_PLAN_PROMPT = [
  "当前处于用户确认的计划阶段，尚未开放任何工具。",
  "请只用简短 Markdown 给出：目标理解、最多三步执行计划、每一步是否可能修改文件或运行命令。",
  "不要调用工具，不要声称已经读取文件、修改文件或运行命令；等待用户确认后才会进入执行阶段。",
].join(" ");

const DEEPSEEK_SOURCE_EVIDENCE_PROMPT = [
  "当前是源码取证模式，只提供 search_text 和 read_file 两个工具，每轮最多请求一个工具。",
  "解释实现机制前，最多使用两次 search_text 在 src 中定位候选代码，随后必须用 read_file 读取命中源码。",
  "首次成功读取后，可额外进行一次定向 search_text 以定位事件处理代码，并再用一次 read_file 读取；读取两段源码后运行时会关闭工具并要求直接给出最终回答。",
  "最终回答只能使用本轮成功读取过的源码作为实现证据，并至少包含一条 `path:line` 或 `path:startLine-endLine` 格式引用。",
  "README、agent.md、目录列表和搜索结果不能替代实现源码；不要引用未读取的文件或行号。",
  "若收到源码证据修复反馈，下一轮只能给出最终回答，不得请求工具。",
].join(" ");

export function defaultAuditPath(): string {
  const userAuditRoot = process.platform === "win32" && process.env.LOCALAPPDATA?.trim()
    ? path.join(process.env.LOCALAPPDATA, "MiniCode", "audit")
    : path.join(os.homedir(), ".minicode", "audit");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(userAuditRoot, `session-${stamp}-${randomUUID()}.jsonl`);
}

function requiredOptionValue(args: readonly string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} 后必须提供一个值。`);
  }
  return value;
}

export function parseArguments(args: string[]): CliArguments {
  let workspaceRoot = process.cwd();
  let executionMode: ToolExecutionMode = "propose";
  let agentMode: CliArguments["agentMode"] = "read";
  let auditPath = defaultAuditPath();
  let modelProfile: ModelProfileId = "fake";
  const deepseekProfile = getModelProfile("deepseek");
  let deepseekModel = deepseekProfile.kind === "openai-compatible" ? deepseekProfile.model : "";
  let requireSourceEvidence = false;
  let guided = false;
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      taskParts.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--workspace") {
      const requestedWorkspace = requiredOptionValue(args, index, "--workspace");
      workspaceRoot = requestedWorkspace;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      executionMode = "apply";
      agentMode = "edit";
      continue;
    }
    if (argument === "--mode") {
      const requestedMode = requiredOptionValue(args, index, "--mode");
      if (requestedMode !== "read" && requestedMode !== "edit") {
        throw new Error("--mode 只能是 read 或 edit。");
      }
      agentMode = requestedMode;
      if (requestedMode === "edit") executionMode = "apply";
      index += 1;
      continue;
    }
    if (argument === "--audit") {
      const requestedAuditPath = requiredOptionValue(args, index, "--audit");
      auditPath = path.resolve(requestedAuditPath);
      index += 1;
      continue;
    }
    if (argument === "--model") {
      const requestedProvider = requiredOptionValue(args, index, "--model");
      if (requestedProvider !== "fake" && requestedProvider !== "deepseek") {
        throw new Error("--model 只能是 fake 或 deepseek。");
      }
      modelProfile = requestedProvider;
      index += 1;
      continue;
    }
    if (argument === "--profile") {
      const requestedProfile = requiredOptionValue(args, index, "--profile");
      const parsedProfile = parseModelProfileId(requestedProfile);
      if (!parsedProfile) {
        throw new Error("--profile 只支持 fake、deepseek 或 openai-compatible。");
      }
      modelProfile = parsedProfile;
      index += 1;
      continue;
    }
    if (argument === "--deepseek-model") {
      const requestedModel = requiredOptionValue(args, index, "--deepseek-model");
      deepseekModel = requestedModel;
      index += 1;
      continue;
    }
    if (argument === "--require-source-evidence") {
      requireSourceEvidence = true;
      continue;
    }
    if (argument === "--guided") {
      guided = true;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`未知选项：${argument}。若任务文本需要以 -- 开头，请先使用独立的 --。`);
    }
    taskParts.push(argument);
  }

  if (requireSourceEvidence && agentMode === "edit") {
    throw new Error("--require-source-evidence 仅用于只读取证，不能与 --mode edit 同时使用。");
  }
  if (guided && requireSourceEvidence) {
    throw new Error("--guided 不能与 --require-source-evidence 同时使用；取证模式有专用的受控状态机。");
  }

  return {
    task: taskParts.join(" ") || "说明未知工具为何仍有完整的终态事件。",
    workspaceRoot,
    executionMode,
    agentMode,
    auditPath,
    modelProfile,
    deepseekModel,
    requireSourceEvidence,
    guided,
  };
}

function currentModelProfile(argumentsValue: CliArguments): ModelProfile {
  const profile = getModelProfile(argumentsValue.modelProfile);
  return profile.id === "deepseek"
    ? { ...profile, model: argumentsValue.deepseekModel }
    : profile;
}

function usesRemoteModel(argumentsValue: CliArguments): boolean {
  return argumentsValue.modelProfile !== "fake";
}

function createModel(argumentsValue: CliArguments): ChatModel {
  if (!usesRemoteModel(argumentsValue)) return new FakeModel();
  const { profile, apiKey, allowInsecureHttp } = resolveOpenAiCompatibleProfile(argumentsValue.modelProfile);
  const activeProfile = currentModelProfile(argumentsValue);
  if (activeProfile.kind === "fake") return new FakeModel();
  return new OpenAiCompatibleModel({
    apiKey,
    baseUrl: profile.baseUrl,
    model: activeProfile.model,
    providerName: profile.label,
    apiKeyEnvironmentVariable: profile.apiKeyEnvironmentVariable,
    disableThinking: profile.disableThinking,
    allowInsecureHttp,
  });
}

export function listModelProfiles(): readonly ModelProfile[] {
  return getModelProfiles();
}

/**
 * 仅校验配置并更新内存中的会话选项。不会发送网络请求，也不会持久化 API Key。
 */
export function selectModelProfile(argumentsValue: CliArguments, requestedProfile: string): ModelProfile {
  const profileId = parseModelProfileId(requestedProfile);
  if (!profileId) {
    throw new Error("可选 Profile：fake、deepseek、openai-compatible。");
  }
  if (profileId !== "fake") resolveOpenAiCompatibleProfile(profileId);
  argumentsValue.modelProfile = profileId;
  return currentModelProfile(argumentsValue);
}

export function modelProfileReadiness(profile: ModelProfile): string {
  const readiness = getModelProfileReadiness(profile);
  return readiness.ready ? "就绪" : readiness.reason ?? "未就绪";
}

async function requestTerminalApproval(request: EditApprovalRequest, signal?: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--apply 只能在交互式终端中使用，以便人工确认补丁。");
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      `\n待写入文件：${escapeTerminalText(request.path)}\n${escapeMultilineTerminalText(request.preview)}\n`,
    );
    const answer = await terminal.question("输入 APPLY 确认写入，输入其他内容取消：", { signal });
    return answer.trim() === "APPLY";
  } finally {
    terminal.close();
  }
}

async function requestTerminalPlanApproval(request: PlanApprovalRequest, signal?: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--guided 只能在交互式终端中使用，以便人工确认计划。");
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n待确认计划：\n${escapeMultilineTerminalText(request.plan)}\n`);
    const answer = await terminal.question("输入 CONTINUE 开始执行，输入 CANCEL 取消：", { signal });
    return answer.trim() === "CONTINUE";
  } finally {
    terminal.close();
  }
}

async function requestTerminalRepairApproval(request: RepairApprovalRequest, signal?: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("失败修复只能在交互式终端中使用，以便人工确认修复方向。");
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      `\n待确认修复方向（失败动作：${escapeTerminalText(request.failedAction)}，尝试 ${request.attempt}/${request.maximumAttempts}）：\n${escapeMultilineTerminalText(request.direction)}\n`,
    );
    const answer = await terminal.question("输入 CONTINUE 允许一次修复，输入 CANCEL 停止：", { signal });
    return answer.trim() === "CONTINUE";
  } finally {
    terminal.close();
  }
}

async function requestTerminalCommandApproval(request: CommandApprovalRequest, signal?: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("本地命令只能在交互式终端中使用，以便人工确认。");
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const title = request.kind === "verification" ? "待确认验证" : "待确认命令";
    const commandLabel = request.kind === "verification" ? "固定命令" : "命令";
    process.stdout.write(
      `\n${title}：${escapeTerminalText(request.action)}\n${commandLabel}：${escapeTerminalText(request.command)}\n工作目录：${escapeTerminalText(request.workingDirectory)}\n风险等级：${request.riskLevel}\n风险：${escapeTerminalText(request.risk)}\n`,
    );
    const answer = await terminal.question("输入 RUN 确认执行，输入 CANCEL 取消：", { signal });
    return answer.trim() === "RUN";
  } finally {
    terminal.close();
  }
}

export function createAgent(argumentsValue: CliArguments, options: CreateAgentOptions = {}): AgentLoop {
  const registry = new ToolRegistry(
    argumentsValue.requireSourceEvidence
      ? sourceEvidenceTools
      : usesRemoteModel(argumentsValue)
        ? argumentsValue.agentMode === "edit"
          ? editTools
          : readOnlyTools
        : argumentsValue.agentMode === "edit"
          ? editTools
          : [...readOnlyTools, applyPatch, runProjectCheck],
  );
  return new AgentLoop(options.model ?? createModel(argumentsValue), registry, {
    workspaceRoot: argumentsValue.workspaceRoot,
    maxSteps: argumentsValue.agentMode === "edit" ? 7 : undefined,
    executionMode: argumentsValue.executionMode,
    requireSourceEvidence: argumentsValue.requireSourceEvidence,
    requirePlanApproval: argumentsValue.guided,
    planningPrompt: argumentsValue.guided ? GUIDED_PLAN_PROMPT : undefined,
    enableFailureRepair: argumentsValue.guided && argumentsValue.agentMode === "edit",
    requireReadBeforeEdit: usesRemoteModel(argumentsValue) && argumentsValue.agentMode === "edit",
    ...(usesRemoteModel(argumentsValue)
      ? {
          systemPrompt: [
            argumentsValue.requireSourceEvidence
              ? `${DEEPSEEK_SYSTEM_PROMPT} ${DEEPSEEK_SOURCE_EVIDENCE_PROMPT}`
              : argumentsValue.agentMode === "edit"
                ? `${DEEPSEEK_EDIT_SYSTEM_PROMPT} ${DEEPSEEK_EDIT_TOOL_PROTOCOL}`
                : DEEPSEEK_SYSTEM_PROMPT,
          ].join(" "),
          maxToolCallsPerStep: argumentsValue.requireSourceEvidence || argumentsValue.agentMode === "edit" ? 1 : 2,
          maxToolCalls: 6,
          finalOnlyAfterToolBudget: argumentsValue.agentMode === "edit",
        }
      : {}),
    requestEditApproval: argumentsValue.executionMode === "apply"
      ? options.requestEditApproval ?? requestTerminalApproval
      : undefined,
    requestPlanApproval: argumentsValue.guided
      ? options.requestPlanApproval ?? requestTerminalPlanApproval
      : undefined,
    requestRepairApproval: argumentsValue.guided && argumentsValue.agentMode === "edit"
      ? options.requestRepairApproval ?? requestTerminalRepairApproval
      : undefined,
    requestCommandApproval: options.requestCommandApproval ?? requestTerminalCommandApproval,
    auditLog: new JsonlAuditLog(argumentsValue.auditPath),
    onEvent: options.onEvent,
  });
}

export function modelLabel(argumentsValue: CliArguments): string {
  const profile = currentModelProfile(argumentsValue);
  return profile.kind === "fake" ? profile.label : `${profile.label} / ${profile.model}`;
}

export function toolPermissionLabel(argumentsValue: CliArguments): string {
  return argumentsValue.requireSourceEvidence
    ? "只读源码取证"
    : argumentsValue.guided
      ? argumentsValue.agentMode === "edit"
        ? "引导式受控编辑"
        : "引导式只读"
      : argumentsValue.agentMode === "edit"
      ? "受控编辑（逐次确认）"
    : usesRemoteModel(argumentsValue)
      ? "只读侦察"
      : "离线演示（不可自主改代码）";
}

export function printRunResult(result: AgentRunResult, argumentsValue: CliArguments): void {
  console.log("=== 生命周期事件 ===");
  console.log(`模型：${escapeTerminalText(modelLabel(argumentsValue))}`);
  console.log(`工具权限：${escapeTerminalText(toolPermissionLabel(argumentsValue))}`);
  console.log(`源码证据校验：${argumentsValue.requireSourceEvidence ? "已启用" : "未启用"}`);
  for (const event of result.events) {
    if (event.type === "tool_finalized") {
      console.log(`${event.type} (${event.status}) -> ${escapeTerminalText(event.toolName)}`);
    } else if (event.type === "model_requested" && event.forcedToolName) {
      console.log(`${event.type} (强制) -> ${escapeTerminalText(event.forcedToolName)}`);
    } else if ("toolName" in event) {
      console.log(`${event.type} -> ${escapeTerminalText(event.toolName)}`);
    } else {
      console.log(event.type);
    }
  }

  console.log("\n=== 最终回答 ===");
  console.log(escapeMultilineTerminalText(result.answer));
  if (argumentsValue.requireSourceEvidence) {
    console.log("\n=== 已验证源码证据 ===");
    for (const evidence of result.sourceEvidence) {
      console.log(`${escapeTerminalText(evidence.path)}:${evidence.startLine}-${evidence.endLine}`);
    }
  }
  console.log("\n=== 任务账本 ===");
  console.log(escapeMultilineTerminalText(result.workingState));
  console.log(`\n审计文件：${escapeTerminalText(argumentsValue.auditPath)}`);
}

export async function runDemo(args: string[] = process.argv.slice(2)): Promise<void> {
  const argumentsValue = parseArguments(args);
  const result = await createAgent(argumentsValue).run(argumentsValue.task);
  printRunResult(result, argumentsValue);
}
