import type { ChatModel, ModelRequest, ModelResponse, ToolResultMessage } from "../agent/contracts.ts";

const PLAN_CONFIRMATION_PREFIX = "计划已由用户确认。现在开始执行";
const RUNTIME_USER_MESSAGE_PREFIXES = [
  PLAN_CONFIRMATION_PREFIX,
  "固定验证已真实执行并失败。",
  "修复方向已由用户确认。",
  "一次修复后的固定验证仍然失败",
  "一次修复的工具额度已用尽",
] as const;
const MAX_STATUS_SUMMARY_ITEMS = 8;
const MAX_DIFF_SUMMARY_FILES = 6;

type ToolResultWithMetadata = ToolResultMessage & {
  metadata?: {
    outputTruncated?: boolean;
  };
};

function originalUserTask(request: ModelRequest): string {
  return request.messages.findLast(
    (message) =>
      message.role === "user" &&
      !RUNTIME_USER_MESSAGE_PREFIXES.some((prefix) => message.content.startsWith(prefix)),
  )?.content ?? "";
}

function gitResultFor(
  request: ModelRequest,
  action: "status" | "diff" | "staged_diff",
): ToolResultMessage | undefined {
  return request.messages.findLast(
    (message): message is ToolResultMessage =>
      message.role === "tool" &&
      message.name === "inspect_git" &&
      (message.content.includes(`Git 只读动作：${action}`) || message.toolCallId.includes(`git-${action}`)),
  );
}

