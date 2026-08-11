import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentTool, ChatModel, JsonValue, ModelRequest, ModelResponse, ToolExecutionOutput } from "../src/agent/contracts.ts";
import type { AgentEvent, AgentEventAuditLog } from "../src/agent/events.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";

const emptyParameters = { type: "object", properties: {}, additionalProperties: false } as const;

const listFilesTool: AgentTool = {
  name: "list_files",
  description: "List files for a test.",
  parameters: emptyParameters,
  validate(input) {
    return { ok: true, value: input };
  },
  async execute() {
    return "README.md";
  },
};

const sourceReadTool: AgentTool<JsonValue, ToolExecutionOutput> = {
  name: "read_file",
  description: "Return an inspected source range for a test.",
  parameters: emptyParameters,
  validate(input) {
    return { ok: true, value: input };
  },
  async execute() {
    return {
      content: "src/agent/agent-loop.ts:10 | const tool = this.tools.find(toolCall.name);",
      sourceEvidence: [{ path: "src/agent/agent-loop.ts", startLine: 10, endLine: 20 }],
    };
  },
};

test("source-evidence mode asks for a repair when the answer has no read_file evidence", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "I will inspect the documentation index.",
          toolCalls: [{ id: "list-1", name: "list_files", input: {} }],
        };
      }
      if (callCount === 2) {
        return { kind: "final", content: "The explanation is in README.md:1." };
      }
      if (callCount === 3) {
        const repair = request.messages.at(-1);
        assert.equal(repair?.role, "user");
        assert.match(repair?.content ?? "", /尚未成功读取任何源码文件/);
        return {
          kind: "tool_calls",
          content: "I need implementation evidence.",
          toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
        };
      }
      return { kind: "final", content: "代码证据：src/agent/agent-loop.ts:12。" };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([listFilesTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(result.answer, "代码证据：src/agent/agent-loop.ts:12。");
  assert.deepEqual(result.sourceEvidence, [
    { path: "src/agent/agent-loop.ts", startLine: 10, endLine: 20 },
  ]);
  assert.deepEqual(
    result.events.filter((event) => event.type === "final_answer_rejected"),
    [
      {
        type: "final_answer_rejected",
        step: 2,
        reason: "missing_read_file_evidence",
        sourceEvidenceCount: 0,
      },
    ],
  );
});

test("source-evidence mode accepts a citation inside a successfully read source range", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      callCount += 1;
      return callCount === 1
        ? {
            kind: "tool_calls",
            content: "I will read the implementation.",
            toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
          }
        : { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:12." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(result.answer, "The lookup happens at src/agent/agent-loop.ts:12.");
  assert.equal(result.events.some((event) => event.type === "final_answer_rejected"), false);
});

test("source-evidence mode rejects a citation outside the read source range", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "I will read the implementation.",
          toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
        };
      }
      if (callCount === 2) {
        return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:99." };
      }

      const repair = request.messages.at(-1);
      assert.equal(repair?.role, "user");
      assert.match(repair?.content ?? "", /未在本轮已读取范围内/);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:12." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(result.answer, "The lookup happens at src/agent/agent-loop.ts:12.");
  assert.deepEqual(
    result.events.filter((event) => event.type === "final_answer_rejected"),
    [
      {
        type: "final_answer_rejected",
        step: 2,
        reason: "unverified_source_citation",
        sourceEvidenceCount: 1,
      },
    ],
  );
});

test("source-evidence mode stops after a second rejected final answer", async () => {
  const recordedEvents: AgentEvent[] = [];
  const auditLog: AgentEventAuditLog = {
    record(event) {
      recordedEvents.push(event);
    },
    async flush() {},
  };
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      return { kind: "final", content: "I cannot cite source evidence." };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
      workspaceRoot: process.cwd(),
      requireSourceEvidence: true,
      auditLog,
    }).run("Explain the implementation."),
    /最终回答连续两次未通过源码证据校验/,
  );
  assert.deepEqual(
    recordedEvents.map((event) => event.type),
    [
      "model_requested",
      "final_answer_rejected",
      "model_requested",
      "final_answer_rejected",
      "agent_stopped",
    ],
  );
});
