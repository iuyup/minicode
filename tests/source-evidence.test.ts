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

const sourceSearchTool: AgentTool = {
  name: "search_text",
  description: "Search source code for a test.",
  parameters: emptyParameters,
  validate(input) {
    return { ok: true, value: input };
  },
  async execute() {
    return "src/agent/agent-loop.ts:10: candidate implementation";
  },
};

const sourceReadTool: AgentTool<JsonValue, ToolExecutionOutput> = {
  name: "read_file",
  description: "Return an inspected source range for a test.",
  parameters: emptyParameters,
  validate(input) {
    return { ok: true, value: input };
  },
  async execute(_input, context) {
    assert.equal(context.requireSourceEvidence, true);
    return {
      content: "src/agent/agent-loop.ts:10 | const tool = this.tools.find(toolCall.name);",
      sourceEvidence: [{ path: "src/agent/agent-loop.ts", startLine: 10, endLine: 20 }],
    };
  },
};

test("source-evidence mode stops an answer without read_file evidence", async () => {
  const recordedEvents: AgentEvent[] = [];
  const auditLog: AgentEventAuditLog = {
    record(event) {
      recordedEvents.push(event);
    },
    async flush() {},
  };
  const model: ChatModel = {
    async complete(): Promise<ModelResponse> {
      return { kind: "final", content: "The explanation is in README.md:1." };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([listFilesTool, sourceReadTool]), {
      workspaceRoot: process.cwd(),
      requireSourceEvidence: true,
      auditLog,
    }).run("Explain the implementation."),
    /最终回答缺少已读取源码，无法进行无工具修复/,
  );
  assert.deepEqual(
    recordedEvents.filter((event) => event.type === "final_answer_rejected"),
    [
      {
        type: "final_answer_rejected",
        step: 1,
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

test("source-evidence mode accepts a fully verified source range citation", async () => {
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
        : { kind: "final", content: "The lookup is implemented in src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(result.events.some((event) => event.type === "final_answer_rejected"), false);
});

test("source-evidence mode allows one supplemental search-read pair then forces a final answer", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1 || callCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["search_text", "read_file"]);
        return {
          kind: "tool_calls",
          content: callCount === 1 ? "Search first." : "Read the first source range.",
          toolCalls: [
            callCount === 1
              ? { id: "search-1", name: "search_text", input: {} }
              : { id: "read-2", name: "read_file", input: {} },
          ],
        };
      }
      if (callCount === 3) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["search_text", "read_file"]);
        return {
          kind: "tool_calls",
          content: "Search for the handler.",
          toolCalls: [{ id: "search-3", name: "search_text", input: {} }],
        };
      }
      if (callCount === 4) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["read_file"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "read_file" });
        return {
          kind: "tool_calls",
          content: "Read the handler.",
          toolCalls: [{ id: "read-4", name: "read_file", input: {} }],
        };
      }

      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceSearchTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(callCount, 5);
  assert.deepEqual(
    result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
    ["search_text", "read_file", "search_text", "read_file"],
  );
  assert.deepEqual(result.events.at(-1), { type: "agent_completed", step: 5 });
});

test("source-evidence mode forces read_file after two initial searches", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount <= 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["search_text", "read_file"]);
        assert.equal(request.toolChoice, undefined);
        return {
          kind: "tool_calls",
          content: "Continue locating the implementation.",
          toolCalls: [{ id: `search-${callCount}`, name: "search_text", input: {} }],
        };
      }
      if (callCount === 3) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["read_file"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "read_file" });
        return {
          kind: "tool_calls",
          content: "Read the selected implementation.",
          toolCalls: [{ id: "read-3", name: "read_file", input: {} }],
        };
      }

      assert.deepEqual(request.tools.map((tool) => tool.name), ["search_text", "read_file"]);
      assert.equal(request.toolChoice, undefined);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceSearchTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(callCount, 4);
  assert.deepEqual(
    result.events.find((event) => event.type === "model_requested" && event.step === 3),
    { type: "model_requested", step: 3, forcedToolName: "read_file" },
  );
  assert.deepEqual(
    result.events.filter((event) => event.type === "tool_finalized").map((event) => event.status),
    ["success", "success", "success"],
  );
});

