import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";

type EmptyInput = Record<string, never>;

function validateEmptyObject(input: JsonValue): ValidationResult<EmptyInput> {
  const isEmptyObject =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0;

  return isEmptyObject
    ? { ok: true, value: {} }
    : { ok: false, error: "get_project_overview accepts an empty object only." };
}

export const getProjectOverview: AgentTool<EmptyInput> = {
  name: "get_project_overview",
  description: "返回当前离线演示已确认的能力边界。",
  validate: validateEmptyObject,
  async execute(_input, context): Promise<string> {
    return [
      `收到的任务：${context.task}`,
      "当前实现包含 Agent Loop、工具契约、FakeModel、任务级账本、生命周期事件、只读工作区工具、CLI 演示和测试。",
      "它仍未接入真实模型、文件修改、补丁应用、命令执行或持久化审计。",
    ].join(" ");
  },
};
