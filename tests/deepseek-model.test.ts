import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop, type AgentRunResult } from "../src/agent/agent-loop.ts";
import type { AgentEvent, AgentEventAuditLog } from "../src/agent/events.ts";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { DeepSeekModel, deepSeekDefaults } from "../src/models/deepseek-model.ts";
import {
  OpenAiCompatibleModel,
  openAiCompatibleDefaults,
  type ModelCallMetric,
} from "../src/models/openai-compatible-model.ts";
import { createAgent, defaultAuditPath, parseArguments, printRunResult } from "../src/runtime.ts";
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
  const normalized = asCompletionPayload(payload);
  return new Response(JSON.stringify(normalized), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function asCompletionPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("choices" in payload)) return payload;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return payload;
  return {
    ...payload,
    choices: choices.map((choice) => {
      if (typeof choice !== "object" || choice === null || "finish_reason" in choice) return choice;
      const message = "message" in choice && typeof choice.message === "object" && choice.message !== null
        ? choice.message as { tool_calls?: unknown }
        : undefined;
      return {
        ...choice,
        finish_reason: Array.isArray(message?.tool_calls) ? "tool_calls" : "stop",
      };
    }),
  };
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
  assert.equal(capturedInit?.redirect, "error");
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

test("OpenAiCompatibleModel 以白名单遥测报告 provider usage 与端到端延迟", async () => {
  const metrics: ModelCallMetric[] = [];
  const model = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "local-coder",
    providerName: "Test provider",
    onCallMetric: (metric) => metrics.push(metric),
    fetchImplementation: async () => jsonResponse({
      choices: [{ message: { role: "assistant", content: "完成。" } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 18,
        total_tokens: 138,
        prompt_tokens_details: { cached_tokens: 7 },
      },
    }),
  });

  assert.deepEqual(await model.complete(requestFixture()), { kind: "final", content: "完成。" });
  assert.equal(metrics.length, 1);
  assert.deepEqual({
    callIndex: metrics[0]?.callIndex,
    phase: metrics[0]?.phase,
    outcome: metrics[0]?.outcome,
    errorCategory: metrics[0]?.errorCategory,
    httpStatus: metrics[0]?.httpStatus,
    finishReason: metrics[0]?.finishReason,
    responseKind: metrics[0]?.responseKind,
    usageSource: metrics[0]?.usageSource,
    inputTokens: metrics[0]?.inputTokens,
    cachedInputTokens: metrics[0]?.cachedInputTokens,
    outputTokens: metrics[0]?.outputTokens,
    totalTokens: metrics[0]?.totalTokens,
    ttftMs: metrics[0]?.ttftMs,
  }, {
    callIndex: 1,
    phase: "execution",
    outcome: "success",
    errorCategory: null,
    httpStatus: null,
    finishReason: "stop",
    responseKind: "final",
    usageSource: "provider",
    inputTokens: 120,
    cachedInputTokens: 7,
    outputTokens: 18,
    totalTokens: 138,
    ttftMs: null,
  });
  assert.equal(typeof metrics[0]?.startedAt, "string");
  assert.ok((metrics[0]?.latencyMs ?? -1) >= 0);
});