test("source-evidence mode rejects a second supplemental search request", async () => {
  let searchExecutions = 0;
  const trackingSearchTool: AgentTool = {
    ...sourceSearchTool,
    async execute() {
      searchExecutions += 1;
      return "unexpected search execution";
    },
  };
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "Read source.",
          toolCalls: [{ id: "read-1", name: "read_file", input: {} }],
        };
      }
      if (callCount === 2) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["search_text", "read_file"]);
        return {
          kind: "tool_calls",
          content: "Search for the handler.",
          toolCalls: [{ id: "search-2", name: "search_text", input: {} }],
        };
      }
      if (callCount === 3) {
        assert.deepEqual(request.tools.map((tool) => tool.name), ["read_file"]);
        assert.deepEqual(request.toolChoice, { type: "function", name: "read_file" });
        return {
          kind: "tool_calls",
          content: "Try a second supplemental search.",
          toolCalls: [{ id: "search-3", name: "search_text", input: {} }],
        };
      }

      const rejected = request.messages.at(-1);
      assert.equal(rejected?.role, "tool");
      assert.equal(rejected?.status, "error");
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([trackingSearchTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(searchExecutions, 1);
  assert.deepEqual(
    result.events.find((event) => event.type === "tool_finalized" && event.toolCallId === "search-3"),
    {
      type: "tool_finalized",
      step: 3,
      toolCallId: "search-3",
      toolName: "search_text",
      status: "error",
      detail: "源码取证状态不允许该工具；请按当前阶段继续定位、读取或给出最终回答。",
    },
  );
});

test("source-evidence mode grants one final-only turn when the last normal step reads source", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount <= 5) {
        return {
          kind: "tool_calls",
          content: "Keep searching.",
          toolCalls: [{ id: `search-${callCount}`, name: "search_text", input: {} }],
        };
      }
      if (callCount === 6) {
        return {
          kind: "tool_calls",
          content: "Read the source at the last normal step.",
          toolCalls: [{ id: "read-6", name: "read_file", input: {} }],
        };
      }

      assert.deepEqual(request.tools, []);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceSearchTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 6,
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(callCount, 7);
  assert.deepEqual(result.events.at(-1), { type: "agent_completed", step: 7 });
});

test("source-evidence completion turn stops before executing a requested tool", async () => {
  const recordedEvents: AgentEvent[] = [];
  const auditLog: AgentEventAuditLog = {
    record(event) {
      recordedEvents.push(event);
    },
    async flush() {},
  };
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount <= 2) {
        return {
          kind: "tool_calls",
          content: "Read source.",
          toolCalls: [{ id: `read-${callCount}`, name: "read_file", input: {} }],
        };
      }

      assert.deepEqual(request.tools, []);
      return {
        kind: "tool_calls",
        content: "Try another read.",
        toolCalls: [{ id: "read-3", name: "read_file", input: {} }],
      };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
      workspaceRoot: process.cwd(),
      requireSourceEvidence: true,
      auditLog,
    }).run("Explain the implementation."),
    /源码取证已收集足够证据，本轮只能给出最终回答/,
  );
  assert.equal(recordedEvents.filter((event) => event.type === "tool_call").length, 3);
  assert.ok(recordedEvents.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "read-3" &&
      event.status === "error" &&
      /只能给出最终回答/.test(event.detail),
  ));
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
        return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:12-21." };
      }

      const repair = request.messages.at(-1);
      assert.equal(repair?.role, "user");
      assert.match(repair?.content ?? "", /未在本轮已读取范围内/);
      assert.match(repair?.content ?? "", /`src\/agent\/agent-loop\.ts:10-20`/);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:10-20." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(result.answer, "The lookup happens at src/agent/agent-loop.ts:10-20.");
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
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "Read the implementation.",
          toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
        };
      }
      if (callCount === 3) {
        assert.deepEqual(request.tools, []);
      }
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:99." };
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
      "tool_call",
      "tool_execution_started",
      "tool_finalized",
      "model_requested",
      "final_answer_rejected",
      "model_requested",
      "final_answer_rejected",
      "agent_stopped",
    ],
  );
});

test("source-evidence mode grants one final-only repair turn after a last-step rejection", async () => {
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "Read the implementation first.",
          toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
        };
      }
      if (callCount <= 5) {
        return {
          kind: "tool_calls",
          content: "Inspect another directory.",
          toolCalls: [{ id: `list-${callCount}`, name: "list_files", input: {} }],
        };
      }
      if (callCount === 6) {
        return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:99." };
      }

      assert.deepEqual(request.tools, []);
      const repair = request.messages.at(-1);
      assert.equal(repair?.role, "user");
      assert.match(repair?.content ?? "", /未在本轮已读取范围内/);
      return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:12." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([listFilesTool, sourceReadTool]), {
    workspaceRoot: process.cwd(),
    maxSteps: 6,
    requireSourceEvidence: true,
  }).run("Explain the implementation.");

  assert.equal(callCount, 7);
  assert.equal(result.answer, "The lookup happens at src/agent/agent-loop.ts:12.");
  assert.deepEqual(
    result.events.filter((event) => event.type === "final_answer_rejected"),
    [
      {
        type: "final_answer_rejected",
        step: 6,
        reason: "unverified_source_citation",
        sourceEvidenceCount: 1,
      },
    ],
  );
  assert.deepEqual(result.events.at(-1), { type: "agent_completed", step: 7 });
});

