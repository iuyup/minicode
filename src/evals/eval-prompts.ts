import {
  DEEPSEEK_EDIT_SYSTEM_PROMPT,
  DEEPSEEK_EDIT_TOOL_PROTOCOL,
  GUIDED_PLAN_PROMPT,
} from "../runtime.ts";
import type { EvaluationArm } from "./eval-config.ts";

export const BASELINE_THREE_TOOL_SYSTEM_PROMPT = [
  "你是一个最小 Coding Agent，只能使用 read_file、apply_patch 和 run_project_check。",
  "先读取任务明确指出的目标文件，再提出一次最小精确补丁；不要编造读取、写入或测试结果。",
  "补丁成功后使用 run_project_check test 验证；测试失败时可根据结果继续，但不得宣称失败的任务已经完成。",
  "每轮只请求一个工具，证据足够后直接简要说明实际修改与验证状态。",
].join(" ");

export const MINICODE_EDIT_SYSTEM_PROMPT = `${DEEPSEEK_EDIT_SYSTEM_PROMPT} ${DEEPSEEK_EDIT_TOOL_PROTOCOL}`;

export interface EvaluationPromptSet {
  readonly system: string;
  readonly planning: string | null;
}

export const EVALUATION_PROMPTS: Readonly<Record<EvaluationArm, EvaluationPromptSet>> = Object.freeze({
  "baseline-3tool": Object.freeze({
    system: BASELINE_THREE_TOOL_SYSTEM_PROMPT,
    planning: null,
  }),
  "minicode-3tool": Object.freeze({
    system: BASELINE_THREE_TOOL_SYSTEM_PROMPT,
    planning: GUIDED_PLAN_PROMPT,
  }),
  "minicode-product": Object.freeze({
    system: MINICODE_EDIT_SYSTEM_PROMPT,
    planning: GUIDED_PLAN_PROMPT,
  }),
});
