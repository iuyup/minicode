import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import {
  ToolExecutionError,
  type AgentTool,
  type ChatModel,
  type JsonValue,
  type ModelRequest,
  type ModelResponse,
  type StreamingChatModel,
  type ToolExecutionResult,
} from "../src/agent/contracts.ts";
import { JsonlAuditLog, sanitizeAgentEvent, type AgentEvent } from "../src/agent/events.ts";
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

type ProjectCheckOutcome = "success" | "nonzero" | "timeout" | "start_failure";

function validateObject(input: JsonValue) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? { ok: true as const, value: input }
    : { ok: false as const, error: "Expected an object." };
}

function createProjectCheckTool(outcomes: readonly ProjectCheckOutcome[]) {
  let executionCount = 0;
  const tool: AgentTool<JsonValue, ToolExecutionResult> = {
    name: "run_project_check",
    description: "Run a scripted fixed project check.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: validateObject,
    getCommandApprovalRequest(input) {
      const action = input && typeof input === "object" && !Array.isArray(input) && input.action === "check"
        ? "check"
        : "test";
      return {
        kind: "verification",
        action,
        command: action === "check" ? "npm run check" : "npm test",
        workingDirectory: process.cwd(),
        riskLevel: "medium",
        risk: "Scripted test command.",
      };
    },
    async execute(input) {
      const action = input && typeof input === "object" && !Array.isArray(input) && input.action === "check"
        ? "check"
        : "test";
      const outcome = outcomes[executionCount];
      executionCount += 1;
      if (!outcome) {
        throw new Error(`Missing scripted project-check outcome ${executionCount}.`);
      }
      if (outcome === "nonzero") {
        throw new ToolExecutionError("scripted check failed", {
          action,
          exitCode: 1,
          timedOut: false,
        });
      }
      if (outcome === "timeout") {
        throw new ToolExecutionError("scripted check timed out", {
          action,
          exitCode: null,
          timedOut: true,
        });
      }
      if (outcome === "start_failure") {
        throw new ToolExecutionError("scripted check could not start", { action });
      }
      return {
        content: "scripted check passed",
        metadata: { action, exitCode: 0, timedOut: false },
      };
    },
  };
  return {
    tool,
    get executionCount() {
      return executionCount;
    },
  };
}

