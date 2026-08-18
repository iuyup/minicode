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
  parameters: { type: "object", properties: {}, additionalProperties: false },
  validate: validateEmptyObject,
  async execute(_input, context): Promise<string> {
    return [
      `收到的任务：${context.task}`,
      "当前实现包含 Agent Loop、工具契约、任务级账本、生命周期事件、只读工作区与 Git 状态/diff 工具、受控补丁、受限项目验证、CLI 演示和测试。",
      "默认使用离线 FakeModel；只有明确选择 DeepSeek 模型并配置环境变量后才会发起网络请求。",
    ].join(" ");
  },
};
