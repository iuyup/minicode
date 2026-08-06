export interface ToolObservation {
  toolName: string;
  status: "success" | "error";
  summary: string;
}

/**
 * This is deliberately task-scoped state, not long-term memory.
 * It gives every model turn a compact reminder of confirmed observations.
 */
export class WorkingLedger {
  readonly #observations: ToolObservation[] = [];
  readonly task: string;

  constructor(task: string) {
    this.task = task;
  }

  record(observation: ToolObservation): void {
    this.#observations.push(observation);
  }

  render(): string {
    const recent = this.#observations.slice(-6);
    const lines = [`Goal: ${this.task}`, "Confirmed observations:"];

    if (recent.length === 0) {
      lines.push("- none yet");
    } else {
      for (const observation of recent) {
        lines.push(`- [${observation.status}] ${observation.toolName}: ${observation.summary}`);
      }
    }

    return lines.join("\n");
  }
}
