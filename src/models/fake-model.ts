import type { ChatModel, ModelRequest, ModelResponse, ToolResultMessage } from "../agent/contracts.ts";

/**
 * A deterministic stand-in for an LLM. It makes the first tool call, then
 * proves that the second model turn can see the ToolResultMessage.
 */
export class FakeModel implements ChatModel {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const overview = request.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "tool" && message.name === "get_project_overview",
    );

    if (!overview) {
      return {
        kind: "tool_calls",
        content: "I need the local project overview before answering.",
        toolCalls: [{ id: "call-overview-1", name: "get_project_overview", input: {} }],
      };
    }

    return {
      kind: "final",
      content: [
        "Offline loop completed.",
        `Evidence from the tool: ${overview.content}`,
        "The model did not receive a hard-coded answer; it answered after the ToolResultMessage was appended.",
      ].join("\n"),
    };
  }
}
