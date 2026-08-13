import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentTool, ChatModel, JsonValue, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { WorkingLedger } from "../src/agent/working-ledger.ts";

const emptyTool: AgentTool<JsonValue> = {
  name: "inspect",
  description: "Return a fixed fact for a test.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  validate(input) {
    return input && typeof input === "object" && !Array.isArray(input)
      ? { ok: true, value: input }
      : { ok: false, error: "Expected an object." };
  },
  async execute() {
    return "confirmed-fact";
  },
};

test("the loop appends a tool result before the model gives its final answer", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        assert.equal(request.messages.at(-1)?.role, "user");
        assert.match(request.workingState, /暂无/);
        return {
          kind: "tool_calls",
          content: "Need evidence.",
          toolCalls: [{ id: "inspect-1", name: "inspect", input: {} }],
        };
      }

      const toolMessage = request.messages.at(-1);
      assert.deepEqual(toolMessage, {
        role: "tool",
        toolCallId: "inspect-1",
        name: "inspect",
        status: "success",
        content: "confirmed-fact",
      });
      assert.match(request.workingState, /confirmed-fact/);
      return { kind: "final", content: "已使用 confirmed-fact。" };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([emptyTool]), {
    workspaceRoot: process.cwd(),
  }).run("检查项目。");

  assert.equal(result.answer, "已使用 confirmed-fact。");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "model_requested",
      "tool_call",
      "tool_execution_started",
      "tool_finalized",
      "model_requested",
      "agent_completed",
    ],
  );
});

test("the loop preserves supplied conversation turns before the current task", async () => {
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      assert.deepEqual(
        request.messages.map((message) => message.role),
        ["system", "user", "assistant", "user"],
      );
      assert.equal(request.messages[1]?.content, "之前的任务");
      assert.equal(request.messages[2]?.content, "之前的结论");
      assert.equal(request.messages[3]?.content, "继续追问");
      return { kind: "final", content: "已结合上一轮上下文回答。" };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([]), {
    workspaceRoot: process.cwd(),
  }).run("继续追问", {
    conversationHistory: [
      { role: "user", content: "之前的任务" },
      { role: "assistant", content: "之前的结论" },
    ],
  });

  assert.equal(result.answer, "已结合上一轮上下文回答。");
});

test("guided mode requires a plan approval before executing tools", async () => {
  let modelCallCount = 0;
  let toolExecutionCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        assert.equal(request.phase, "planning");
        assert.deepEqual(request.tools, []);
        return { kind: "final", content: "1. Read the target.\n2. Make the smallest safe change." };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "execution");
        assert.equal(request.messages.at(-1)?.role, "user");
        return {
          kind: "tool_calls",
          content: "Read the target first.",
          toolCalls: [{ id: "guided-read-1", name: "inspect", input: {} }],
        };
      }
      assert.equal(request.messages.at(-1)?.role, "tool");
      return { kind: "final", content: "Completed after verified inspection." };
    },
  };
  const countingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      toolExecutionCount += 1;
      return "confirmed-fact";
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([countingTool]), {
    workspaceRoot: process.cwd(),
    requirePlanApproval: true,
    requestPlanApproval: async (request) => {
      assert.match(request.plan, /smallest safe change/);
      return true;
    },
  }).run("Make a small change.");

  assert.equal(result.answer, "Completed after verified inspection.");
  assert.equal(toolExecutionCount, 1);
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "model_requested",
      "plan_proposed",
      "plan_decision",
      "model_requested",
      "tool_call",
      "tool_execution_started",
      "tool_finalized",
      "model_requested",
      "agent_completed",
    ],
  );
});

test("guided mode cancellation returns without executing tools", async () => {
  let modelCallCount = 0;
  let toolExecutionCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      assert.equal(request.phase, "planning");
      return { kind: "final", content: "1. Inspect.\n2. Edit." };
    },
  };
  const countingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      toolExecutionCount += 1;
      return "should-not-run";
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([countingTool]), {
    workspaceRoot: process.cwd(),
    requirePlanApproval: true,
    requestPlanApproval: async () => false,
  }).run("Do not start this plan.");

  assert.equal(modelCallCount, 1);
  assert.equal(toolExecutionCount, 0);
  assert.match(result.answer, /用户未确认计划/);
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["model_requested", "plan_proposed", "plan_decision", "agent_stopped"],
  );
});

