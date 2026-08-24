import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareEvaluationFixture } from "../src/evals/eval-fixture.ts";
import { evaluationTasks } from "../src/evals/task-definitions.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function requiredValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 需要一个值。`);
  return value;
}

function parseArguments(args) {
  if (args.length === 1 && args[0] === "--list") return { list: true };
  let taskId;
  let mode = "default";
  let requestedOutput;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--task") {
      taskId = requiredValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--output" || argument === "--reset-output") {
      if (requestedOutput) throw new Error("--output 与 --reset-output 只能使用一次。");
      requestedOutput = requiredValue(args, index, argument);
      mode = argument === "--output" ? "output" : "reset-output";
      index += 1;
      continue;
    }
    throw new Error(`未知参数：${argument}。`);
  }
  if (!taskId) throw new Error("需要 --task <task-id>；使用 --list 查看任务。");
  return { list: false, taskId, mode, requestedOutput };
}

const request = parseArguments(process.argv.slice(2));
if (request.list) {
  for (const task of evaluationTasks) {
    console.log(`${task.id}\t${task.category}\t${task.flow}\t${task.title}`);
  }
  process.exitCode = 0;
} else {
  const defaultRunRoot = path.join(projectRoot, "playground", "evals", request.taskId);
  const runRoot = request.requestedOutput ? path.resolve(request.requestedOutput) : defaultRunRoot;
  let resetExisting = request.mode === "reset-output";
  if (request.mode === "default") {
    try {
      await fs.lstat(runRoot);
      resetExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const fixture = await prepareEvaluationFixture({
    taskId: request.taskId,
    runRoot,
    resetExisting,
  });
  console.log(`已准备评测任务：${fixture.task.id}（${fixture.task.category}/${fixture.task.flow}）`);
  console.log(`Agent 工作区：${fixture.workspaceRoot}`);
  console.log(`fixture SHA-256：${fixture.marker.fixtureSha256}`);
  console.log(`初始 test 退出码：${fixture.task.expectedInitialTestExitCode}`);
  console.log("任务提示：");
  console.log(fixture.task.prompt);
  console.log("隐藏验收位于 Agent 工作区之外；不要把运行目录整体交给 Agent。");
}
