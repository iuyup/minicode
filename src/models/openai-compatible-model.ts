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
  fetchImplementation?: typeof fetch;
}

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

  let input: JsonValue = rawFunction.arguments;
  try {
    input = JSON.parse(rawFunction.arguments) as JsonValue;
  } catch {
    // 参数保留为字符串，后续由本地工具校验并生成标准错误终态。
  }
  return { id: rawToolCall.id, name: rawFunction.name, input };
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

  const content = typeof message.content === "string" ? message.content : "";
  if (message.tool_calls === undefined || message.tool_calls === null) {
    return { kind: "final", content };
  }
  if (!Array.isArray(message.tool_calls)) {
    throw new Error(`${providerName} 响应中的 tool_calls 格式无效。`);
  }
  return {
    kind: "tool_calls",
    content,
    toolCalls: message.tool_calls.map((toolCall) => parseToolCall(toolCall, providerName)),
  };
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
    if (options.baseUrl.trim() === "") {
      throw new Error(`${this.#providerName} 的 baseUrl 不能为空。`);
    }
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new Error(`${this.#providerName} 请求超时必须是正整数毫秒数。`);
    }
    if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) {
      throw new Error(`${this.#providerName} 最大输出 token 数必须是正整数。`);
    }

    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.#disableThinking = options.disableThinking ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
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
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`${this.#providerName} 请求超时（${this.#timeoutMs}ms）。`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.#providerName} 网络请求失败：${message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`${this.#providerName} 请求失败：HTTP ${response.status}。`);
    }
    try {
      return parseResponse(await response.json(), this.#providerName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.#providerName} 响应解析失败：${message}`);
    }
  }
}

export const openAiCompatibleDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxTokens: DEFAULT_MAX_TOKENS,
} as const;