test("guided planning is a preparation phase and does not consume the execution step budget", async () => {
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        assert.equal(request.phase, "planning");
        return { kind: "final", content: "1. Inspect the workspace." };
      }
      assert.equal(request.phase, "execution");
      return { kind: "final", content: "Execution budget remains available." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    requirePlanApproval: true,
    requestPlanApproval: async () => true,
  }).run("Confirm then answer.");

  assert.equal(result.answer, "Execution budget remains available.");
  assert.equal(modelCallCount, 2);
});

test("an unknown tool still receives a terminal lifecycle event and a tool error message", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "Try an unavailable tool.",
          toolCalls: [{ id: "missing-1", name: "missing_tool", input: {} }],
        };
      }

      const toolMessage = request.messages.at(-1);
      assert.equal(toolMessage?.role, "tool");
      assert.equal(toolMessage?.status, "error");
      return { kind: "final", content: "我已收到工具错误。" };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([emptyTool]), {
    workspaceRoot: process.cwd(),
  }).run("使用不存在的工具。");
  const finalized = result.events.find((event) => event.type === "tool_finalized");

  assert.deepEqual(finalized, {
    type: "tool_finalized",
    step: 1,
    toolCallId: "missing-1",
    toolName: "missing_tool",
    status: "error",
    detail: "未知工具：missing_tool",
  });
});

test("任务账本只保留紧凑的工具观察摘要", () => {
  const ledger = new WorkingLedger("验证摘要长度");
  ledger.record({ toolName: "read_file", status: "success", summary: "a".repeat(600) });

  const rendered = ledger.render();
  assert.match(rendered, /任务账本摘要已截断/);
  assert.ok(rendered.length < 600);
});

test("a per-step tool-call budget gives overflow calls an error terminal event", async () => {
  let executionCount = 0;
  let modelCallCount = 0;
  const countingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      executionCount += 1;
      return `confirmed-${executionCount}`;
    },
  };
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Inspect three facts.",
          toolCalls: [
            { id: "budget-1", name: "inspect", input: {} },
            { id: "budget-2", name: "inspect", input: {} },
            { id: "budget-3", name: "inspect", input: {} },
          ],
        };
      }

      const overflow = request.messages.at(-1);
      assert.equal(overflow?.role, "tool");
      if (overflow?.role === "tool") {
        assert.equal(overflow.toolCallId, "budget-3");
        assert.equal(overflow.status, "error");
        assert.match(overflow.content, /maxToolCallsPerStep=2/);
      }
      return { kind: "final", content: "Enough evidence." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([countingTool]), {
    workspaceRoot: process.cwd(),
    maxToolCallsPerStep: 2,
  }).run("Inspect the project.");

  assert.equal(result.answer, "Enough evidence.");
  assert.equal(executionCount, 2);
  assert.equal(result.events.filter((event) => event.type === "tool_execution_started").length, 2);
  assert.deepEqual(
    result.events.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "budget-3",
    ),
    {
      type: "tool_finalized",
      step: 1,
      toolCallId: "budget-3",
      toolName: "inspect",
      status: "error",
      detail: "本轮工具调用超过上限 maxToolCallsPerStep=2；请基于本轮其余工具结果给出最终回答。",
    },
  );
});

test("a total tool-call budget rejects calls after the budget is consumed", async () => {
  let executionCount = 0;
  let modelCallCount = 0;
  const countingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      executionCount += 1;
      return `confirmed-${executionCount}`;
    },
  };
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Inspect one fact.",
          toolCalls: [{ id: "total-1", name: "inspect", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        return {
          kind: "tool_calls",
          content: "Inspect two more facts.",
          toolCalls: [
            { id: "total-2", name: "inspect", input: {} },
            { id: "total-3", name: "inspect", input: {} },
          ],
        };
      }

      const overflow = request.messages.at(-1);
      assert.equal(overflow?.role, "tool");
      if (overflow?.role === "tool") {
        assert.equal(overflow.toolCallId, "total-3");
        assert.equal(overflow.status, "error");
        assert.match(overflow.content, /maxToolCalls=2/);
      }
      return { kind: "final", content: "Enough evidence." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([countingTool]), {
    workspaceRoot: process.cwd(),
    maxToolCalls: 2,
  }).run("Inspect the project.");

  assert.equal(result.answer, "Enough evidence.");
  assert.equal(executionCount, 2);
  assert.deepEqual(
    result.events.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "total-3",
    ),
    {
      type: "tool_finalized",
      step: 2,
      toolCallId: "total-3",
      toolName: "inspect",
      status: "error",
      detail: "本次任务已达到工具调用上限 maxToolCalls=2；请基于已有结果给出最终回答。",
    },
  );
});
