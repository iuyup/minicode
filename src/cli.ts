import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { AgentLoop } from "./agent/agent-loop.ts";
import type { EditApprovalRequest, ToolExecutionMode } from "./agent/contracts.ts";
import { JsonlAuditLog } from "./agent/events.ts";
import { ToolRegistry } from "./agent/tool-registry.ts";
import { FakeModel } from "./models/fake-model.ts";
import { applyPatch } from "./tools/apply-patch.ts";
import { getProjectOverview } from "./tools/get-project-overview.ts";
import { listFiles } from "./tools/list-files.ts";
import { readFile } from "./tools/read-file.ts";
import { runProjectCheck } from "./tools/run-project-check.ts";
import { searchText } from "./tools/search-text.ts";

interface CliArguments {
  task: string;
  workspaceRoot: string;
  executionMode: ToolExecutionMode;
  auditPath: string;
}

function parseArguments(args: string[]): CliArguments {
  let workspaceRoot = process.cwd();
  let executionMode: ToolExecutionMode = "propose";
  let auditPath = path.resolve("reports/tool-audit.jsonl");
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workspace") {
      const requestedWorkspace = args[index + 1];
      if (!requestedWorkspace) {
        throw new Error("--workspace 后必须提供一个目录路径。");
      }
      workspaceRoot = requestedWorkspace;
      index += 1;
      continue;
    }
    if (argument === "--apply") {
      executionMode = "apply";
      continue;
    }
    if (argument === "--audit") {
      const requestedAuditPath = args[index + 1];
      if (!requestedAuditPath) {
        throw new Error("--audit 后必须提供一个文件路径。");
      }
      auditPath = path.resolve(requestedAuditPath);
      index += 1;
      continue;
    }
    taskParts.push(argument);
  }

  return {
    task: taskParts.join(" ") || "说明未知工具为何仍有完整的终态事件。",
    workspaceRoot,
    executionMode,
    auditPath,
  };
}

async function requestTerminalApproval(request: EditApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("--apply 只能在交互式终端中使用，以便人工确认补丁。");
  }

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\n待写入文件：${request.path}\n${request.preview}\n`);
    const answer = await terminal.question("输入 APPLY 确认写入，输入其他内容取消：");
    return answer.trim() === "APPLY";
  } finally {
    terminal.close();
  }
}

const { task, workspaceRoot, executionMode, auditPath } = parseArguments(process.argv.slice(2));
const registry = new ToolRegistry([getProjectOverview, listFiles, searchText, readFile, applyPatch, runProjectCheck]);
const agent = new AgentLoop(new FakeModel(), registry, {
  workspaceRoot,
  executionMode,
  requestEditApproval: executionMode === "apply" ? requestTerminalApproval : undefined,
  auditLog: new JsonlAuditLog(auditPath),
});
const result = await agent.run(task);

console.log("=== 生命周期事件 ===");
for (const event of result.events) {
  if (event.type === "tool_finalized") {
    console.log(`${event.type} (${event.status}) -> ${event.toolName}`);
  } else if ("toolName" in event) {
    console.log(`${event.type} -> ${event.toolName}`);
  } else {
    console.log(event.type);
  }
}

console.log("\n=== 最终回答 ===");
console.log(result.answer);
console.log("\n=== 任务账本 ===");
console.log(result.workingState);
console.log(`\n审计文件：${auditPath}`);
