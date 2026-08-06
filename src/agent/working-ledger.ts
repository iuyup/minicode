export interface ToolObservation {
  toolName: string;
  status: "success" | "error";
  summary: string;
}

const MAX_SUMMARY_CHARS = 480;

function compactSummary(summary: string): string {
  const singleLine = summary.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= MAX_SUMMARY_CHARS
    ? singleLine
    : `${singleLine.slice(0, MAX_SUMMARY_CHARS)}… [任务账本摘要已截断]`;
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
    this.#observations.push({ ...observation, summary: compactSummary(observation.summary) });
  }

  render(): string {
    const recent = this.#observations.slice(-6);
    const lines = [`任务目标：${this.task}`, "已确认的观察："];

    if (recent.length === 0) {
      lines.push("- 暂无");
    } else {
      for (const observation of recent) {
        lines.push(`- [${observation.status}] ${observation.toolName}: ${observation.summary}`);
      }
    }

    return lines.join("\n");
  }
}
