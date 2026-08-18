import type {
  AgentMessage,
  ChatModel,
  JsonValue,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../agent/contracts.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export function validateOpenAiCompatibleBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "baseUrl 必须是有效 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "baseUrl 只允许 http 或 https 协议";
  }
  if (url.hostname === "") {
    return "baseUrl 必须包含 hostname";
  }
  if (url.username !== "" || url.password !== "") {
    return "baseUrl 不允许包含用户名或密码";
  }
  if (url.hash !== "" || value.includes("#")) {
    return "baseUrl 不允许包含 URL 片段";
  }
  if (url.search !== "" || value.includes("?")) {
    return "baseUrl 不允许包含查询参数";
  }
  return undefined;
}

interface ApiFunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type ApiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ApiFunctionToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiCompatibleModelOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  providerName?: string;
  apiKeyEnvironmentVariable?: string;
  disableThinking?: boolean;
  timeoutMs?: number;
  maxTokens?: number;
  maxResponseBytes?: number;
  fetchImplementation?: typeof fetch;
}

class ProviderHttpError extends Error {}
class RequestAbortedError extends Error {}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toApiMessage(message: AgentMessage): ApiMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}

function toApiToolChoice(request: ModelRequest, providerName: string): JsonValue {
  if (!request.toolChoice) return "auto";
  if (!request.tools.some((tool) => tool.name === request.toolChoice?.name)) {
    throw new Error(`${providerName} 强制工具未在本轮工具列表中注册：${request.toolChoice.name}。`);
  }
  return {
    type: "function",
    function: { name: request.toolChoice.name },
  };
}

function parseToolCall(value: unknown, providerName: string): ToolCall {
  const rawToolCall = asObject(value);
  const rawFunction = asObject(rawToolCall?.function);
  if (
    !rawToolCall ||
    rawToolCall.type !== "function" ||
    typeof rawToolCall.id !== "string" ||
    !rawFunction ||
    typeof rawFunction.name !== "string" ||
    typeof rawFunction.arguments !== "string"
  ) {
    throw new Error(`${providerName} 返回了格式无效的工具调用。`);
  }
  const id = rawToolCall.id.trim();
  const name = rawFunction.name.trim();
  if (id === "" || name === "") {
    throw new Error(`${providerName} 返回的工具调用缺少非空 id 或工具名。`);
  }

  let input: JsonValue = rawFunction.arguments;
  try {
    input = JSON.parse(rawFunction.arguments) as JsonValue;
  } catch {
    // 参数保留为字符串，后续由本地工具校验并生成标准错误终态。
  }
  return { id, name, input };
}

function parseResponse(payload: unknown, providerName: string): ModelResponse {
  const response = asObject(payload);
  const choices = response?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`${providerName} 响应缺少 choices。`);
  }
  const choice = asObject(choices[0]);
  const message = asObject(choice?.message);
  if (!message || message.role !== "assistant") {
    throw new Error(`${providerName} 响应缺少 assistant message。`);
  }

  const finishReason = choice?.finish_reason;
  if (typeof finishReason !== "string") {
    throw new Error(`${providerName} 响应缺少 finish_reason。`);
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (finishReason === "stop") {
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      throw new Error(`${providerName} 的 finish_reason=stop 与 tool_calls 不一致。`);
    }
    if (content.trim() === "") {
      throw new Error(`${providerName} 返回了空的最终回答。`);
    }
    return { kind: "final", content };
  }
  if (finishReason === "length") {
    throw new Error(`${providerName} 输出因长度限制被截断，不能作为完整结果。`);
  }
  if (finishReason === "content_filter") {
    throw new Error(`${providerName} 输出被内容过滤，不能作为完整结果。`);
  }
  if (finishReason === "function_call") {
    throw new Error(`${providerName} 返回了不受支持的旧版 function_call。`);
  }
  if (finishReason !== "tool_calls") {
    throw new Error(`${providerName} 返回了未知 finish_reason：${finishReason}。`);
  }
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw new Error(`${providerName} 的 finish_reason=tool_calls 但工具数组为空或无效。`);
  }
  const toolCalls = message.tool_calls.map((toolCall) => parseToolCall(toolCall, providerName));
  const ids = new Set<string>();
  for (const toolCall of toolCalls) {
    if (ids.has(toolCall.id)) {
      throw new Error(`${providerName} 返回了重复的工具调用 id：${toolCall.id}。`);
    }
    ids.add(toolCall.id);
  }
  return {
    kind: "tool_calls",
    content,
    toolCalls,
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RequestAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RequestAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`响应正文超过 ${maximumBytes} 字节上限。`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel();
        throw new Error(`响应正文超过 ${maximumBytes} 字节上限。`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (signal.aborted) void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 超时或取消时可能仍有 pending read；释放失败不能覆盖原始终止原因。
    }
  }
}

