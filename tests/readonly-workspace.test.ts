import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { ChatModel, ModelRequest, ModelResponse } from "../src/agent/contracts.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { FakeModel } from "../src/models/fake-model.ts";
import { listFiles } from "../src/tools/list-files.ts";
import { readFile } from "../src/tools/read-file.ts";
import { searchText } from "../src/tools/search-text.ts";

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-readonly-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "node_modules"));
  await fs.mkdir(path.join(workspace, ".git"));
  await fs.writeFile(
    path.join(workspace, "src", "example.ts"),
    ["export const title = 'example';", "export const needle = 'confirmed';", "export const end = true;"].join("\n"),
  );
  await fs.writeFile(path.join(workspace, "README.md"), "公开说明\n");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=must-not-be-read\n");
  await fs.writeFile(path.join(workspace, "long.txt"), Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n"));
  return workspace;
}

function context(workspaceRoot: string) {
  return { task: "只读工具测试", step: 1, workspaceRoot };
}

test("只读工具只返回工作区中的可见文本证据，并限制输出范围", async () => {
  const workspace = await createWorkspace();
  try {
    const listed = await listFiles.execute({}, context(workspace));
    assert.match(listed, /目录 src/);
    assert.match(listed, /文件 README.md/);
    assert.doesNotMatch(listed, /node_modules|\.git|\.env/);

    const searched = await searchText.execute({ query: "needle", path: "src" }, context(workspace));
    assert.match(searched, /src\/example.ts:2: export const needle/);

    const read = await readFile.execute({ path: "src/example.ts", startLine: 2, endLine: 2 }, context(workspace));
    assert.match(read, /src\/example.ts:2 \| export const needle = 'confirmed';/);

    const truncated = await readFile.execute({ path: "long.txt", startLine: 1, endLine: 100 }, context(workspace));
    assert.match(truncated, /单次最多读取 80 行/);
    assert.doesNotMatch(truncated, /long.txt:81 \|/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("越界和受保护文件会变成标准化错误终态，而不是被读取", async () => {
  const workspace = await createWorkspace();
  try {
    await assert.rejects(
      readFile.execute({ path: "../outside.txt" }, context(workspace)),
      /路径越出了工作区/,
    );
    await assert.rejects(readFile.execute({ path: ".env" }, context(workspace)), /目标路径受保护/);

    let callCount = 0;
    const model: ChatModel = {
      async complete(request: ModelRequest): Promise<ModelResponse> {
        callCount += 1;
        if (callCount === 1) {
          return {
            kind: "tool_calls",
            content: "尝试读取受保护文件。",
            toolCalls: [{ id: "protected-1", name: "read_file", input: { path: ".env" } }],
          };
        }
        const result = request.messages.at(-1);
        assert.equal(result?.role, "tool");
        assert.equal(result?.status, "error");
        assert.match(result?.content ?? "", /目标路径受保护/);
        return { kind: "final", content: "已确认读取被拒绝。" };
      },
    };

    const result = await new AgentLoop(model, new ToolRegistry([readFile]), {
      workspaceRoot: workspace,
    }).run("读取 .env");
    assert.deepEqual(
      result.events.map((event) => event.type),
      ["model_requested", "tool_call", "tool_execution_started", "tool_finalized", "model_requested", "agent_completed"],
    );
    const finalized = result.events.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "protected-1",
    );
    assert.equal(finalized?.type, "tool_finalized");
    if (finalized?.type === "tool_finalized") {
      assert.equal(finalized.status, "error");
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 通过真实搜索和读取工具解释当前 AgentLoop", async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const registry = new ToolRegistry([listFiles, searchText, readFile]);
  const result = await new AgentLoop(new FakeModel(), registry, {
    workspaceRoot: projectRoot,
  }).run("说明未知工具为何仍有完整的终态事件。");

  assert.match(result.answer, /只读代码侦察闭环已完成/);
  assert.match(result.answer, /src\/agent\/agent-loop.ts/);
  assert.match(result.answer, /未知工具/);
  assert.deepEqual(
    result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
    ["search_text", "read_file"],
  );
});
