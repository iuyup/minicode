import type {
  AgentMessage,
  JsonValue,
  ModelTextDeltaObserver,
  ModelRequest,
  ModelResponse,
  StreamingChatModel,
  ToolCall,
} from "../agent/contracts.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export interface OpenAiCompatibleTransportPolicy {
  allowInsecureHttp?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateOpenAiCompatibleBaseUrl(
  value: string,
  policy: OpenAiCompatibleTransportPolicy = {},
): string | undefined {
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
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname) && policy.allowInsecureHttp !== true) {
    return "baseUrl 的非本机 HTTP 连接默认禁用；请使用 HTTPS，或显式设置 MINICODE_ALLOW_INSECURE_HTTP=1";
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
  allowInsecureHttp?: boolean;
  fetchImplementation?: typeof fetch;
  onCallMetric?: (metric: ModelCallMetric) => void;
}

export const MODEL_ERROR_CATEGORIES = [
  "auth",
  "payment",
  "rate_limit",
  "request",
  "provider",
  "network",
  "timeout",
  "cancelled",
  "response_validation",
  "unknown",
] as const;

export type ModelErrorCategory = typeof MODEL_ERROR_CATEGORIES[number];

export interface ModelCallMetric {
  callIndex: number;
  phase: "planning" | "repair_planning" | "execution";
  startedAt: string;
  latencyMs: number;
  outcome: "success" | "error";
  /** A bounded, content-free failure class. Successful calls always use null. */
  errorCategory: ModelErrorCategory | null;
  /** Numeric provider status only; response body, headers and URL are never telemetry. */
  httpStatus: number | null;
  finishReason: string | null;
  responseKind: ModelResponse["kind"] | null;
  usageSource: "provider" | "unavailable";
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  ttftMs: number | null;
}

class ProviderHttpError extends Error {
  readonly status: number;

  constructor(providerName: string, status: number) {
    super(`${providerName} 请求失败：HTTP ${status}。`);
    this.status = status;
  }
}
class RequestAbortedError extends Error {}

function categoryForHttpStatus(status: number): ModelErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "payment";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "request";
  if (status >= 500 && status < 600) return "provider";
  return "unknown";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function providerUsage(payload: unknown): Pick<
  ModelCallMetric,
  "usageSource" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens"
> {
  const usage = asObject(asObject(payload)?.usage);
  if (!usage) {
    return {
      usageSource: "unavailable",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
    };
  }
  const inputTokens = nonNegativeInteger(usage.prompt_tokens);
  const outputTokens = nonNegativeInteger(usage.completion_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens);
  const promptDetails = asObject(usage.prompt_tokens_details);
  const cachedInputTokens = nonNegativeInteger(promptDetails?.cached_tokens)
    ?? nonNegativeInteger(usage.prompt_cache_hit_tokens);
  const hasProviderValue = [inputTokens, cachedInputTokens, outputTokens, totalTokens]
    .some((value) => value !== null);
  return {
    usageSource: hasProviderValue ? "provider" : "unavailable",
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
  };
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
    // 尽早停止未读正文；不能让坏包、超限或取消继续占用连接。
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 超时或取消时可能仍有 pending read；释放失败不能覆盖原始终止原因。
    }
  }
}

interface StreamToolCall {
  id?: string;
  type?: "function";
  name?: string;
  arguments: string;
}

interface StreamingCompletion {
  result: ModelResponse;
  finishReason: string;
  usage: Pick<
    ModelCallMetric,
    "usageSource" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "totalTokens"
  >;
}

function assignStreamString(
  current: string | undefined,
  incoming: unknown,
  field: string,
  providerName: string,
): string | undefined {
  if (incoming === undefined) return current;
  if (typeof incoming !== "string") {
    throw new Error(`${providerName} 流式工具调用的 ${field} 格式无效。`);
  }
  if (current !== undefined && current !== incoming) {
    throw new Error(`${providerName} 流式工具调用的 ${field} 前后不一致。`);
  }
  return incoming;
}

