import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { AgentEvent, AgentEventAuditLog } from "../src/agent/events.ts";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { DeepSeekModel, deepSeekDefaults } from "../src/models/deepseek-model.ts";
import { OpenAiCompatibleModel } from "../src/models/openai-compatible-model.ts";
import { createAgent, parseArguments } from "../src/runtime.ts";
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

test("OpenAiCompatibleModel 使用 Profile 提供的地址与模型，不附加 DeepSeek 参数", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const model = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1/",
    model: "local-coder",
    providerName: "Test provider",
    fetchImplementation: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "已确认。" } }] });
    },
  });

  const result = await model.complete(requestFixture());

  assert.deepEqual(result, { kind: "final", content: "已确认。" });
  assert.equal(capturedUrl, "https://example.test/v1/chat/completions");
  const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
  assert.equal(body.model, "local-coder");
  assert.equal("thinking" in body, false);
  assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer test-key");
});

test("DeepSeek 编辑模式向模型提供受控补丁、验证、命令和只读 Git 工具", async () => {
  const auditDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-deepseek-edit-"));
  const auditPath = path.join(auditDirectory, "audit.jsonl");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  let capturedInit: RequestInit | undefined;
  try {
    process.env.DEEPSEEK_API_KEY = "test-key";
    globalThis.fetch = async (_input, init) => {
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "已完成只读分析。" } }] });
    };
    const options = parseArguments([
      "--model", "deepseek",
      "--mode", "edit",
      "--workspace", process.cwd(),
      "--audit", auditPath,
      "检查一个小问题。",
    ]);

    await createAgent(options).run(options.task);

    const body = JSON.parse(capturedInit?.body as string) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ function: { name: string; description: string } }>;
    };
    assert.equal(options.executionMode, "apply");
    assert.deepEqual(
      body.tools.map((tool) => tool.function.name),
      ["get_project_overview", "list_files", "search_text", "read_file", "inspect_git", "apply_patch", "run_project_check", "run_command"],
    );
    assert.match(body.messages[0]?.content ?? "", /必须直接调用 apply_patch/);
    assert.match(body.messages[0]?.content ?? "", /精确输入 RUN/);
    assert.match(body.messages[0]?.content ?? "", /不接受直接 Shell、管道、重定向、Git/);
    assert.match(body.messages[0]?.content ?? "", /Git 只能通过 inspect_git/);
    assert.match(
      body.tools.find((tool) => tool.function.name === "apply_patch")?.function.description ?? "",
      /不要在普通回答中请求 APPLY/,
    );
    assert.match(
      body.tools.find((tool) => tool.function.name === "run_project_check")?.function.description ?? "",
      /本地 RUN 确认/,
    );
    assert.match(
      body.tools.find((tool) => tool.function.name === "run_command")?.function.description ?? "",
      /不用 Shell 拼接模型参数/,
    );
    assert.match(
      body.tools.find((tool) => tool.function.name === "inspect_git")?.function.description ?? "",
      /不开放路径、任意 Git 参数或写操作/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalApiKey;
    }
    await fs.rm(auditDirectory, { recursive: true, force: true });
  }
});

test("DeepSeek 编辑模式保留第七轮，在六次工具后仍可给出最终总结", async () => {
  const auditDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-deepseek-seven-steps-"));
  const auditPath = path.join(auditDirectory, "audit.jsonl");
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.DEEPSEEK_API_KEY;
  const toolCalls = [
    { name: "get_project_overview", input: {} },
    { name: "list_files", input: {} },
    { name: "search_text", input: { query: "class FakeModel", path: "src" } },
    { name: "read_file", input: { path: "src/models/fake-model.ts", startLine: 1, endLine: 5 } },
    { name: "inspect_git", input: { action: "status" } },
    { name: "inspect_git", input: { action: "diff" } },
  ] as const;
  let fetchCalls = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  try {
    process.env.DEEPSEEK_API_KEY = "test-key";
    globalThis.fetch = async (_input, init) => {
      assert.equal(typeof init?.body, "string");
      requestBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      const toolCall = toolCalls[fetchCalls];
      fetchCalls += 1;
      if (!toolCall) {
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "六次工具后完成最终总结。" } }] });
      }
      return jsonResponse({
        choices: [{
          message: {
            role: "assistant",
            content: `调用 ${toolCall.name}`,
            tool_calls: [{
              id: `seven-step-${fetchCalls}`,
              type: "function",
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
            }],
          },
        }],
      });
    };
    const options = parseArguments([
      "--model", "deepseek",
      "--mode", "edit",
      "--workspace", process.cwd(),
      "--audit", auditPath,
      "完成一次六工具编辑闭环。",
    ]);
    const result = await createAgent(options).run(options.task);
    assert.equal(fetchCalls, 7);
    assert.equal(result.answer, "六次工具后完成最终总结。");
    assert.equal(result.events.filter((event) => event.type === "tool_call").length, 6);
    assert.equal(result.events.at(-1)?.type, "agent_completed");
    assert.equal("tools" in requestBodies[6], false);
    assert.equal("tool_choice" in requestBodies[6], false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalApiKey;
    await fs.rm(auditDirectory, { recursive: true, force: true });
  }
});

test("DeepSeekModel 在最终修复轮省略工具定义", async () => {
  let capturedInit: RequestInit | undefined;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async (_input, init) => {
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "已修正。" } }] });
    },
  });
  const request: ModelRequest = { ...requestFixture(), tools: [] };

  await model.complete(request);

  assert.equal(typeof capturedInit?.body, "string");
  const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("DeepSeekModel 将受控阶段的强制工具转换为官方 tool_choice 格式", async () => {
  let capturedInit: RequestInit | undefined;
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async (_input, init) => {
      capturedInit = init;
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "读取完成。" } }] });
    },
  });
  const request: ModelRequest = {
    ...requestFixture(),
    toolChoice: { type: "function", name: "list_files" },
  };

  await model.complete(request);

  const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "list_files" },
  });
});

test("DeepSeekModel 拒绝强制未注册工具", async () => {
  const model = new DeepSeekModel({
    apiKey: "test-key",
    fetchImplementation: async () => jsonResponse({ choices: [] }),
  });
  const request: ModelRequest = {
    ...requestFixture(),
    toolChoice: { type: "function", name: "read_file" },
  };

  await assert.rejects(model.complete(request), /强制工具未在本轮工具列表中注册：read_file/);
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