test("OpenAiCompatibleModel 将 HTTP 失败映射为有限分类且不记录响应正文", async () => {
  const cases = [
    { status: 400, category: "request" },
    { status: 401, category: "auth" },
    { status: 402, category: "payment" },
    { status: 429, category: "rate_limit" },
    { status: 503, category: "provider" },
  ] as const;
  for (const { status, category } of cases) {
    const secret = `must-not-enter-telemetry-${status}`;
    const metrics: ModelCallMetric[] = [];
    const model = new OpenAiCompatibleModel({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "local-coder",
      providerName: "Test provider",
      onCallMetric: (metric) => metrics.push(metric),
      fetchImplementation: async () => jsonResponse({ error: { message: secret } }, status),
    });

    await assert.rejects(model.complete(requestFixture()), new RegExp(`HTTP ${status}`, "u"));
    assert.equal(metrics.length, 1);
    assert.deepEqual({
      outcome: metrics[0]?.outcome,
      errorCategory: metrics[0]?.errorCategory,
      httpStatus: metrics[0]?.httpStatus,
      responseKind: metrics[0]?.responseKind,
      usageSource: metrics[0]?.usageSource,
      inputTokens: metrics[0]?.inputTokens,
      outputTokens: metrics[0]?.outputTokens,
    }, {
      outcome: "error",
      errorCategory: category,
      httpStatus: status,
      responseKind: null,
      usageSource: "unavailable",
      inputTokens: null,
      outputTokens: null,
    });
    const serialized = JSON.stringify(metrics);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("example.test"), false);
    assert.equal(serialized.includes("test-key"), false);
  }
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

test("OpenAiCompatibleModel 构造器本身也拒绝不安全的 baseUrl", () => {
  const create = (baseUrl: string, allowInsecureHttp = false) => new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl,
    model: "test-model",
    providerName: "Test provider",
    allowInsecureHttp,
  });
  assert.throws(() => create("file:///tmp/v1"), /http 或 https/);
  assert.throws(() => create("https://user:secret@example.test/v1"), /用户名或密码/);
  assert.throws(() => create("https://example.test/v1?"), /查询参数/);
  assert.throws(() => create("https://example.test/v1#"), /URL 片段/);
  assert.throws(() => create("http://gateway.example/v1"), /非本机 HTTP/);
  assert.doesNotThrow(() => create("http://localhost:8080/v1"));
  assert.doesNotThrow(() => create("http://127.0.0.1:8080/v1"));
  assert.doesNotThrow(() => create("http://[::1]:8080/v1"));
  assert.doesNotThrow(() => create("http://gateway.example/v1", true));
});

test("OpenAiCompatibleModel 严格校验 finish_reason、最终文本和工具调用标识", async () => {
  const payloads: Array<{ payload: unknown; expected: RegExp }> = [
    {
      payload: { choices: [{ message: { role: "assistant", content: "未标记终态" } }] },
      expected: /缺少 finish_reason/,
    },
    {
      payload: { choices: [{ finish_reason: "length", message: { role: "assistant", content: "被截断" } }] },
      expected: /长度限制被截断/,
    },
    {
      payload: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "   " } }] },
      expected: /空的最终回答/,
    },
    {
      payload: { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [] } }] },
      expected: /工具数组为空或无效/,
    },
    {
      payload: {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: " ", type: "function", function: { name: "read_file", arguments: "{}" } }],
          },
        }],
      },
      expected: /缺少非空 id 或工具名/,
    },
    {
      payload: {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "same", type: "function", function: { name: "read_file", arguments: "{}" } },
              { id: "same", type: "function", function: { name: "list_files", arguments: "{}" } },
            ],
          },
        }],
      },
      expected: /重复的工具调用 id：same/,
    },
  ];

  for (const { payload, expected } of payloads) {
    const model = new OpenAiCompatibleModel({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "test-model",
      providerName: "Test provider",
      fetchImplementation: async () => new Response(JSON.stringify(payload)),
    });
    await assert.rejects(model.complete(requestFixture()), expected);
  }
});

test("OpenAiCompatibleModel 将网络错误分类且不把原始异常写入遥测", async () => {
  const metrics: ModelCallMetric[] = [];
  const model = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    providerName: "Test provider",
    onCallMetric: (metric) => metrics.push(metric),
    fetchImplementation: async () => {
      throw new Error("private-network-diagnostic");
    },
  });

  await assert.rejects(model.complete(requestFixture()), /网络请求失败/u);
  assert.equal(metrics[0]?.errorCategory, "network");
  assert.equal(metrics[0]?.httpStatus, null);
  assert.equal(JSON.stringify(metrics).includes("private-network-diagnostic"), false);
});

test("OpenAiCompatibleModel 超时覆盖响应正文读取且不会被 pending reader 掩盖", async () => {
  const metrics: ModelCallMetric[] = [];
  const model = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    providerName: "Test provider",
    timeoutMs: 20,
    onCallMetric: (metric) => metrics.push(metric),
    fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
    })),
  });

  await assert.rejects(model.complete(requestFixture()), /请求超时（20ms）/);
  assert.equal(metrics[0]?.errorCategory, "timeout");
  assert.equal(metrics[0]?.httpStatus, null);
});