function createCountingTool(
  name: string,
  implementation: () => ToolExecutionResult | Promise<ToolExecutionResult> = () => `${name} completed`,
) {
  let executionCount = 0;
  const tool: AgentTool<JsonValue, ToolExecutionResult> = {
    name,
    description: `Scripted ${name} tool.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: validateObject,
    async execute() {
      executionCount += 1;
      return implementation();
    },
  };
  return {
    tool,
    get executionCount() {
      return executionCount;
    },
  };
}

function toolCallResponse(id: string, name: string, input: JsonValue): ModelResponse {
  return {
    kind: "tool_calls",
    content: "",
    toolCalls: [{ id, name, input }],
  };
}

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

test("流式候选回答只走展示通道，工具调用前会撤回且不会写入审计事件", async () => {
  let calls = 0;
  const outputEvents: Array<{ type: string; step: number; text?: string }> = [];
  const model: StreamingChatModel = {
    async complete(): Promise<ModelResponse> {
      throw new Error("本测试应调用 completeStream。");
    },
    async completeStream(_request, observer): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        observer.onTextDelta("这是工具调用前的临时说明。");
        return {
          kind: "tool_calls",
          content: "这是工具调用前的临时说明。",
          toolCalls: [{ id: "stream-inspect-1", name: "inspect", input: {} }],
        };
      }
      observer.onTextDelta("已依据工具结果完成。\n");
      return { kind: "final", content: "已依据工具结果完成。" };
    },
  };
  const inspectingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      assert.deepEqual(outputEvents, [
        { type: "text_delta", step: 1, text: "这是工具调用前的临时说明。" },
        { type: "discarded", step: 1 },
      ]);
      return "confirmed-fact";
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([inspectingTool]), {
    workspaceRoot: process.cwd(),
  }).run("检查流式工具边界。", {
    onModelOutput: (event) => outputEvents.push(event),
  });

  assert.equal(result.answer, "已依据工具结果完成。");
  assert.deepEqual(outputEvents, [
    { type: "text_delta", step: 1, text: "这是工具调用前的临时说明。" },
    { type: "discarded", step: 1 },
    { type: "text_delta", step: 2, text: "已依据工具结果完成。\n" },
  ]);
  assert.equal(JSON.stringify(result.events).includes("临时说明"), false);
});

test("流式最终回答未通过源码取证时会撤回草稿，不把未验证文本留给展示层", async () => {
  const outputEvents: Array<{ type: string; step: number; text?: string }> = [];
  const model: StreamingChatModel = {
    async complete(): Promise<ModelResponse> {
      throw new Error("本测试应调用 completeStream。");
    },
    async completeStream(_request, observer): Promise<ModelResponse> {
      observer.onTextDelta("未取证的临时结论。");
      return { kind: "final", content: "未取证的临时结论。" };
    },
  };
  const agent = new AgentLoop(model, new ToolRegistry([]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  });

  await assert.rejects(
    agent.run("必须提供源码证据。", {
      onModelOutput: (event) => outputEvents.push(event),
    }),
    /最终回答缺少已读取源码/u,
  );
  assert.deepEqual(outputEvents, [
    { type: "text_delta", step: 1, text: "未取证的临时结论。" },
    { type: "discarded", step: 1 },
  ]);
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
  const planningPrompt = "PLANNING-ONLY-MARKER: return a concise plan.";
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        assert.equal(request.phase, "planning");
        assert.deepEqual(request.tools, []);
        assert.equal(request.messages.at(-1)?.content, planningPrompt);
        return { kind: "final", content: "1. Read the target.\n2. Make the smallest safe change." };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "execution");
        assert.equal(request.messages.at(-1)?.role, "user");
        assert.equal(request.messages.some((message) => message.content.includes(planningPrompt)), false);
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
    planningPrompt,
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
      detail: "本轮工具调用超过上限 maxToolCallsPerStep=2；该调用未执行，请在下一模型轮只重新请求一个仍然必要的工具，不要据此声称任务完成。",
    },
  );
});

test("a successful patch cannot complete before a later successful project test", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Apply the patch.",
          toolCalls: [{ id: "unverified-patch", name: "apply_patch", input: {} }],
        };
      }

      assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
      assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
      return { kind: "final", content: "Claim completion without running the required test." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    requirePostPatchTest: true,
  }).run("Patch and verify the project.");

  assert.equal(modelCallCount, 2);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 0);
  assert.match(result.answer, /补丁尚未通过后续 run_project_check\(test\) 验证/);
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.at(-1)?.type, "agent_stopped");
  assert.ok(result.messages.some(
    (message) => message.role === "assistant" && /Claim completion/.test(message.content),
  ));
});

test("a late successful patch reserves one test call and a final turn", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Use the final original tool slot for the patch.",
          toolCalls: [{ id: "late-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return {
          kind: "tool_calls",
          content: "Run the required fixed test.",
          toolCalls: [{ id: "late-test", name: "run_project_check", input: { action: "test" } }],
        };
      }

      assert.equal(modelCallCount, 3);
      assert.equal(request.toolChoice, undefined);
      return { kind: "final", content: "Patch and later fixed test both succeeded." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    maxToolCalls: 1,
    finalOnlyAfterToolBudget: true,
    requirePostPatchTest: true,
    requestCommandApproval: async () => true,
  }).run("Patch on the last slot, then prove it works.");

  assert.equal(result.answer, "Patch and later fixed test both succeeded.");
  assert.equal(modelCallCount, 3);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 1);
  const patchFinalizedIndex = result.events.findIndex(
    (event) => event.type === "tool_finalized" && event.toolCallId === "late-patch" && event.status === "success",
  );
  const testFinalizedIndex = result.events.findIndex(
    (event) => event.type === "tool_finalized" && event.toolCallId === "late-test" && event.status === "success",
  );
  const completedIndex = result.events.findIndex((event) => event.type === "agent_completed");
  assert.ok(patchFinalizedIndex >= 0 && patchFinalizedIndex < testFinalizedIndex);
  assert.ok(testFinalizedIndex < completedIndex);
});

test("a post-patch check action cannot discharge the required test", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Apply the patch.",
          toolCalls: [{ id: "test-debt-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        return {
          kind: "tool_calls",
          content: "Try check instead of the required test.",
          toolCalls: [{ id: "wrong-check", name: "run_project_check", input: { action: "check" } }],
        };
      }
      return { kind: "final", content: "Pretend that check discharged the test debt." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    requirePostPatchTest: true,
  }).run("Require the fixed test action after patching.");

  assert.equal(projectCheck.executionCount, 0);
  assert.ok(result.events.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "wrong-check" &&
      event.status === "error" &&
      /只接受 run_project_check 的 test 动作/.test(event.detail),
  ));
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.at(-1)?.type, "agent_stopped");
});

test("a late patch leaves room for test, two Git reads, and the final answer", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  const inspectGit = createCountingTool("inspect_git");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCallCount += 1;
      const responses: ModelResponse[] = [
        toolCallResponse("late-git-patch", "apply_patch", {}),
        toolCallResponse("late-git-test", "run_project_check", { action: "test" }),
        toolCallResponse("late-git-status", "inspect_git", { action: "status" }),
        toolCallResponse("late-git-diff", "inspect_git", { action: "diff" }),
        { kind: "final", content: "Patch, test, status, and diff all completed within the cap." },
      ];
      const response = responses[modelCallCount - 1];
      if (!response) throw new Error("Unexpected late Git closeout model call.");
      return response;
    },
  };

  const result = await new AgentLoop(
    model,
    new ToolRegistry([patch.tool, projectCheck.tool, inspectGit.tool]),
    {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      hardMaxModelRequests: 5,
      hardMaxToolCalls: 4,
      finalOnlyAfterToolBudget: true,
      requirePostPatchTest: true,
      requestCommandApproval: async () => true,
    },
  ).run("Keep the bounded read-only Git closeout after a late patch.");

  assert.equal(modelCallCount, 5);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 1);
  assert.equal(inspectGit.executionCount, 2);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("a rejected forced post-patch tool closes out after the required test without optional Git", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  const wrongTool = createCountingTool("read_file");
  const inspectGit = createCountingTool("inspect_git");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) return toolCallResponse("recovery-patch", "apply_patch", {});
      if (modelCallCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return toolCallResponse("recovery-wrong", "read_file", {});
      }
      if (modelCallCount === 3) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return toolCallResponse("recovery-test", "run_project_check", { action: "test" });
      }
      assert.equal(modelCallCount, 4);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "补丁已通过固定测试。" };
    },
  };

  const result = await new AgentLoop(
    model,
    new ToolRegistry([patch.tool, projectCheck.tool, wrongTool.tool, inspectGit.tool]),
    {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      hardMaxModelRequests: 4,
      hardMaxToolCalls: 2,
      finalOnlyAfterToolBudget: true,
      requirePostPatchTest: true,
      requestCommandApproval: async () => true,
    },
  ).run("在错误的强制工具请求后仍必须先测试，再收尾。 ");

  assert.equal(result.answer, "补丁已通过固定测试。");
  assert.equal(modelCallCount, 4);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 1);
  assert.equal(wrongTool.executionCount, 0);
  assert.equal(inspectGit.executionCount, 0);
  assert.equal(result.events.filter((event) => event.type === "tool_execution_started").length, 2);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("a rejected post-repair closeout skips Git and preserves the final answer", async () => {
  const projectCheck = createProjectCheckTool(["nonzero", "success"]);
  const patch = createCountingTool("apply_patch");
  const inspectGit = createCountingTool("inspect_git");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) return toolCallResponse("repair-recovery-initial", "run_project_check", { action: "test" });
      if (modelCallCount === 2) {
        assert.equal(request.phase, "repair_planning");
        assert.deepEqual(request.tools, []);
        return { kind: "final", content: "应用一次最小补丁并运行固定测试。" };
      }
      if (modelCallCount === 3) return toolCallResponse("repair-recovery-patch", "apply_patch", {});
      if (modelCallCount === 4) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        return toolCallResponse("repair-recovery-test", "run_project_check", { action: "test" });
      }
      if (modelCallCount === 5) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "inspect_git" });
        return toolCallResponse("repair-recovery-wrong", "run_project_check", { action: "test" });
      }
      assert.equal(modelCallCount, 6);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "修复后的固定测试已通过。" };
    },
  };

  const result = await new AgentLoop(
    model,
    new ToolRegistry([projectCheck.tool, patch.tool, inspectGit.tool]),
    {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      hardMaxModelRequests: 6,
      hardMaxToolCalls: 5,
      finalOnlyAfterToolBudget: true,
      enableFailureRepair: true,
      requirePostPatchTest: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async () => true,
    },
  ).run("一次修复成功后，错误的 Git 收尾请求不应吞掉最终回答。 ");

  assert.equal(result.answer, "修复后的固定测试已通过。");
  assert.equal(modelCallCount, 6);
  assert.equal(projectCheck.executionCount, 2);
  assert.equal(patch.executionCount, 1);
  assert.equal(inspectGit.executionCount, 0);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("repeated forced-tool violations receive only one closeout recovery and never exceed the cap", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  const wrongTool = createCountingTool("read_file");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) return toolCallResponse("repeat-patch", "apply_patch", {});
      return toolCallResponse(`repeat-wrong-${modelCallCount}`, "read_file", {});
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool, wrongTool.tool]), {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      hardMaxModelRequests: 4,
      hardMaxToolCalls: 2,
      finalOnlyAfterToolBudget: true,
      requirePostPatchTest: true,
    }).run("不得为反复违例突破硬上限。"),
    /达到最大步数 maxSteps=4/u,
  );

  assert.equal(modelCallCount, 4);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 0);
  assert.equal(wrongTool.executionCount, 0);
});

test("sanitized stopped audits retain only a stable reason code", () => {
  const privateReason = "模型请求失败：provider-private-body-7c1a";
  const sanitized = sanitizeAgentEvent(
    { type: "agent_stopped", step: 4, reason: privateReason },
    "2026-08-25T00:00:00.000Z",
  );
  assert.deepEqual(sanitized, {
    timestamp: "2026-08-25T00:00:00.000Z",
    type: "agent_stopped",
    step: 4,
    stopReasonCode: "model_request_failed",
  });
  assert.equal(JSON.stringify(sanitized).includes(privateReason), false);
  assert.equal(
    sanitizeAgentEvent(
      { type: "agent_stopped", step: 5, reason: "达到最大步数 maxSteps=18，但模型尚未给出最终回答。" },
      "2026-08-25T00:00:00.000Z",
    ).stopReasonCode,
    "max_model_requests_without_final",
  );
});

test("a rejected same-turn test is retried only after the patch result is observed", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Request a patch and test too early in one response.",
          toolCalls: [
            { id: "same-turn-patch", name: "apply_patch", input: {} },
            { id: "same-turn-test", name: "run_project_check", input: { action: "test" } },
          ],
        };
      }
      if (modelCallCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        return {
          kind: "tool_calls",
          content: "Retry the test after observing the patch result.",
          toolCalls: [{ id: "next-turn-test", name: "run_project_check", input: { action: "test" } }],
        };
      }
      return { kind: "final", content: "Verified after the required later test." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    maxToolCalls: 1,
    maxToolCallsPerStep: 1,
    finalOnlyAfterToolBudget: true,
    requirePostPatchTest: true,
    requestCommandApproval: async () => true,
  }).run("Do not treat a same-response test request as post-patch evidence.");

  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 1);
  assert.deepEqual(
    result.events
      .filter((event) => "toolCallId" in event && event.toolCallId === "same-turn-test")
      .map((event) => event.type),
    ["tool_call", "tool_finalized"],
  );
  assert.equal(result.events.some(
    (event) => event.type === "tool_execution_started" && event.toolCallId === "same-turn-test",
  ), false);
  assert.ok(result.events.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "same-turn-test" &&
      event.status === "error" &&
      /下一模型轮执行固定 test/.test(event.detail),
  ));
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("a failed required post-patch test enters bounded repair planning", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["nonzero"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Apply the patch.",
          toolCalls: [{ id: "repair-entry-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        return {
          kind: "tool_calls",
          content: "Run the required test.",
          toolCalls: [{ id: "repair-entry-test", name: "run_project_check", input: { action: "test" } }],
        };
      }

      assert.equal(request.phase, "repair_planning");
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "Inspect the failure and make one minimal repair." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    maxToolCalls: 1,
    finalOnlyAfterToolBudget: true,
    requirePostPatchTest: true,
    enableFailureRepair: true,
    requestCommandApproval: async () => true,
    requestRepairApproval: async () => false,
  }).run("Enter one bounded repair only after a real failed test.");

  assert.equal(modelCallCount, 3);
  assert.equal(projectCheck.executionCount, 1);
  assert.deepEqual(
    result.events.filter((event) => event.type === "repair_decision"),
    [{ type: "repair_decision", step: 3, decision: "rejected" }],
  );
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.at(-1)?.type, "agent_stopped");
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

test("a final-only budget turn exposes no tools and rejects another tool request", async () => {
  let modelCallCount = 0;
  let executionCount = 0;
  const observedEvents: AgentEvent[] = [];
  const countingTool: AgentTool<JsonValue> = {
    ...emptyTool,
    async execute() {
      executionCount += 1;
      return "confirmed-final-budget";
    },
  };
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        assert.equal(request.tools.length, 1);
        return {
          kind: "tool_calls",
          content: "Inspect the final fact.",
          toolCalls: [{ id: "final-budget-1", name: "inspect", input: {} }],
        };
      }

      assert.deepEqual(request.tools, []);
      return {
        kind: "tool_calls",
        content: "Try one more tool even though only a summary is allowed.",
        toolCalls: [{ id: "final-budget-2", name: "inspect", input: {} }],
      };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([countingTool]), {
      workspaceRoot: process.cwd(),
      maxSteps: 2,
      maxToolCalls: 1,
      finalOnlyAfterToolBudget: true,
      onEvent: (event) => observedEvents.push(event),
    }).run("Inspect and then summarize."),
    /工具预算已耗尽，本轮只能给出最终回答/,
  );

  assert.equal(modelCallCount, 2);
  assert.equal(executionCount, 1);
  assert.deepEqual(
    observedEvents
      .filter((event) => "toolCallId" in event && event.toolCallId === "final-budget-2")
      .map((event) => event.type),
    ["tool_call", "tool_finalized"],
  );
});

test("failure repair stops safely when direction approval is cancelled, missing, or unavailable", async (t) => {
  const scenarios = [
    {
      name: "cancelled",
      outcome: "nonzero" as const,
      approval: "cancel" as const,
      expectedReason: /用户未确认修复方向/,
    },
    {
      name: "missing callback after a timeout",
      outcome: "timeout" as const,
      approval: "missing" as const,
      expectedReason: /未配置本地修复方向确认/,
    },
    {
      name: "callback throws",
      outcome: "nonzero" as const,
      approval: "throw" as const,
      expectedReason: /本地修复方向确认不可用/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const projectCheck = createProjectCheckTool([scenario.outcome]);
      let modelCallCount = 0;
      let approvalCallCount = 0;
      const model: ChatModel = {
        async complete(request): Promise<ModelResponse> {
          modelCallCount += 1;
          if (modelCallCount === 1) {
            assert.equal(request.phase, "execution");
            return {
              kind: "tool_calls",
              content: "Run the fixed check.",
              toolCalls: [{ id: `${scenario.name}-check`, name: "run_project_check", input: {} }],
            };
          }

          assert.equal(modelCallCount, 2);
          assert.equal(request.phase, "repair_planning");
          assert.deepEqual(request.tools, []);
          return { kind: "final", content: "Inspect the failure and make one minimal repair." };
        },
      };
      const approvalOptions = scenario.approval === "missing"
        ? {}
        : {
            requestRepairApproval: async () => {
              approvalCallCount += 1;
              if (scenario.approval === "throw") {
                throw new Error("approval UI unavailable");
              }
              return false;
            },
          };

      const result = await new AgentLoop(model, new ToolRegistry([projectCheck.tool]), {
        workspaceRoot: process.cwd(),
        enableFailureRepair: true,
        requestCommandApproval: async () => true,
        ...approvalOptions,
      }).run("Run tests and repair one confirmed failure.");

      assert.equal(modelCallCount, 2);
      assert.equal(projectCheck.executionCount, 1);
      assert.equal(approvalCallCount, scenario.approval === "missing" ? 0 : 1);
      assert.match(result.answer, scenario.expectedReason);
      assert.equal(result.events.filter((event) => event.type === "repair_proposed").length, 1);
      assert.deepEqual(
        result.events.filter((event) => event.type === "repair_decision"),
        [{ type: "repair_decision", step: 2, decision: "rejected" }],
      );
      assert.equal(result.events.at(-1)?.type, "agent_stopped");
    });
  }
});

test("startup failures, cancelled commands, and ordinary tool errors do not enter repair planning", async (t) => {
  async function assertDoesNotTrigger(
    state: ReturnType<typeof createProjectCheckTool> | ReturnType<typeof createCountingTool>,
    commandApproved: boolean,
  ) {
    let modelCallCount = 0;
    let repairApprovalCount = 0;
    const model: ChatModel = {
      async complete(request): Promise<ModelResponse> {
        modelCallCount += 1;
        if (modelCallCount === 1) {
          return {
            kind: "tool_calls",
            content: "Collect one result.",
            toolCalls: [{ id: "non-trigger-1", name: state.tool.name, input: {} }],
          };
        }

        assert.equal(request.phase, "execution");
        assert.notDeepEqual(request.tools, []);
        return { kind: "final", content: "No bounded repair was opened." };
      },
    };

    const result = await new AgentLoop(model, new ToolRegistry([state.tool]), {
      workspaceRoot: process.cwd(),
      enableFailureRepair: true,
      requestCommandApproval: async () => commandApproved,
      requestRepairApproval: async () => {
        repairApprovalCount += 1;
        return true;
      },
    }).run("Observe the failure boundary.");

    assert.equal(result.answer, "No bounded repair was opened.");
    assert.equal(modelCallCount, 2);
    assert.equal(repairApprovalCount, 0);
    assert.equal(result.events.some((event) => event.type === "repair_proposed"), false);
  }

  await t.test("the project check could not start", async () => {
    const state = createProjectCheckTool(["start_failure"]);
    await assertDoesNotTrigger(state, true);
    assert.equal(state.executionCount, 1);
  });

  await t.test("the user cancelled the command before execution", async () => {
    const state = createProjectCheckTool(["nonzero"]);
    await assertDoesNotTrigger(state, false);
    assert.equal(state.executionCount, 0);
  });

  await t.test("an unrelated tool returned an ordinary execution error", async () => {
    const state = createCountingTool("inspect", () => {
      throw new ToolExecutionError("ordinary tool failed", {
        action: "inspect",
        exitCode: 1,
        timedOut: false,
      });
    });
    await assertDoesNotTrigger(state, true);
    assert.equal(state.executionCount, 1);
  });
});

test("a tool request during repair planning is rejected with a terminal lifecycle", async () => {
  const projectCheck = createProjectCheckTool(["nonzero"]);
  const patch = createCountingTool("apply_patch");
  const observedEvents: AgentEvent[] = [];
  let modelCallCount = 0;
  let repairApprovalCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Run the failing check.",
          toolCalls: [{ id: "planning-check", name: "run_project_check", input: {} }],
        };
      }

      assert.equal(request.phase, "repair_planning");
      assert.deepEqual(request.tools, []);
      return {
        kind: "tool_calls",
        content: "Improperly patch during the no-tool direction phase.",
        toolCalls: [{ id: "planning-patch", name: "apply_patch", input: {} }],
      };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([projectCheck.tool, patch.tool]), {
      workspaceRoot: process.cwd(),
      enableFailureRepair: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async () => {
        repairApprovalCount += 1;
        return true;
      },
      onEvent: (event) => observedEvents.push(event),
    }).run("Reject tools while only a repair direction is allowed."),
    /修复方向阶段不允许调用工具/,
  );

  assert.equal(modelCallCount, 2);
  assert.equal(projectCheck.executionCount, 1);
  assert.equal(patch.executionCount, 0);
  assert.equal(repairApprovalCount, 0);
  assert.deepEqual(
    observedEvents
      .filter((event) => "toolCallId" in event && event.toolCallId === "planning-patch")
      .map((event) => event.type),
    ["tool_call", "tool_finalized"],
  );
  assert.equal(observedEvents.at(-1)?.type, "agent_stopped");
});

test("an explicit initial check cannot be bypassed or converted into closeout recovery", async () => {
  const projectCheck = createProjectCheckTool(["nonzero"]);
  const read = createCountingTool("read_file");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        assert.equal(request.phase, "execution");
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return toolCallResponse("initial-wrong-read", "read_file", {});
      }
      if (modelCallCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return toolCallResponse("initial-test", "run_project_check", { action: "test" });
      }
      if (modelCallCount === 3) {
        assert.equal(request.phase, "repair_planning");
        assert.deepEqual(request.tools, []);
        return { kind: "final", content: "读取失败位置，应用最小修复，再运行 test。" };
      }
      if (modelCallCount === 4) {
        assert.equal(request.phase, "execution");
        assert.equal(request.tools.some((tool) => tool.name === "read_file"), true);
        return toolCallResponse("repair-read", "read_file", {});
      }
      assert.equal(modelCallCount, 5);
      return { kind: "final", content: "尚未完成修复。" };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([projectCheck.tool, read.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 5,
    maxToolCalls: 1,
    finalOnlyAfterToolBudget: true,
    enableFailureRepair: true,
    initialProjectCheckAction: "test",
    requestCommandApproval: async () => true,
    requestRepairApproval: async () => true,
  }).run("先复现失败，再开始一次有界修复。");

  assert.equal(modelCallCount, 5);
  assert.equal(projectCheck.executionCount, 1);
  assert.equal(read.executionCount, 1);
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.filter((event) => event.type === "repair_proposed").length, 1);
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "tool_finalized")
      .map((event) => event.type === "tool_finalized" ? [event.toolCallId, event.status] : []),
    [
      ["initial-wrong-read", "error"],
      ["initial-test", "error"],
      ["repair-read", "success"],
    ],
  );
  assert.match(result.answer, /修复尚未完成成功复验/);
});

test("one approved repair blocks same-turn leftovers and a second failed check enters final-only", async () => {
  const projectCheck = createProjectCheckTool(["nonzero", "nonzero"]);
  const patch = createCountingTool("apply_patch");
  const read = createCountingTool("read_file");
  const observedEvents: AgentEvent[] = [];
  let modelCallCount = 0;
  let repairApprovalCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Run the check, then optimistically patch.",
          toolCalls: [
            { id: "initial-check", name: "run_project_check", input: {} },
            { id: "initial-tail-patch", name: "apply_patch", input: {} },
          ],
        };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "repair_planning");
        assert.deepEqual(request.tools, []);
        assert.deepEqual(
          request.messages.slice(-4).map((message) => message.role),
          ["assistant", "tool", "tool", "user"],
          "all tool results must precede the synthetic repair-planning user message",
        );
        assert.match(request.messages.at(-1)?.content ?? "", /无工具的修复方向阶段/);
        return { kind: "final", content: "Apply one minimal patch and rerun the fixed check." };
      }
      if (modelCallCount === 3) {
        assert.equal(request.phase, "execution");
        assert.deepEqual(
          request.tools.map((tool) => tool.name).sort(),
          ["apply_patch", "read_file", "run_project_check"],
        );
        return {
          kind: "tool_calls",
          content: "Repair once, recheck, then keep reading.",
          toolCalls: [
            { id: "repair-patch", name: "apply_patch", input: {} },
            { id: "repair-recheck", name: "run_project_check", input: {} },
            { id: "repair-tail-read", name: "read_file", input: {} },
          ],
        };
      }

      assert.equal(modelCallCount, 4);
      assert.deepEqual(request.tools, []);
      return {
        kind: "tool_calls",
        content: "Attempt an impermissible second repair.",
        toolCalls: [{ id: "second-repair", name: "apply_patch", input: {} }],
      };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([projectCheck.tool, patch.tool, read.tool]), {
      workspaceRoot: process.cwd(),
      enableFailureRepair: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async (request) => {
        repairApprovalCount += 1;
        assert.equal(request.failedAction, "test");
        assert.equal(request.attempt, 1);
        assert.equal(request.maximumAttempts, 1);
        assert.match(request.direction, /minimal patch/);
        return true;
      },
      onEvent: (event) => observedEvents.push(event),
    }).run("Repair exactly one real test failure."),
    /一次修复复验仍失败，本轮只能总结未完成状态/,
  );

  assert.equal(modelCallCount, 4);
  assert.equal(repairApprovalCount, 1);
  assert.equal(projectCheck.executionCount, 2);
  assert.equal(patch.executionCount, 1);
  assert.equal(read.executionCount, 0);
  assert.equal(observedEvents.filter((event) => event.type === "repair_proposed").length, 1);
  assert.equal(observedEvents.filter((event) => event.type === "repair_decision").length, 1);
  assert.ok(observedEvents.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "initial-tail-patch" &&
      event.status === "error" &&
      /本轮其余工具调用不会执行/.test(event.detail),
  ));
  assert.ok(observedEvents.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "repair-tail-read" &&
      event.status === "error" &&
      /本轮其余工具调用不会执行/.test(event.detail),
  ));
  assert.ok(observedEvents.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "second-repair" &&
      event.status === "error" &&
      /只能总结未完成状态/.test(event.detail),
  ));
  assert.equal(observedEvents.at(-1)?.type, "agent_stopped");
});

test("a late real failure receives a bounded three-call repair budget and two-call Git closeout", async () => {
  const projectCheck = createProjectCheckTool(["nonzero", "success"]);
  const read = createCountingTool("read_file");
  const patch = createCountingTool("apply_patch");
  const inspectGit = createCountingTool("inspect_git");
  let modelCallCount = 0;
  let repairApprovalCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Use the last original tool call for the failing check.",
          toolCalls: [{ id: "budget-check", name: "run_project_check", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "repair_planning");
        assert.deepEqual(request.tools, []);
        return { kind: "final", content: "Read, patch, and rerun the fixed check." };
      }
      if (modelCallCount === 3) {
        assert.deepEqual(request.tools.map((tool) => tool.name).sort(), ["apply_patch", "read_file", "run_project_check"]);
        return {
          kind: "tool_calls",
          content: "Read the target.",
          toolCalls: [{ id: "budget-read", name: "read_file", input: {} }],
        };
      }
      if (modelCallCount === 4) {
        return {
          kind: "tool_calls",
          content: "Apply the repair.",
          toolCalls: [{ id: "budget-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 5) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return {
          kind: "tool_calls",
          content: "Rerun the fixed check.",
          toolCalls: [{ id: "budget-recheck", name: "run_project_check", input: { action: "test" } }],
        };
      }
      if (modelCallCount === 6 || modelCallCount === 7) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
        return {
          kind: "tool_calls",
          content: "Close out with read-only Git evidence.",
          toolCalls: [{ id: `budget-git-${modelCallCount}`, name: "inspect_git", input: {} }],
        };
      }
      assert.equal(modelCallCount, 8);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "Repair, recheck, and bounded Git closeout completed." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([
    projectCheck.tool,
    read.tool,
    patch.tool,
    inspectGit.tool,
  ]), {
    workspaceRoot: process.cwd(),
    maxSteps: 1,
    maxToolCalls: 1,
    finalOnlyAfterToolBudget: true,
    enableFailureRepair: true,
    requirePostPatchTest: true,
    requestCommandApproval: async () => true,
    requestRepairApproval: async () => {
      repairApprovalCount += 1;
      return true;
    },
  }).run("Complete one bounded repair after the original budget is exhausted.");

  assert.equal(result.answer, "Repair, recheck, and bounded Git closeout completed.");
  assert.equal(modelCallCount, 8);
  assert.equal(projectCheck.executionCount, 2);
  assert.equal(read.executionCount, 1);
  assert.equal(patch.executionCount, 1);
  assert.equal(inspectGit.executionCount, 2);
  assert.equal(repairApprovalCount, 1);
  assert.equal(result.events.filter((event) => event.type === "tool_execution_started").length, 6);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("a repaired check reruns test, then check, before the two-call Git closeout", async () => {
  const projectCheck = createProjectCheckTool(["nonzero", "success", "success"]);
  const firstRead = createCountingTool("read_file");
  const patch = createCountingTool("apply_patch");
  const inspectGit = createCountingTool("inspect_git");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Run the original check.",
          toolCalls: [{ id: "check-flow-initial", name: "run_project_check", input: { action: "check" } }],
        };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "repair_planning");
        return { kind: "final", content: "Read the evidence, patch once, then rerun test and check." };
      }
      if (modelCallCount === 3 || modelCallCount === 4) {
        return {
          kind: "tool_calls",
          content: "Read one repair input.",
          toolCalls: [{ id: `check-flow-read-${modelCallCount}`, name: "read_file", input: {} }],
        };
      }
      if (modelCallCount === 5) {
        return {
          kind: "tool_calls",
          content: "Apply the repair as the third free repair tool.",
          toolCalls: [{ id: "check-flow-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 6) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return {
          kind: "tool_calls",
          content: "First prove the patch with test.",
          toolCalls: [{ id: "check-flow-test", name: "run_project_check", input: { action: "test" } }],
        };
      }
      if (modelCallCount === 7) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["run_project_check"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "run_project_check" });
        return {
          kind: "tool_calls",
          content: "Now rerun the original check.",
          toolCalls: [{ id: "check-flow-recheck", name: "run_project_check", input: { action: "check" } }],
        };
      }
      if (modelCallCount === 8 || modelCallCount === 9) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
        return {
          kind: "tool_calls",
          content: "Collect bounded Git closeout evidence.",
          toolCalls: [{ id: `check-flow-git-${modelCallCount}`, name: "inspect_git", input: {} }],
        };
      }
      assert.equal(modelCallCount, 10);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "Test and the original check both passed after the repair." };
    },
  };

  const result = await new AgentLoop(
    model,
    new ToolRegistry([projectCheck.tool, firstRead.tool, patch.tool, inspectGit.tool]),
    {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      finalOnlyAfterToolBudget: true,
      enableFailureRepair: true,
      requirePostPatchTest: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async () => true,
    },
  ).run("Repair a failed check without substituting a different verification action.");

  assert.equal(result.answer, "Test and the original check both passed after the repair.");
  assert.equal(projectCheck.executionCount, 3);
  assert.equal(firstRead.executionCount, 2);
  assert.equal(patch.executionCount, 1);
  assert.equal(inspectGit.executionCount, 2);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "tool_finalized" && event.toolName === "run_project_check")
      .map((event) => event.type === "tool_finalized" ? event.metadata?.action : undefined),
    ["check", "test", "check"],
  );
});

test("each later successful patch reserves its own required test within the hard caps", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["success", "success"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCallCount += 1;
      const responses: ModelResponse[] = [
        toolCallResponse("multi-patch-1", "apply_patch", {}),
        toolCallResponse("multi-test-1", "run_project_check", { action: "test" }),
        toolCallResponse("multi-patch-2", "apply_patch", {}),
        toolCallResponse("multi-test-2", "run_project_check", { action: "test" }),
        { kind: "final", content: "Both patches received a later successful test." },
      ];
      const response = responses[modelCallCount - 1];
      if (!response) throw new Error("Unexpected multi-patch model call.");
      return response;
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 3,
    maxToolCalls: 3,
    hardMaxModelRequests: 5,
    hardMaxToolCalls: 4,
    finalOnlyAfterToolBudget: true,
    requirePostPatchTest: true,
    requestCommandApproval: async () => true,
  }).run("Apply and verify two bounded patches.");

  assert.equal(modelCallCount, 5);
  assert.equal(patch.executionCount, 2);
  assert.equal(projectCheck.executionCount, 2);
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("dynamic validation and repair growth cannot exceed absolute hard caps", async () => {
  const patch = createCountingTool("apply_patch");
  const projectCheck = createProjectCheckTool(["nonzero"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) return toolCallResponse("hard-cap-patch", "apply_patch", {});
      if (modelCallCount === 2) {
        return toolCallResponse("hard-cap-wrong-action", "run_project_check", { action: "check" });
      }
      return toolCallResponse("hard-cap-test", "run_project_check", { action: "test" });
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([patch.tool, projectCheck.tool]), {
      workspaceRoot: process.cwd(),
      maxSteps: 1,
      maxToolCalls: 1,
      hardMaxModelRequests: 3,
      hardMaxToolCalls: 2,
      finalOnlyAfterToolBudget: true,
      requirePostPatchTest: true,
      enableFailureRepair: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async () => true,
    }).run("Never exceed the absolute request or tool cap."),
    /达到最大步数 maxSteps=3/,
  );

  assert.equal(modelCallCount, 3);
  assert.equal(patch.executionCount, 1);
  assert.equal(projectCheck.executionCount, 1);
});

test("a late real failure reserves enough model steps for one complete repair", async () => {
  const inspect = createCountingTool("inspect");
  const projectCheck = createProjectCheckTool(["nonzero", "success"]);
  const read = createCountingTool("read_file");
  const patch = createCountingTool("apply_patch");
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Inspect before validating.",
          toolCalls: [{ id: "late-inspect", name: "inspect", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        return {
          kind: "tool_calls",
          content: "Run the fixed check late in the original step budget.",
          toolCalls: [{ id: "late-check", name: "run_project_check", input: {} }],
        };
      }
      if (modelCallCount === 3) {
        assert.equal(request.phase, "repair_planning");
        assert.deepEqual(request.tools, []);
        return { kind: "final", content: "Read once, patch once, and rerun the same check." };
      }
      if (modelCallCount === 4) {
        return {
          kind: "tool_calls",
          content: "Read the target.",
          toolCalls: [{ id: "late-read", name: "read_file", input: {} }],
        };
      }
      if (modelCallCount === 5) {
        return {
          kind: "tool_calls",
          content: "Apply the one repair.",
          toolCalls: [{ id: "late-patch", name: "apply_patch", input: {} }],
        };
      }
      if (modelCallCount === 6) {
        return {
          kind: "tool_calls",
          content: "Rerun the same check.",
          toolCalls: [{ id: "late-recheck", name: "run_project_check", input: {} }],
        };
      }

      assert.equal(modelCallCount, 7);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "The bounded repair was successfully revalidated." };
    },
  };

  const result = await new AgentLoop(
    model,
    new ToolRegistry([inspect.tool, projectCheck.tool, read.tool, patch.tool]),
    {
      workspaceRoot: process.cwd(),
      maxSteps: 2,
      maxToolCalls: 5,
      finalOnlyAfterToolBudget: true,
      enableFailureRepair: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: async () => true,
    },
  ).run("Reserve the complete bounded repair even after a late failure.");

  assert.equal(modelCallCount, 7);
  assert.equal(inspect.executionCount, 1);
  assert.equal(projectCheck.executionCount, 2);
  assert.equal(read.executionCount, 1);
  assert.equal(patch.executionCount, 1);
  assert.equal(result.answer, "The bounded repair was successfully revalidated.");
  assert.equal(result.events.at(-1)?.type, "agent_completed");
});

test("a direct model final during repair execution closes incomplete without agent_completed", async () => {
  const projectCheck = createProjectCheckTool(["nonzero"]);
  let modelCallCount = 0;
  const model: ChatModel = {
    async complete(request): Promise<ModelResponse> {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return {
          kind: "tool_calls",
          content: "Run the check.",
          toolCalls: [{ id: "direct-final-check", name: "run_project_check", input: {} }],
        };
      }
      if (modelCallCount === 2) {
        assert.equal(request.phase, "repair_planning");
        return { kind: "final", content: "Make one minimal repair and rerun the check." };
      }

      assert.equal(modelCallCount, 3);
      assert.equal(request.phase, "execution");
      return { kind: "final", content: "Pretend the repair is complete without using a tool." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([projectCheck.tool]), {
    workspaceRoot: process.cwd(),
    enableFailureRepair: true,
    requestCommandApproval: async () => true,
    requestRepairApproval: async () => true,
  }).run("Require proof that the approved repair completed.");

  assert.equal(modelCallCount, 3);
  assert.equal(result.answer, "修复尚未完成成功复验，任务以未完成状态停止。");
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.at(-1)?.type, "agent_stopped");
  assert.ok(result.messages.some(
    (message) => message.role === "assistant" && /Pretend the repair/.test(message.content),
  ));
});

test("plan approval callback exceptions produce a rejected decision and stopped result", async () => {
  const model: ChatModel = {
    async complete() {
      return { kind: "final", content: "Inspect the target before editing." };
    },
  };
  const result = await new AgentLoop(model, new ToolRegistry([]), {
    workspaceRoot: process.cwd(),
    requirePlanApproval: true,
    requestPlanApproval: async () => {
      throw new Error("approval UI failed");
    },
  }).run("Safely handle the unavailable approval UI.");

  assert.match(result.answer, /本地计划确认不可用/);
  assert.deepEqual(result.events.map((event) => event.type), [
    "model_requested",
    "plan_proposed",
    "plan_decision",
    "agent_stopped",
  ]);
  assert.deepEqual(result.events[2], { type: "plan_decision", step: 1, decision: "rejected" });
});

test("a throwing tool validator still receives a standard error terminal", async () => {
  let modelCalls = 0;
  const throwingValidator: AgentTool<JsonValue> = {
    ...emptyTool,
    name: "throwing_validator",
    validate() {
      throw new Error("validator exploded");
    },
  };
  const model: ChatModel = {
    async complete(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "Validate one tool call.",
          toolCalls: [{ id: "validator-1", name: "throwing_validator", input: {} }],
        };
      }
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      assert.equal(result.status, "error");
      assert.match(result.content, /工具参数校验失败：validator exploded/);
      return { kind: "final", content: "The validation failure was handled." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([throwingValidator]), {
    workspaceRoot: process.cwd(),
  }).run("Exercise validator failure.");
  const lifecycle = result.events.filter((event) => "toolCallId" in event && event.toolCallId === "validator-1");
  assert.deepEqual(lifecycle.map((event) => event.type), ["tool_call", "tool_finalized"]);
  assert.equal(lifecycle[1]?.type === "tool_finalized" ? lifecycle[1].status : undefined, "error");
});

test("maxSteps rejects zero, non-integers, and unsafe values", () => {
  for (const maxSteps of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new AgentLoop({ async complete() { return { kind: "final", content: "unused" }; } }, new ToolRegistry([]), {
        workspaceRoot: process.cwd(),
        maxSteps,
      }),
      /maxSteps 必须是大于 0 的安全整数/,
    );
  }
});

test("AbortSignal reaches model and tools, rejects remaining calls, and records agent_stopped", async (t) => {
  await t.test("model cancellation", async () => {
    const controller = new AbortController();
    const observed: AgentEvent[] = [];
    const model: ChatModel = {
      async complete(_request, signal) {
        assert.equal(signal, controller.signal);
        queueMicrotask(() => controller.abort());
        return await new Promise<ModelResponse>(() => {});
      },
    };
    await assert.rejects(
      new AgentLoop(model, new ToolRegistry([]), {
        workspaceRoot: process.cwd(),
        onEvent: (event) => observed.push(event),
      }).run("Cancel while waiting for the model.", { signal: controller.signal }),
      /任务已取消/,
    );
    assert.equal(observed.at(-1)?.type, "agent_stopped");
  });

  await t.test("tool cancellation", async () => {
    const controller = new AbortController();
    const observed: AgentEvent[] = [];
    let executions = 0;
    const cancellingTool: AgentTool<JsonValue> = {
      ...emptyTool,
      async execute(_input, context) {
        executions += 1;
        assert.equal(context.signal, controller.signal);
        controller.abort();
        return "cancelled after this result";
      },
    };
    const model: ChatModel = {
      async complete() {
        return {
          kind: "tool_calls",
          content: "Attempt two calls.",
          toolCalls: [
            { id: "cancel-first", name: "inspect", input: {} },
            { id: "cancel-second", name: "inspect", input: {} },
          ],
        };
      },
    };
    await assert.rejects(
      new AgentLoop(model, new ToolRegistry([cancellingTool]), {
        workspaceRoot: process.cwd(),
        onEvent: (event) => observed.push(event),
      }).run("Cancel during tool execution.", { signal: controller.signal }),
      /任务已取消/,
    );
    assert.equal(executions, 1);
    const secondFinal = observed.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "cancel-second",
    );
    assert.equal(secondFinal?.type === "tool_finalized" ? secondFinal.metadata?.cancelled : undefined, true);
    assert.equal(observed.at(-1)?.type, "agent_stopped");
  });
});

test("permanently pending approvals are bounded by AbortSignal", async (t) => {
  async function settleWithin(promise: Promise<unknown>): Promise<void> {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("approval cancellation did not settle")), 500);
      }),
    ]);
  }

  function pendingApproval<T>(controller: AbortController) {
    return async (_request: T, signal?: AbortSignal): Promise<boolean> => {
      assert.equal(signal, controller.signal);
      queueMicrotask(() => controller.abort());
      return await new Promise<boolean>(() => {});
    };
  }

  await t.test("plan approval", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const agent = new AgentLoop({
      async complete() {
        return { kind: "final", content: "Inspect before changing anything." };
      },
    }, new ToolRegistry([]), {
      workspaceRoot: process.cwd(),
      requirePlanApproval: true,
      requestPlanApproval: pendingApproval(controller),
      onEvent: (event) => events.push(event),
    });
    const resultPromise = agent.run("Cancel a pending plan.", { signal: controller.signal });
    await settleWithin(resultPromise);
    const result = await resultPromise;
    assert.match(result.answer, /取消/);
    assert.doesNotMatch(result.answer, /确认不可用/);
    assert.equal(events.at(-1)?.type, "agent_stopped");
  });

  await t.test("command approval", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const projectCheck = createProjectCheckTool(["success"]);
    const model: ChatModel = {
      async complete() {
        return {
          kind: "tool_calls",
          content: "Run one check.",
          toolCalls: [{ id: "pending-command", name: "run_project_check", input: {} }],
        };
      },
    };
    const agent = new AgentLoop(model, new ToolRegistry([projectCheck.tool]), {
      workspaceRoot: process.cwd(),
      requestCommandApproval: pendingApproval(controller),
      onEvent: (event) => events.push(event),
    });
    await settleWithin(agent.run("Cancel a pending command.", { signal: controller.signal }));
    assert.equal(projectCheck.executionCount, 0);
    assert.equal(events.some((event) => event.type === "tool_execution_started"), false);
    assert.equal(events.at(-1)?.type, "agent_stopped");
  });

  await t.test("edit approval", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let editEffects = 0;
    const editTool: AgentTool<JsonValue> = {
      ...emptyTool,
      name: "pending_edit",
      async execute(_input, context) {
        const approved = await context.requestEditApproval?.({
          path: "src/example.ts",
          preview: "safe preview",
        });
        if (approved) editEffects += 1;
        return "edit closed";
      },
    };
    const model: ChatModel = {
      async complete() {
        return {
          kind: "tool_calls",
          content: "Request one edit.",
          toolCalls: [{ id: "pending-edit", name: "pending_edit", input: {} }],
        };
      },
    };
    const agent = new AgentLoop(model, new ToolRegistry([editTool]), {
      workspaceRoot: process.cwd(),
      requestEditApproval: pendingApproval(controller),
      onEvent: (event) => events.push(event),
    });
    await settleWithin(agent.run("Cancel a pending edit.", { signal: controller.signal }));
    assert.equal(editEffects, 0);
    assert.equal(events.at(-1)?.type, "agent_stopped");
  });

  await t.test("repair approval", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const projectCheck = createProjectCheckTool(["nonzero"]);
    let modelCalls = 0;
    const model: ChatModel = {
      async complete(request) {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            kind: "tool_calls",
            content: "Run the failing check.",
            toolCalls: [{ id: "repair-check", name: "run_project_check", input: {} }],
          };
        }
        assert.equal(request.phase, "repair_planning");
        return { kind: "final", content: "Apply one small repair." };
      },
    };
    const agent = new AgentLoop(model, new ToolRegistry([projectCheck.tool]), {
      workspaceRoot: process.cwd(),
      enableFailureRepair: true,
      requestCommandApproval: async () => true,
      requestRepairApproval: pendingApproval(controller),
      onEvent: (event) => events.push(event),
    });
    await settleWithin(agent.run("Cancel a pending repair.", { signal: controller.signal }));
    assert.equal(projectCheck.executionCount, 1);
    assert.equal(modelCalls, 2);
    assert.equal(events.at(-1)?.type, "agent_stopped");
  });
});

test("a passing recheck without a successful patch cannot complete a repair", async () => {
  const projectCheck = createProjectCheckTool(["nonzero", "success"]);
  const failedPatch = createCountingTool("apply_patch", () => {
    throw new ToolExecutionError("patch was not applied");
  });
  let modelCalls = 0;
  const model: ChatModel = {
    async complete(request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          kind: "tool_calls",
          content: "Run the original check.",
          toolCalls: [{ id: "proof-check", name: "run_project_check", input: {} }],
        };
      }
      if (modelCalls === 2) {
        assert.equal(request.phase, "repair_planning");
        return { kind: "final", content: "Apply one patch and rerun the check." };
      }
      if (modelCalls === 3) {
        return {
          kind: "tool_calls",
          content: "Try the patch and then recheck.",
          toolCalls: [
            { id: "proof-patch", name: "apply_patch", input: {} },
            { id: "proof-recheck", name: "run_project_check", input: {} },
          ],
        };
      }
      assert.equal(modelCalls, 4);
      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "The rerun passed but no patch was applied." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([projectCheck.tool, failedPatch.tool]), {
    workspaceRoot: process.cwd(),
    enableFailureRepair: true,
    requestCommandApproval: async () => true,
    requestRepairApproval: async () => true,
  }).run("Require patch and recheck evidence.");

  assert.equal(projectCheck.executionCount, 2);
  assert.equal(failedPatch.executionCount, 1);
  assert.match(result.answer, /^一次有界修复未成功完成/);
  assert.equal(result.events.some((event) => event.type === "agent_completed"), false);
  assert.equal(result.events.at(-1)?.type, "agent_stopped");
});

test("JsonlAuditLog serializes concurrent flushes without duplicates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-audit-flush-"));
  const filePath = path.join(directory, "audit.jsonl");
  try {
    const log = new JsonlAuditLog(filePath);
    const flushes: Promise<void>[] = [];
    for (let step = 1; step <= 20; step += 1) {
      log.record({ type: "model_requested", step });
      flushes.push(log.flush());
    }
    await Promise.all(flushes);
    const records = (await fs.readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 20);
    assert.deepEqual(records.map((record) => record.step), Array.from({ length: 20 }, (_, index) => index + 1));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("edit approval audit is persisted before the callback and never stores preview content", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-edit-audit-"));
  const filePath = path.join(directory, "audit.jsonl");
  const auditLog = new JsonlAuditLog(filePath);
  let modelCalls = 0;
  const editTool: AgentTool<JsonValue> = {
    ...emptyTool,
    name: "edit_for_audit",
    async execute(_input, context) {
      const beforeApproval = await fs.readFile(filePath, "utf8");
      assert.match(beforeApproval, /"type":"tool_execution_started"/);
      const approved = await context.requestEditApproval?.({
        path: "src/example.ts",
        preview: "SECRET PATCH BODY",
      });
      assert.equal(approved, true);
      const afterApproval = await fs.readFile(filePath, "utf8");
      assert.match(afterApproval, /"type":"edit_approval_decision"/);
      return "edit applied";
    },
  };
  const model: ChatModel = {
    async complete() {
      modelCalls += 1;
      return modelCalls === 1
        ? {
            kind: "tool_calls",
            content: "Request one edit.",
            toolCalls: [{ id: "edit-audit-1", name: "edit_for_audit", input: {} }],
          }
        : { kind: "final", content: "Edit audit complete." };
    },
  };

  try {
    await new AgentLoop(model, new ToolRegistry([editTool]), {
      workspaceRoot: process.cwd(),
      auditLog,
      requestEditApproval: async () => {
        const persisted = await fs.readFile(filePath, "utf8");
        assert.match(persisted, /"type":"edit_approval_requested"/);
        return true;
      },
    }).run("Audit an edit approval.");
    const persisted = await fs.readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /SECRET PATCH BODY/);
    const records = persisted.trim().split("\n").map((line) => JSON.parse(line));
    const requested = records.find((record) => record.type === "edit_approval_requested");
    assert.deepEqual(
      { path: requested.path, previewLength: requested.previewLength, preview: requested.preview },
      { path: "src/example.ts", previewLength: "SECRET PATCH BODY".length, preview: undefined },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
