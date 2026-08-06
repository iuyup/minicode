import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentTool, ChatModel, JsonValue, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";

const emptyTool: AgentTool<JsonValue> = {
  name: "inspect",
  description: "Return a fixed fact for a test.",
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
        assert.match(request.workingState, /none yet/);
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
      return { kind: "final", content: "Used confirmed-fact." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([emptyTool])).run("Inspect the project.");

  assert.equal(result.answer, "Used confirmed-fact.");
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
      return { kind: "final", content: "I received the tool error." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([emptyTool])).run("Use a missing tool.");
  const finalized = result.events.find((event) => event.type === "tool_finalized");

  assert.deepEqual(finalized, {
    type: "tool_finalized",
    step: 1,
    toolCallId: "missing-1",
    toolName: "missing_tool",
    status: "error",
    detail: "Unknown tool: missing_tool",
  });
});