test("OpenAiCompatibleModel 限制响应体并传播外部取消", async () => {
  const oversized = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    providerName: "Test provider",
    maxResponseBytes: 32,
    fetchImplementation: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x".repeat(100) } }],
    })),
  });
  await assert.rejects(oversized.complete(requestFixture()), /响应正文超过 32 字节上限/);

  const controller = new AbortController();
  const captured: { signal?: AbortSignal } = {};
  const cancellationMetrics: ModelCallMetric[] = [];
  const cancellable = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    providerName: "Test provider",
    onCallMetric: (metric) => cancellationMetrics.push(metric),
    fetchImplementation: async (_input, init) => {
      captured.signal = init?.signal as AbortSignal;
      return await new Promise<Response>(() => {});
    },
  });
  const pending = cancellable.complete(requestFixture(), controller.signal);
  controller.abort();
  await assert.rejects(pending, /请求已取消/);
  assert.equal(captured.signal?.aborted, true);
  assert.equal(cancellationMetrics[0]?.errorCategory, "cancelled");
  assert.equal(cancellationMetrics[0]?.httpStatus, null);
  assert.equal(openAiCompatibleDefaults.maxResponseBytes, 1_048_576);
});

test("OpenAiCompatibleModel 拒绝响应正文中的非法 UTF-8", async () => {
  const invalidResponse = Buffer.concat([
    Buffer.from('{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}}]}', "utf8"),
  ]);
  const metrics: ModelCallMetric[] = [];
  const model = new OpenAiCompatibleModel({
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    providerName: "Test provider",
    onCallMetric: (metric) => metrics.push(metric),
    fetchImplementation: async () => new Response(invalidResponse),
  });

  await assert.rejects(model.complete(requestFixture()), /响应解析失败/);
  assert.equal(metrics[0]?.errorCategory, "response_validation");
  assert.equal(metrics[0]?.httpStatus, null);
  assert.equal(JSON.stringify(metrics).includes("choices"), false);
});

test("非 TUI 运行结果会转义模型、工具和路径中的终端控制序列", () => {
  const csi = "\u001B[2J";
  const osc = "\u001B]2;PWN\u0007";
  const result: AgentRunResult = {
    answer: `answer ${osc}`,
    messages: [],
    events: [{ type: "tool_call", step: 1, toolCallId: "unsafe", toolName: `read_file${csi}` }],
    workingState: `state ${csi}`,
    sourceEvidence: [{ path: `src/${osc}.ts`, startLine: 1, endLine: 1 }],
  };
  const options = parseArguments(["--require-source-evidence", "检查输出"]);
  options.auditPath = `C:\\audit${osc}.jsonl`;
  let output = "";
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    output += `${values.map(String).join(" ")}\n`;
  };
  try {
    printRunResult(result, options);
  } finally {
    console.log = originalLog;
  }

  assert.doesNotMatch(output, /\u001B\[2J|\u001B\]2;PWN\u0007/u);
  assert.match(output, /\\u001B\[2J/u);
  assert.match(output, /\\u001B\]2;PWN\\u0007/u);
});

test("parseArguments 不吞缺值选项，拒绝未知选项并支持显式任务分隔符", () => {
  assert.throws(() => parseArguments(["--workspace", "--guided"]), /--workspace 后必须提供一个值/);
  assert.throws(() => parseArguments(["--unknown"]), /未知选项：--unknown/);
  const parsed = parseArguments(["--guided", "--", "--looks-like-an-option", "继续任务"]);
  assert.equal(parsed.guided, true);
  assert.equal(parsed.task, "--looks-like-an-option 继续任务");
});

test("默认审计路径位于用户级目录并具有会话唯一文件名", () => {
  const auditPath = defaultAuditPath();
  const expectedRoot = process.platform === "win32" && process.env.LOCALAPPDATA?.trim()
    ? path.join(process.env.LOCALAPPDATA, "MiniCode", "audit")
    : path.join(os.homedir(), ".minicode", "audit");
  assert.equal(path.dirname(auditPath), expectedRoot);
  assert.match(path.basename(auditPath), /^session-.+\.jsonl$/);
});
