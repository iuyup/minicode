import type { AgentTool, JsonValue, ToolDescription } from "./contracts.ts";

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool<JsonValue>>();

  constructor(tools: readonly AgentTool<JsonValue>[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }
  }

  find(name: string): AgentTool<JsonValue> | undefined {
    return this.#tools.get(name);
  }

  describe(): ToolDescription[] {
    return [...this.#tools.values()].map(({ name, description }) => ({ name, description }));
  }
}