function mergeStreamToolCall(
  calls: Map<number, StreamToolCall>,
  rawValue: unknown,
  providerName: string,
): void {
  const rawCall = asObject(rawValue);
  const index = nonNegativeInteger(rawCall?.index);
  if (!rawCall || index === null) {
    throw new Error(`${providerName} 返回了格式无效的流式工具调用。`);
  }
  const current = calls.get(index) ?? { arguments: "" };
  current.id = assignStreamString(current.id, rawCall.id, "id", providerName);
  const rawType = assignStreamString(current.type, rawCall.type, "type", providerName);
  if (rawType !== undefined && rawType !== "function") {
    throw new Error(`${providerName} 返回了不受支持的流式工具调用类型。`);
  }
  current.type = rawType as "function" | undefined;

  if (rawCall.function !== undefined) {
    const rawFunction = asObject(rawCall.function);
    if (!rawFunction) {
      throw new Error(`${providerName} 返回了格式无效的流式工具函数。`);
    }
    current.name = assignStreamString(current.name, rawFunction.name, "function.name", providerName);
    if (rawFunction.arguments !== undefined) {
      if (typeof rawFunction.arguments !== "string") {
        throw new Error(`${providerName} 流式工具调用的 function.arguments 格式无效。`);
      }
      current.arguments += rawFunction.arguments;
    }
  }
  calls.set(index, current);
}

function materializeStreamToolCalls(calls: ReadonlyMap<number, StreamToolCall>, providerName: string): ApiFunctionToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id || call.type !== "function" || !call.name) {
        throw new Error(`${providerName} 返回了不完整的流式工具调用。`);
      }
      return {
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      };
    });
}

/**
 * 读取 OpenAI Chat Completions 的 data-only SSE。只把 assistant content 交给展示层；
 * 工具调用完整聚合并校验后才返回给 AgentLoop。
 */
