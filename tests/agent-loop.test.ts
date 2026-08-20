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
  type ToolExecutionResult,
} from "../src/agent/contracts.ts";
import { JsonlAuditLog, type AgentEvent } from "../src/agent/events.ts";
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
    getCommandApprovalRequest() {
      return {
        kind: "verification",
        action: "test",
        command: "npm test",
        workingDirectory: process.cwd(),
        riskLevel: "medium",
        risk: "Scripted test command.",
      };
    },
    async execute() {
      const outcome = outcomes[executionCount];
      executionCount += 1;
      if (!outcome) {
        throw new Error(`Missing scripted project-check outcome ${executionCount}.`);
      }
      if (outcome === "nonzero") {
        throw new ToolExecutionError("scripted check failed", {
          action: "test",
          exitCode: 1,
          timedOut: false,
        });
      }
      if (outcome === "timeout") {
        throw new ToolExecutionError("scripted check timed out", {
          action: "test",
          exitCode: null,
          timedOut: true,
        });
      }
      if (outcome === "start_failure") {
        throw new ToolExecutionError("scripted check could not start", { action: "test" });
      }
      return {
        content: "scripted check passed",
        metadata: { action: "test", exitCode: 0, timedOut: false },
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
        return {
          kind: "tool_calls",
          content: "Rerun the fixed check.",
          toolCalls: [{ id: "budget-recheck", name: "run_project_check", input: {} }],
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
