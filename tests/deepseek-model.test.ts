import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentEvent, AgentEventAuditLog } from "../src/agent/events.ts";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { DeepSeekModel, deepSeekDefaults } from "../src/models/deepseek-model.ts";
import { getProjectOverview } from "../src/tools/get-project-overview.ts";

function requestFixture(): ModelRequest {
  return {
    messages: [
      { role: "system", content: "系统提示。" },
      { role: "user", content: "检查项目。" },
      {
        role: "assistant",
        content: "我会先列出目录。",
        toolCalls: [{ id: "prior-1", name: "list_files", input: { path: "src" } }],
      },
      {
        role: "tool",
        toolCallId: "prior-1",
        name: "list_files",
        status: "success",
        content: "目录：src",
      },
    ],
    tools: [
      {
        name: "list_files",
        description: "列出目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    workingState: "任务账本摘要。",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("DeepSeekModel 发送 OpenAI 兼容请求，并显式关闭思考模式", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "已确认。" } }] });
    },
  });

  const result = await model.complete(requestFixture());

  assert.deepEqual(result, { kind: "final", content: "已确认。" });
  assert.equal(capturedUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer test-key");
  assert.equal(typeof capturedInit?.body, "string");
  const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
  assert.equal(body.model, deepSeekDefaults.model);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "列出目录。",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
  ]);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[2].tool_calls, [
    {
      id: "prior-1",
      type: "function",
      function: { name: "list_files", arguments: "{\"path\":\"src\"}" },
    },
  ]);
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "prior-1", content: "目录：src" });
});

test("DeepSeekModel 将工具调用映射回内部 ToolCall，并保留无效 JSON 供本地校验", async () => {
  const responses = [
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "先读取文件。",
            tool_calls: [
              {
                id: "deepseek-1",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":\"src/agent/agent-loop.ts\"}" },
              },
            ],
          },
        },
      ],
    }),
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "参数格式异常。",
            tool_calls: [
              {
                id: "deepseek-2",
                type: "function",
                function: { name: "get_project_overview", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    }),
  ];
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async () => responses.shift() ?? jsonResponse({ choices: [] }),
  });

  const valid = await model.complete(requestFixture());
  const malformed = await model.complete(requestFixture());

  assert.deepEqual(valid, {
    kind: "tool_calls",
    content: "先读取文件。",
    toolCalls: [{ id: "deepseek-1", name: "read_file", input: { path: "src/agent/agent-loop.ts" } }],
  });
  assert.deepEqual(malformed, {
    kind: "tool_calls",
    content: "参数格式异常。",
    toolCalls: [{ id: "deepseek-2", name: "get_project_overview", input: "not-json" }],
  });
});

test("DeepSeek 的无效工具参数会经过本地校验并获得错误终态", async () => {
  const responses = [
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "调用概览工具。",
            tool_calls: [
              {
                id: "invalid-argument-1",
                type: "function",
                function: { name: "get_project_overview", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    }),
    jsonResponse({ choices: [{ message: { role: "assistant", content: "已收到工具错误。" } }] }),
  ];
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async () => responses.shift() ?? jsonResponse({ choices: [] }),
  });

  const result = await new AgentLoop(model, new ToolRegistry([getProjectOverview]), {
    workspaceRoot: process.cwd(),
  }).run("检查项目概览。");

  const toolResult = result.messages.find((message) => message.role === "tool");
  assert.equal(toolResult?.status, "error");
  assert.match(toolResult?.content ?? "", /get_project_overview accepts an empty object only/);
  assert.equal(
    result.events.find((event) => event.type === "tool_finalized")?.type,
    "tool_finalized",
  );
});

test("DeepSeek HTTP 失败不会暴露响应正文，AgentLoop 会记录模型停止事件", async () => {
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async () => jsonResponse({ error: { message: "sensitive provider detail" } }, 429),
  });
  await assert.rejects(model.complete(requestFixture()), /DeepSeek 请求失败：HTTP 429/);

  const events: AgentEvent[] = [];
  const auditLog: AgentEventAuditLog = {
    record(event) {
      events.push(event);
    },
    async flush() {},
  };
  const failingModel: ChatModel = {
    async complete(): Promise<ModelResponse> {
      throw new Error("provider unavailable");
    },
  };
  await assert.rejects(
    new AgentLoop(failingModel, new ToolRegistry([getProjectOverview]), {
      workspaceRoot: process.cwd(),
      auditLog,
    }).run("触发模型错误。"),
    /模型请求失败：provider unavailable/,
  );
  assert.deepEqual(events.map((event) => event.type), ["model_requested", "agent_stopped"]);
});

test("DeepSeekModel 拒绝空 API Key", () => {
  assert.throws(() => new DeepSeekModel({ apiKey: "  " }), /DEEPSEEK_API_KEY 不能为空/);
});