async function readStreamingResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  providerName: string,
  onTextDelta: (content: string) => void,
): Promise<StreamingCompletion> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`响应正文超过 ${maximumBytes} 字节上限。`);
  }
  if (!response.body) {
    throw new Error(`${providerName} 流式响应缺少正文。`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const toolCalls = new Map<number, StreamToolCall>();
  let text = "";
  let finishReason: string | undefined;
  let usage = providerUsage(undefined);
  let receivedBytes = 0;
  let receivedDone = false;
  let lineBuffer = "";
  let eventData: string[] = [];

  const consumePayload = (data: string): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`流式事件 JSON 无效：${message}`);
    }
    const responseObject = asObject(payload);
    const choices = responseObject?.choices;
    if (!responseObject || !Array.isArray(choices)) {
      throw new Error(`${providerName} 流式响应缺少 choices。`);
    }
    const eventUsage = providerUsage(payload);
    if (eventUsage.usageSource === "provider") usage = eventUsage;
    if (choices.length === 0) return;
    if (finishReason !== undefined) {
      throw new Error(`${providerName} 在终态后又返回了流式选择。`);
    }
    const choice = asObject(choices[0]);
    if (!choice || (choice.index !== undefined && choice.index !== 0)) {
      throw new Error(`${providerName} 返回了格式无效的流式选择。`);
    }
    const delta = asObject(choice.delta);
    if (!delta || (delta.role !== undefined && delta.role !== "assistant")) {
      throw new Error(`${providerName} 流式响应缺少 assistant delta。`);
    }
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") {
        throw new Error(`${providerName} 流式内容格式无效。`);
      }
      if (delta.content !== "") {
        text += delta.content;
        try {
          onTextDelta(delta.content);
        } catch {
          // 展示层故障不能影响模型解析、工具校验或安全边界。
        }
      }
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) {
        throw new Error(`${providerName} 流式工具调用数组格式无效。`);
      }
      for (const toolCall of delta.tool_calls) mergeStreamToolCall(toolCalls, toolCall, providerName);
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string") {
        throw new Error(`${providerName} 流式响应的 finish_reason 格式无效。`);
      }
      finishReason = choice.finish_reason;
    }
  };

  const flushEvent = (): void => {
    if (eventData.length === 0) return;
    const data = eventData.join("\n");
    eventData = [];
    if (receivedDone) {
      throw new Error(`${providerName} 在 [DONE] 后又返回了数据。`);
    }
    if (data === "[DONE]") {
      receivedDone = true;
      return;
    }
    consumePayload(data);
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const value = line.slice("data:".length);
    eventData.push(value.startsWith(" ") ? value.slice(1) : value);
  };

  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel();
        throw new Error(`响应正文超过 ${maximumBytes} 字节上限。`);
      }
      lineBuffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = lineBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        consumeLine(lineBuffer.slice(0, newlineIndex));
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
      }
    }
    lineBuffer += decoder.decode();
    if (lineBuffer !== "") consumeLine(lineBuffer);
    flushEvent();
    if (!receivedDone) throw new Error(`${providerName} 流式响应缺少 [DONE]。`);
    if (finishReason === undefined) throw new Error(`${providerName} 流式响应缺少 finish_reason。`);
    const apiToolCalls = materializeStreamToolCalls(toolCalls, providerName);
    const result = parseResponse({
      choices: [{
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content: text,
          ...(apiToolCalls.length > 0 ? { tool_calls: apiToolCalls } : {}),
        },
      }],
    }, providerName);
    return { result, finishReason, usage };
  } catch (error) {
    // 尽早停止未读 SSE；不能让坏包、超限或取消继续占用连接。
    void reader.cancel().catch(() => {});
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
export class OpenAiCompatibleModel implements StreamingChatModel {
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
  readonly #onCallMetric?: (metric: ModelCallMetric) => void;
  #callIndex = 0;

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
    const baseUrlProblem = validateOpenAiCompatibleBaseUrl(baseUrl, {
      allowInsecureHttp: options.allowInsecureHttp,
    });
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
    this.#onCallMetric = options.onCallMetric;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    return await this.#complete(request, undefined, signal);
  }

  async completeStream(
    request: ModelRequest,
    observer: ModelTextDeltaObserver,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    return await this.#complete(request, observer, signal);
  }

  async #complete(
    request: ModelRequest,
    observer: ModelTextDeltaObserver | undefined,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    this.#callIndex += 1;
    const callIndex = this.#callIndex;
    const startedAt = new Date().toISOString();
    const monotonicStart = performance.now();
    let outcome: ModelCallMetric["outcome"] = "error";
    let errorCategory: ModelErrorCategory | null = null;
    let httpStatus: number | null = null;
    let finishReason: string | null = null;
    let responseKind: ModelResponse["kind"] | null = null;
    let usage = providerUsage(undefined);
    let ttftMs: number | null = null;
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    let phase: "request" | "fetch" | "body" | "parse" = "request";
    try {
      const requestBody = JSON.stringify({
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
        stream: observer !== undefined,
      });
      phase = "fetch";
      const response = await abortable(this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) {
        throw new ProviderHttpError(this.#providerName, response.status);
      }
      phase = "body";
      const result = observer
        ? (await readStreamingResponse(
          response,
          this.#maxResponseBytes,
          controller.signal,
          this.#providerName,
          (content) => {
            if (ttftMs === null) ttftMs = performance.now() - monotonicStart;
            try {
              observer.onTextDelta(content);
            } catch {
              // 展示层故障不能影响模型请求或后续本地工具边界。
            }
          },
        ))
        : undefined;
      phase = "parse";
      let modelResponse: ModelResponse;
      if (result) {
        modelResponse = result.result;
        finishReason = result.finishReason;
        usage = result.usage;
      } else {
        const body = await readResponseBody(response, this.#maxResponseBytes, controller.signal);
        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`JSON 无效：${message}`);
        }
        modelResponse = parseResponse(payload, this.#providerName);
        const choices = asObject(payload)?.choices;
        const firstChoice = Array.isArray(choices) ? asObject(choices[0]) : undefined;
        finishReason = typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null;
        usage = providerUsage(payload);
      }
      responseKind = modelResponse.kind;
      outcome = "success";
      return modelResponse;
    } catch (error) {
      if (signal?.aborted) {
        errorCategory = "cancelled";
        throw new Error(`${this.#providerName} 请求已取消。`);
      }
      if (timedOut) {
        errorCategory = "timeout";
        throw new Error(`${this.#providerName} 请求超时（${this.#timeoutMs}ms）。`);
      }
      if (error instanceof ProviderHttpError) {
        errorCategory = categoryForHttpStatus(error.status);
        httpStatus = error.status;
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (phase === "request") {
        errorCategory = "request";
        throw new Error(`${this.#providerName} 请求构造失败：${message}`);
      }
      if (phase === "fetch") {
        errorCategory = "network";
        throw new Error(`${this.#providerName} 网络请求失败：${message}`);
      }
      if (phase === "body" || phase === "parse") errorCategory = "response_validation";
      else errorCategory = "unknown";
      throw new Error(`${this.#providerName} 响应解析失败：${message}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onExternalAbort);
      if (this.#onCallMetric) {
        try {
          this.#onCallMetric({
            callIndex,
            phase: request.phase ?? "execution",
            startedAt,
            latencyMs: performance.now() - monotonicStart,
            outcome,
            errorCategory: outcome === "success" ? null : errorCategory ?? "unknown",
            httpStatus: outcome === "success" ? null : httpStatus,
            finishReason,
            responseKind,
            ...usage,
            ttftMs,
          });
        } catch {
          // Telemetry is observational and must not change model behavior.
        }
      }
    }
  }
}

export const openAiCompatibleDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: DEFAULT_MAX_TOKENS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
} as const;
