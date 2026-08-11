import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("源码证据模式只注册搜索和源码读取工具，并以单次调用完成离线闭环", async () => {
  const reportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-source-evidence-cli-"));
  const auditPath = path.join(reportDirectory, "audit.jsonl");

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "src/cli.ts",
        "--workspace",
        process.cwd(),
        "--require-source-evidence",
        "--audit",
        auditPath,
        "解释未知工具为何仍有完整的终态事件",
      ],
      { cwd: process.cwd() },
    );

    assert.match(stdout, /工具权限：只读源码取证/);
    assert.match(stdout, /=== 已验证源码证据 ===/);
    const events = (await fs.readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; toolName?: string });

    assert.deepEqual(
      events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["search_text", "read_file"],
    );
    assert.equal(events.at(-1)?.type, "agent_completed");
  } finally {
    await fs.rm(reportDirectory, { recursive: true, force: true });
  }
});