/**
 * 只负责 OpenAI Chat Completions 兼容协议的转换；工具权限、参数校验和审计
 * 始终留在本地 AgentLoop 与工具层。
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #endpoint: string;
  readonly #providerName: string;
  readonly #apiKeyEnvironmentVariable: string;
  readonly #disableThinking: boolean;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiCompatibleModelOptions) {
    this.#providerName = options.providerName ?? "OpenAI-compatible provider";
    this.#apiKeyEnvironmentVariable = options.apiKeyEnvironmentVariable ?? "API key";
    if (options.apiKey.trim() === "") {
      throw new Error(`${this.#apiKeyEnvironmentVariable} 不能为空。`);
    }
    if (options.model.trim() === "") {
      throw new Error(`${this.#providerName} 的 model 不能为空。`);
    }
    const baseUrl = options.baseUrl.trim();
    if (baseUrl === "") {
      throw new Error(`${this.#providerName} 的 baseUrl 不能为空。`);
    }
    const baseUrlProblem = validateOpenAiCompatibleBaseUrl(baseUrl);
    if (baseUrlProblem) {
      throw new Error(`${this.#providerName} 的 baseUrl 配置无效：${baseUrlProblem}。`);
    }
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error(`${this.#providerName} 请求超时必须是正整数毫秒数。`);
    }
    if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) {
      throw new Error(`${this.#providerName} 最大输出 token 数必须是正整数。`);
    }
    if (
      options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)
    ) {
      throw new Error(`${this.#providerName} 响应正文上限必须是正安全整数。`);
    }

    this.#apiKey = options.apiKey;
    this.#model = options.model;
    const endpoint = new URL(baseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/chat/completions`;
    this.#endpoint = endpoint.toString();
    this.#disableThinking = options.disableThinking ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    let phase: "fetch" | "body" | "parse" = "fetch";
    try {
      const response = await abortable(this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify({
          model: this.#model,
          messages: request.messages.map(toApiMessage),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
                tool_choice: toApiToolChoice(request, this.#providerName),
              }
            : {}),
          ...(this.#disableThinking ? { thinking: { type: "disabled" } } : {}),
          max_tokens: this.#maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        throw new ProviderHttpError(`${this.#providerName} 请求失败：HTTP ${response.status}。`);
      }
      phase = "body";
      const body = await readResponseBody(response, this.#maxResponseBytes, controller.signal);
      phase = "parse";
      let payload: unknown;
      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`JSON 无效：${message}`);
      }
      return parseResponse(payload, this.#providerName);
    } catch (error) {
      if (signal?.aborted) {
        throw new Error(`${this.#providerName} 请求已取消。`);
      }
      if (timedOut) {
        throw new Error(`${this.#providerName} 请求超时（${this.#timeoutMs}ms）。`);
      }
      if (error instanceof ProviderHttpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (phase === "fetch") {
        throw new Error(`${this.#providerName} 网络请求失败：${message}`);
      }
      throw new Error(`${this.#providerName} 响应解析失败：${message}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export const openAiCompatibleDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: DEFAULT_MAX_TOKENS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
} as const;