function summarizeGitResult(result: ToolResultMessage): string {
  if (result.status === "error") return `工具终态：error；${result.content}`;
  const lines = result.content.split("\n");
  const resultStart = lines.findIndex((line) => line.trim() === "结果：");
  const resultLines = lines
    .slice(resultStart >= 0 ? resultStart + 1 : 0)
    .filter((line) => line.trim() !== "" && line.trim() !== "[Git 输出已截断]");
  const outputTruncated = result.content.includes("[Git 输出已截断]") ||
    (result as ToolResultWithMetadata).metadata?.outputTruncated === true;
  const truncationNotice = outputTruncated ? "；Git 原始输出已截断，摘要不完整" : "";
  const action = result.content.match(/^Git 只读动作：(status|diff|staged_diff)$/mu)?.[1];

  if (action === "status") {
    const branch = resultLines.find((line) => line.startsWith("## "));
    const statusItems = resultLines.filter((line) => !line.startsWith("## "));
    const visibleItems = statusItems.slice(0, MAX_STATUS_SUMMARY_ITEMS);
    const omittedCount = statusItems.length - visibleItems.length;
    const summaryParts = [
      "工具终态：success",
      ...(branch ? [`分支：${branch.slice(3)}`] : []),
      visibleItems.length > 0 ? `变更项：${visibleItems.join(" | ")}` : "工作区无可见变更",
      ...(omittedCount > 0
        ? [`仅展示前 ${visibleItems.length} 项、另有 ${omittedCount} 项`]
        : []),
    ];
    return `${summaryParts.join("；")}${truncationNotice}`;
  }

  const diffFiles = resultLines
    .filter((line) => line.startsWith("diff --git "))
    .map((line) => line.match(/ b\/(.+)$/u)?.[1])
    .filter((file): file is string => Boolean(file));
  if (diffFiles.length > 0) {
    const visibleFiles = diffFiles.slice(0, MAX_DIFF_SUMMARY_FILES);
    const omittedCount = diffFiles.length - visibleFiles.length;
    const omittedNotice = omittedCount > 0
      ? `；仅展示前 ${visibleFiles.length} 个文件、另有 ${omittedCount} 个文件`
      : "";
    return `工具终态：success；涉及文件：${visibleFiles.join("、")}${omittedNotice}${truncationNotice}`;
  }
  return `工具终态：success；工具已返回差异结果，未复述补丁正文${truncationNotice}`;
}

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
    if (request.phase === "planning") {
      return {
        kind: "final",
        content: [
          "## 执行计划",
          "1. 先搜索并读取与任务相关的真实代码。",
          "2. 基于读取结果给出最小修改或验证结论。",
          "3. 若任务要求验证，调用已注册的受控验证或命令工具。",
        ].join("\n"),
      };
    }
    if (request.phase === "repair_planning") {
      return {
        kind: "final",
        content: "根据最近一次失败验证，先读取相关实现，进行一次最小修复，再运行同一验证动作复验。",
      };
    }

    const task = originalUserTask(request);
    const requestedGit = /git[\s\S]*(?:status|diff|状态|差异|变更)|(?:status|diff|状态|差异|变更)[\s\S]*git/iu.test(task);
    const requestedStagedDiff = requestedGit && /staged[_\s-]?diff|已暂存(?:差异|diff)/iu.test(task);
    const requestedDiff = requestedGit && !requestedStagedDiff && /diff|差异|变更/iu.test(task);
    const requestedStatus = requestedGit && (/status|状态|变更/iu.test(task) || !requestedDiff && !requestedStagedDiff);
    if (requestedGit) {
      if (!request.tools.some((tool) => tool.name === "inspect_git")) {
        return {
          kind: "final",
          content: "当前工具集未开放 inspect_git；源码取证模式不会读取 Git，普通 read/edit 模式才提供固定只读 Git 动作。",
        };
      }
      const statusResult = gitResultFor(request, "status");
      const diffAction = requestedStagedDiff ? "staged_diff" as const : "diff" as const;
      const diffResult = gitResultFor(request, diffAction);
      if (requestedStatus && !statusResult) {
        return {
          kind: "tool_calls",
          content: "我会先读取固定的 Git 状态；该动作不会暂存或提交。",
          toolCalls: [{ id: "call-inspect-git-status-1", name: "inspect_git", input: { action: "status" } }],
        };
      }
      if (statusResult?.status === "error") {
        return {
          kind: "final",
          content: [
            "Git 状态读取失败，未继续请求差异。",
            summarizeGitResult(statusResult),
            "本次没有执行任何 Git 写操作。",
          ].join("\n"),
        };
      }
      if ((requestedDiff || requestedStagedDiff) && !diffResult) {
        return {
          kind: "tool_calls",
          content: requestedStagedDiff ? "我会读取已暂存差异。" : "我会读取未暂存差异。",
          toolCalls: [{ id: `call-inspect-git-${diffAction}-1`, name: "inspect_git", input: { action: diffAction } }],
        };
      }
      return {
        kind: "final",
        content: [
          "Git 只读检查闭环已完成。",
          ...(statusResult ? [`状态证据：${summarizeGitResult(statusResult)}`] : []),
          ...(diffResult ? [`差异证据：${summarizeGitResult(diffResult)}`] : []),
          "本次没有执行暂存、提交、切换分支、重置或推送；请由用户检查后手动 commit。",
        ].join("\n"),
      };
    }
    const requestedNpmVersion = /(?:查看|运行|执行).*(?:npm\s*(?:--version|-v)|npm\s*版本)|npm\s*(?:--version|-v)/i.test(task);
    const commandResult = request.messages.find(
      (message): message is ToolResultMessage => message.role === "tool" && message.name === "run_command",
    );
    if (requestedNpmVersion && request.tools.some((tool) => tool.name === "run_command")) {
      if (!commandResult) {
        return {
          kind: "tool_calls",
          content: "任务要求查看 npm 版本，我会调用结构化受控命令工具。",
          toolCalls: [{
            id: "call-run-command-1",
            name: "run_command",
            input: { program: "npm", args: ["--version"], cwd: "." },
          }],
        };
      }
      return {
        kind: "final",
        content: [
          "受控命令闭环已完成。",
          `工具终态：${commandResult.status}`,
          `工具证据：${commandResult.content.split("\n").filter(Boolean).slice(0, 7).join(" | ")}`,
          "程序、参数与工作目录由工具分离处理，并经过本地 RUN 确认。",
        ].join("\n"),
      };
    }
    if (requestedNpmVersion) {
      return {
        kind: "final",
        content: "当前工具集未开放 run_command；请使用 --mode edit 启动离线命令面板演示。",
      };
    }
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
