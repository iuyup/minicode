import type { AgentTool, JsonValue, ValidationResult } from "../agent/contracts.ts";

type EmptyInput = Record<string, never>;

function validateEmptyObject(input: JsonValue): ValidationResult<EmptyInput> {
  const isEmptyObject =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0;

  return isEmptyObject
    ? { ok: true, value: {} }
    : { ok: false, error: "get_project_overview accepts an empty object only." };
}

export const getProjectOverview: AgentTool<EmptyInput> = {
  name: "get_project_overview",
  description: "Return the confirmed scope of the offline first-week demo.",
  validate: validateEmptyObject,
  async execute(_input, context): Promise<string> {
    return [
      `Task received: ${context.task}`,
      "This first-week build has an Agent Loop, typed tool contract, FakeModel, working ledger, lifecycle events, CLI demo, and tests.",
      "It intentionally has no live model, file mutation, shell execution, or policy layer yet.",
    ].join(" ");
  },
};
