import fs from "node:fs/promises";
import path from "node:path";

import { EVALUATION_ARMS } from "../src/evals/eval-config.ts";
import {
  createEvaluationSuitePlan,
  runEvaluationSuite,
} from "../src/evals/eval-suite-runner.ts";

function usage() {
  return [
    "MiniCode real-model evaluation",
    "",
    "Plan only (does not read an API key or send network requests):",
    "  npm run eval:plan -- --profile deepseek [--task id] [--arm name]",
    "",
    "Execute (costs API usage):",
    "  npm run eval:run -- --profile deepseek --task id --arm minicode-product \\",
    "    --output playground/eval-runs/<run-id> --confirm-real-model <plan-sha256>",
    "",
    "Options:",
    "  --plan                    print the frozen matrix only",
    "  --profile <id>            deepseek or openai-compatible (default: deepseek)",
    "  --task <id[,id...]>       repeatable; default: all 15 tasks",
    `  --arm <name[,name...]>    repeatable; values: ${EVALUATION_ARMS.join(", ")}`,
    "  --pricing <json>          explicit price snapshot; otherwise cost is N/A",
    "  --output <new-directory>  required for execution; never overwritten",
    "  --confirm-real-model <sha> execute only the exact reviewed plan SHA-256",
    "  --help",
  ].join("\n");
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值。`);
  return value;
}

function commaValues(value) {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("列表选项不能为空。");
  return values;
}

function parseArguments(argv) {
  const options = {
    plan: false,
    help: false,
    confirmRealModel: undefined,
    profileId: "deepseek",
    taskIds: [],
    arms: [],
    outputRoot: undefined,
    pricingPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--plan": options.plan = true; break;
      case "--help": options.help = true; break;
      case "--confirm-real-model":
        options.confirmRealModel = requiredValue(argv, index, argument).toLowerCase();
        index += 1;
        break;
      case "--profile":
        options.profileId = requiredValue(argv, index, argument);
        index += 1;
        break;
      case "--task":
        options.taskIds.push(...commaValues(requiredValue(argv, index, argument)));
        index += 1;
        break;
      case "--arm":
        options.arms.push(...commaValues(requiredValue(argv, index, argument)));
        index += 1;
        break;
      case "--output":
        options.outputRoot = requiredValue(argv, index, argument);
        index += 1;
        break;
      case "--pricing":
        options.pricingPath = requiredValue(argv, index, argument);
        index += 1;
        break;
      default:
        throw new Error(`未知选项：${argument}。`);
    }
  }
  if (options.profileId !== "deepseek" && options.profileId !== "openai-compatible") {
    throw new Error("--profile 只允许 deepseek 或 openai-compatible。");
  }
  if (options.confirmRealModel !== undefined && !/^[a-f0-9]{64}$/u.test(options.confirmRealModel)) {
    throw new Error("--confirm-real-model 必须是计划输出中的 64 位 SHA-256。");
  }
  return options;
}

function samePath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function readPricing(filePath) {
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  const stats = await fs.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error("价格快照必须是小于 64 KiB 的普通 JSON 文件。");
  }
  if (!samePath(await fs.realpath(resolved), resolved)) {
    throw new Error("价格快照不能经过符号链接或 junction。");
  }
  return JSON.parse(await fs.readFile(resolved, "utf8"));
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const pricing = await readPricing(parsed.pricingPath);
  const selection = {
    profileId: parsed.profileId,
    ...(parsed.taskIds.length > 0 ? { taskIds: parsed.taskIds } : {}),
    ...(parsed.arms.length > 0 ? { arms: parsed.arms } : {}),
    ...(pricing ? { pricing } : {}),
  };
  if (parsed.plan) {
    if (parsed.confirmRealModel) throw new Error("--plan 与 --confirm-real-model 不能同时使用。");
    const { plan, configuration } = await createEvaluationSuitePlan(selection);
    process.stdout.write(`${JSON.stringify({
      ...plan,
      model: configuration.publicConfig.model,
      cost: configuration.publicConfig.cost,
    }, null, 2)}\n`);
    return;
  }
  if (!parsed.confirmRealModel) {
    throw new Error("未执行：请先用 --plan 检查矩阵；真实运行还必须提供 --confirm-real-model <plan-sha256>。");
  }
  if (!parsed.outputRoot) throw new Error("真实运行必须提供新的 --output 目录。");
  const outputRoot = path.resolve(parsed.outputRoot);
  const outputParent = path.dirname(outputRoot);
  await fs.mkdir(outputParent, { recursive: true });
  if (!samePath(await fs.realpath(outputParent), outputParent)) {
    throw new Error("--output 父目录经过符号链接或 junction，拒绝运行。");
  }
  const run = await runEvaluationSuite({
    ...selection,
    outputRoot,
    confirmRealModel: parsed.confirmRealModel,
    onTrialCompleted(result, completed, total) {
      process.stdout.write(
        `[${completed}/${total}] ${result.taskId} ${result.arm} trial-${result.trial}: ${result.status}` +
        `${result.failureCode ? ` (${result.failureCode})` : ""}\n`,
      );
    },
  });
  process.stdout.write(
    `完成：${run.report.totals.passed}/${run.report.totals.total}；报告 ${path.join(outputRoot, "EVAL_REPORT.md")}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`评测未完成：${message}\n`);
  process.exitCode = 1;
});