test("source-evidence repair turn stops before executing a requested tool", async () => {
  const recordedEvents: AgentEvent[] = [];
  const auditLog: AgentEventAuditLog = {
    record(event) {
      recordedEvents.push(event);
    },
    async flush() {},
  };
  let callCount = 0;
  const model: ChatModel = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      callCount += 1;
      if (callCount === 1) {
        return {
          kind: "tool_calls",
          content: "Read the implementation.",
          toolCalls: [{ id: "read-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
        };
      }
      if (callCount === 2) {
        return { kind: "final", content: "The lookup happens at src/agent/agent-loop.ts:99." };
      }

      assert.deepEqual(request.tools, []);
      return {
        kind: "tool_calls",
        content: "Try another read.",
        toolCalls: [{ id: "read-2", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
      };
    },
  };

  await assert.rejects(
    new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
      workspaceRoot: process.cwd(),
      requireSourceEvidence: true,
      auditLog,
    }).run("Explain the implementation."),
    /源码证据修复轮只能给出最终回答/,
  );
  assert.equal(recordedEvents.filter((event) => event.type === "tool_call").length, 2);
  assert.ok(recordedEvents.some(
    (event) => event.type === "tool_finalized" &&
      event.toolCallId === "read-2" &&
      event.status === "error" &&
      /只能给出最终回答/.test(event.detail),
  ));
  assert.deepEqual(recordedEvents.at(-1), {
    type: "agent_stopped",
    step: 3,
    reason: "源码证据修复轮只能给出最终回答，不能请求工具。",
  });
});

test("source-evidence mode accepts an actual Unicode path with spaces and a non-TypeScript extension", async () => {
  const evidencePath = "src/解析 器.py";
  const unicodeReadTool: AgentTool<JsonValue, ToolExecutionOutput> = {
    ...sourceReadTool,
    async execute() {
      return {
        content: `${evidencePath}:3 | def parse():`,
        sourceEvidence: [{ path: evidencePath, startLine: 3, endLine: 8 }],
      };
    },
  };
  let calls = 0;
  const model: ChatModel = {
    async complete() {
      calls += 1;
      return calls === 1
        ? {
            kind: "tool_calls",
            content: "Read the implementation.",
            toolCalls: [{ id: "unicode-read", name: "read_file", input: {} }],
          }
        : { kind: "final", content: `The parser is defined at \`${evidencePath}:3-8\`.` };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([unicodeReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Explain the parser.");

  assert.equal(result.answer, `The parser is defined at \`${evidencePath}:3-8\`.`);
  assert.equal(result.events.some((event) => event.type === "final_answer_rejected"), false);
});

test("source-evidence mode rejects an unknown citation mixed with a valid read citation", async () => {
  let calls = 0;
  const model: ChatModel = {
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "tool_calls",
          content: "Read the verified source.",
          toolCalls: [{ id: "mixed-read", name: "read_file", input: {} }],
        };
      }
      if (calls === 2) {
        return {
          kind: "final",
          content: "Verified at src/agent/agent-loop.ts:12, with another claim at src/evil.py:1.",
        };
      }
      assert.deepEqual(request.tools, []);
      assert.match(request.messages.at(-1)?.content ?? "", /未在本轮已读取范围内/);
      return { kind: "final", content: "Verified only at src/agent/agent-loop.ts:12." };
    },
  };

  const result = await new AgentLoop(model, new ToolRegistry([sourceReadTool]), {
    workspaceRoot: process.cwd(),
    requireSourceEvidence: true,
  }).run("Reject mixed source claims.");

  assert.equal(result.answer, "Verified only at src/agent/agent-loop.ts:12.");
  assert.deepEqual(
    result.events.filter((event) => event.type === "final_answer_rejected"),
    [{
      type: "final_answer_rejected",
      step: 2,
      reason: "unverified_source_citation",
      sourceEvidenceCount: 1,
    }],
  );
});
