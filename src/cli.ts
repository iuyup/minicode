import { AgentLoop } from "./agent/agent-loop.ts";
import { ToolRegistry } from "./agent/tool-registry.ts";
import { FakeModel } from "./models/fake-model.ts";
import { getProjectOverview } from "./tools/get-project-overview.ts";

const task = process.argv.slice(2).join(" ") || "Explain what this offline mini coding agent can do.";
const registry = new ToolRegistry([getProjectOverview]);
const agent = new AgentLoop(new FakeModel(), registry);
const result = await agent.run(task);

console.log("=== Lifecycle events ===");
for (const event of result.events) {
  if (event.type === "tool_finalized") {
    console.log(`${event.type} (${event.status}) -> ${event.toolName}`);
  } else if ("toolName" in event) {
    console.log(`${event.type} -> ${event.toolName}`);
  } else {
    console.log(event.type);
  }
}

console.log("\n=== Final answer ===");
console.log(result.answer);
console.log("\n=== Working ledger ===");
console.log(result.workingState);
