import type { AgentTool, ToolDescription, ToolExecutionResult } from "./contracts.ts";

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool<unknown, ToolExecutionResult>>();

  constructor(tools: readonly AgentTool<unknown, ToolExecutionResult>[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`重复注册工具：${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }
  }

  find(name: string): AgentTool<unknown, ToolExecutionResult> | undefined {
    return this.#tools.get(name);
  }

  describe(): ToolDescription[] {
    return [...this.#tools.values()].map(({ name, description }) => ({ name, description }));
  }
}
