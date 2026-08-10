import type { ChatModel, ModelRequest, ModelResponse, ToolResultMessage } from "../agent/contracts.ts";

function findUnknownToolLocation(searchContent: string): { path: string; startLine: number; endLine: number } {
  const match = searchContent.match(/^(src\/agent\/agent-loop\.ts):(\d+):.*未知工具/m);
  if (!match) {
    return { path: "src/agent/agent-loop.ts", startLine: 1, endLine: 40 };
  }
  const lineNumber = Number(match[2]);
  return {
    path: match[1],
    startLine: Math.max(1, lineNumber - 3),
    endLine: lineNumber + 3,
  };
}

/**
 * 确定性的 LLM 替身：先搜索，再读取真实源文件，最后基于 ToolResultMessage 回答。
 */
export class FakeModel implements ChatModel {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const task = request.messages.find((message) => message.role === "user")?.content ?? "";
    const requestedCheck = /(?:运行|执行).*(?:测试|test)|npm\s+test/i.test(task)
      ? "test"
      : /(?:运行|执行).*(?:类型检查|检查|check)|npm\s+run\s+check/i.test(task)
        ? "check"
        : undefined;
    const projectCheckResult = request.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "tool" && message.name === "run_project_check",
    );

    if (requestedCheck) {
      if (!projectCheckResult) {
        return {
          kind: "tool_calls",
          content: "任务要求固定项目验证，我会调用受限验证工具。",
          toolCalls: [{ id: "call-project-check-1", name: "run_project_check", input: { action: requestedCheck } }],
        };
      }
      return {
        kind: "final",
        content: [
          "受限项目验证闭环已完成。",
          `验证动作：${requestedCheck}`,
          `工具终态：${projectCheckResult.status}`,
          `工具证据：${projectCheckResult.content
            .split("\n")
            .filter((line) => line.trim() !== "")
            .slice(0, 8)
            .join(" | ")}`,
          "模型只选择固定动作，不传入命令字符串、参数或工作目录。",
        ].join("\n"),
      };
    }

    const searchResult = request.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "tool" && message.name === "search_text",
    );
    const fileResult = request.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "tool" && message.name === "read_file",
    );

    if (!searchResult) {
      return {
        kind: "tool_calls",
        content: "我需要先在真实工作区中定位未知工具的处理逻辑。",
        toolCalls: [{ id: "call-search-1", name: "search_text", input: { query: "未知工具", path: "src" } }],
      };
    }

    if (!fileResult) {
      const location = findUnknownToolLocation(searchResult.content);
      return {
        kind: "tool_calls",
        content: "搜索结果给出了候选位置，我需要读取对应源码确认细节。",
        toolCalls: [
          {
            id: "call-read-1",
            name: "read_file",
            input: location,
          },
        ],
      };
    }

    const evidence =
      fileResult.content.split("\n").find((line) => line.includes("未知工具")) ??
      fileResult.content.split("\n").at(-1) ??
      "未找到可展示的源码行。";
    return {
      kind: "final",
      content: [
        "只读代码侦察闭环已完成。",
        `代码证据：${evidence}`,
        `搜索工具已确认候选位置：${searchResult.content.split("\n").find((line) => line.includes("agent-loop.ts")) ?? "未显示候选位置。"}`,
        "模型是在 search_text 和 read_file 的结果写回消息历史后，才给出该结论。",
      ].join("\n"),
    };
  }
}
