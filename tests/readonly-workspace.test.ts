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
import { WorkspacePolicy } from "../src/workspace/workspace-policy.ts";

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-readonly-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, "node_modules"));
  await fs.mkdir(path.join(workspace, ".git"));
  await fs.mkdir(path.join(workspace, ".ssh"));
  await fs.writeFile(
    path.join(workspace, "src", "example.ts"),
    ["export const title = 'example';", "export const needle = 'confirmed';", "export const end = true;"].join("\n"),
  );
  await fs.writeFile(path.join(workspace, "README.md"), "公开说明\n");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=must-not-be-read\n");
  await fs.writeFile(path.join(workspace, ".npmrc"), "//registry.example/:_authToken=must-not-be-read\n");
  await fs.writeFile(path.join(workspace, ".ssh", "id_rsa"), "SSH_SECRET=must-not-be-read\n");
  await fs.writeFile(path.join(workspace, "src", ".Env.Local"), "NESTED_SECRET=must-not-be-searched\n");
  await fs.writeFile(path.join(workspace, "src", ".Pypirc"), "PYPI_SECRET=must-not-be-searched\n");
  await fs.writeFile(path.join(workspace, "src", "long-line.ts"), `${"x".repeat(241)}\nexport const visible = true;\n`);
  await fs.writeFile(path.join(workspace, "long.txt"), Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n"));
  return workspace;
}

function context(workspaceRoot: string, requireSourceEvidence = false) {
  return { task: "只读工具测试", step: 1, workspaceRoot, requireSourceEvidence };
}

test("只读工具只返回工作区中的可见文本证据，并限制输出范围", async () => {
  const workspace = await createWorkspace();
  try {
    const listed = await listFiles.execute({}, context(workspace));
    assert.match(listed, /目录 src/);
    assert.match(listed, /文件 README.md/);
    assert.doesNotMatch(listed, /node_modules|\.git|\.env|\.npmrc|\.ssh/i);

    const searched = await searchText.execute({ query: "needle", path: "src" }, context(workspace));
    assert.match(searched, /src\/example.ts:2: export const needle/);
    const protectedSearch = await searchText.execute({ query: "must-not-be-searched", path: "src" }, context(workspace));
    assert.match(protectedSearch, /未找到匹配/);
    assert.doesNotMatch(protectedSearch, /NESTED_SECRET|PYPI_SECRET|\.Env\.Local|\.Pypirc/);

    const read = await readFile.execute({ path: "src/example.ts", startLine: 2, endLine: 2 }, context(workspace));
    assert.match(read.content, /src\/example.ts:2 \| export const needle = 'confirmed';/);
    assert.deepEqual(read.sourceEvidence, [{ path: "src/example.ts", startLine: 2, endLine: 2 }]);

    const truncated = await readFile.execute({ path: "long.txt", startLine: 1, endLine: 100 }, context(workspace));
    assert.match(truncated.content, /单次最多读取 80 行/);
    assert.doesNotMatch(truncated.content, /long.txt:81 \|/);
    assert.deepEqual(truncated.sourceEvidence, [{ path: "long.txt", startLine: 1, endLine: 80 }]);

    const longLine = await readFile.execute(
      { path: "src/long-line.ts", startLine: 1, endLine: 2 },
      context(workspace, true),
    );
    assert.match(longLine.content, /src\/long-line\.ts:1 .*\[行内容已截断\]/);
    assert.deepEqual(longLine.sourceEvidence, [{
      path: "src/long-line.ts",
      startLine: 1,
      endLine: 2,
      truncatedLines: [1],
    }]);
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
    await assert.rejects(readFile.execute({ path: ".ENV" }, context(workspace)), /目标路径受保护/);
    await assert.rejects(readFile.execute({ path: "src/.Env.Local" }, context(workspace)), /目标路径受保护/);
    await assert.rejects(readFile.execute({ path: ".npmrc" }, context(workspace)), /目标路径受保护/);
    await assert.rejects(readFile.execute({ path: "src/.Pypirc" }, context(workspace)), /目标路径受保护/);
    await assert.rejects(readFile.execute({ path: ".ssh/id_rsa" }, context(workspace)), /目标路径受保护/);

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

test("扩展的内置敏感规则在任意层级和大小写下统一约束 list、search 与 read", async () => {
  const workspace = await createWorkspace();
  const protectedFiles = [
    ["Credentials.Production.JSON", "CREDENTIAL_MARKER_1"],
    ["src/Secrets.YaML", "YAML_SECRET_MARKER_2"],
    ["src/service-account-prod.json", "SERVICE_ACCOUNT_MARKER_3"],
    ["src/server.PEM", "PEM_MARKER_4"],
    ["src/signing.Key", "KEY_MARKER_5"],
    ["src/certificate.P12", "P12_MARKER_6"],
    ["src/archive.PfX", "PFX_MARKER_7"],
  ] as const;
  try {
    for (const [relativePath, marker] of protectedFiles) {
      await fs.writeFile(path.join(workspace, ...relativePath.split("/")), `${marker}\n`, "utf8");
    }

    const rootListing = await listFiles.execute({}, context(workspace));
    const sourceListing = await listFiles.execute({ path: "src" }, context(workspace));
    const searched = await searchText.execute({ query: "MARKER", path: "." }, context(workspace));
    for (const [relativePath, marker] of protectedFiles) {
      assert.doesNotMatch(`${rootListing}\n${sourceListing}\n${searched}`, new RegExp(marker, "iu"));
      assert.doesNotMatch(`${rootListing}\n${sourceListing}`, new RegExp(path.basename(relativePath), "iu"));
      await assert.rejects(
        readFile.execute({ path: relativePath }, context(workspace)),
        /目标路径受保护/,
      );
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test(".minicodeignore 使用根相对小型 glob，并让 list、search、read 与 write 策略一致闭锁", async () => {
  const workspace = await createWorkspace();
  try {
    await fs.mkdir(path.join(workspace, "private"));
    await fs.mkdir(path.join(workspace, "generated"));
    await fs.mkdir(path.join(workspace, "docs"));
    await fs.mkdir(path.join(workspace, "cache"));
    await fs.writeFile(path.join(workspace, ".minicodeignore"), [
      "# 规则相对工作区根目录",
      "PRIVATE/**",
      "generated/*.ts",
      "docs/?raft.md",
      "cache/",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspace, "private", "secret.txt"), "CUSTOM_PRIVATE_MARKER\n", "utf8");
    await fs.writeFile(path.join(workspace, "generated", "hidden.ts"), "CUSTOM_GENERATED_MARKER\n", "utf8");
    await fs.writeFile(path.join(workspace, "generated", "visible.md"), "VISIBLE_GENERATED_TEXT\n", "utf8");
    await fs.writeFile(path.join(workspace, "docs", "draft.md"), "CUSTOM_DRAFT_MARKER\n", "utf8");
    await fs.writeFile(path.join(workspace, "cache", "item.txt"), "CUSTOM_CACHE_MARKER\n", "utf8");

    const policy = new WorkspacePolicy(workspace);
    assert.equal(await policy.hasCustomIgnoreRules(), true);
    const rootListing = await listFiles.execute({}, context(workspace));
    assert.doesNotMatch(rootListing, /\.minicodeignore|private|cache/i);
    const generatedListing = await listFiles.execute({ path: "generated" }, context(workspace));
    assert.doesNotMatch(generatedListing, /hidden\.ts/i);
    assert.match(generatedListing, /visible\.md/i);

    const searched = await searchText.execute({ query: "CUSTOM_", path: "." }, context(workspace));
    assert.match(searched, /未找到匹配/);
    assert.doesNotMatch(searched, /PRIVATE|GENERATED|DRAFT|CACHE/);
    const visible = await searchText.execute({ query: "VISIBLE_GENERATED_TEXT", path: "." }, context(workspace));
    assert.match(visible, /generated\/visible\.md/);

    for (const relativePath of [
      "private/secret.txt",
      "generated/hidden.ts",
      "docs/draft.md",
      "cache/item.txt",
      ".minicodeignore",
    ]) {
      await assert.rejects(readFile.execute({ path: relativePath }, context(workspace)), /目标路径受保护/);
      await assert.rejects(policy.resolveWritePath(relativePath), /目标路径受保护/);
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test(".minicodeignore 的反向规则、非法 UTF-8 与超限正文均失败关闭", async () => {
  const cases: readonly [string, Buffer, RegExp][] = [
    ["negation", Buffer.from("!.env\n", "utf8"), /不支持的 ! 反向规则/],
    ["invalid-utf8", Buffer.from([0xff]), /不是有效的 UTF-8/],
    ["oversized", Buffer.alloc(64 * 1024 + 1, 0x61), /超过 65536 字节限制/],
  ];
  for (const [label, content, expected] of cases) {
    const workspace = await createWorkspace();
    try {
      await fs.writeFile(path.join(workspace, ".minicodeignore"), content);
      await assert.rejects(
        readFile.execute({ path: "README.md" }, context(workspace)),
        expected,
        label,
      );
      // Built-ins are checked before custom rules, so an invalid `!` rule can
      // never be used to unprotect a credential path.
      await assert.rejects(
        readFile.execute({ path: ".env" }, context(workspace)),
        /目标路径受保护/,
        label,
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("只读工具拒绝把非法 UTF-8 字节静默替换成文本", async () => {
  const workspace = await createWorkspace();
  const invalidPath = path.join(workspace, "src", "invalid.ts");
  try {
    await fs.writeFile(invalidPath, Buffer.from([0x62, 0x61, 0x64, 0x80, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));

    await assert.rejects(
      readFile.execute({ path: "src/invalid.ts" }, context(workspace)),
      /不是有效 UTF-8 文本/,
    );

    const searched = await searchText.execute({ query: "bad", path: "src" }, context(workspace));
    assert.match(searched, /非 UTF-8 文本：1 个（已拒绝搜索其内容）/);
    assert.doesNotMatch(searched, /src\/invalid\.ts:\d+:/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("search_text 只在确实还有文件未收集时报告文件上限截断", async () => {
  const workspace = await createWorkspace();
  const exactDirectory = path.join(workspace, "exact-limit");
  try {
    await fs.mkdir(exactDirectory);
    await Promise.all(
      Array.from({ length: 200 }, (_, index) => fs.writeFile(path.join(exactDirectory, `${index}.txt`), "plain\n")),
    );
    const exact = await searchText.execute({ query: "missing", path: "exact-limit" }, context(workspace));
    assert.doesNotMatch(exact, /最多收集 200 个文件/);

    await fs.writeFile(path.join(exactDirectory, "overflow.txt"), "plain\n");
    const overflow = await searchText.execute({ query: "missing", path: "exact-limit" }, context(workspace));
    assert.match(overflow, /最多收集 200 个文件/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("search_text 只在确实存在第 21 条匹配时报告结果截断", async () => {
  const workspace = await createWorkspace();
  const matchesPath = path.join(workspace, "matches.txt");
  try {
    await fs.writeFile(matchesPath, Array.from({ length: 20 }, () => "exact-needle").join("\n"), "utf8");
    const exact = await searchText.execute({ query: "exact-needle", path: "." }, context(workspace));
    assert.doesNotMatch(exact, /最多返回 20 条匹配/);

    await fs.appendFile(matchesPath, "\nexact-needle", "utf8");
    const overflow = await searchText.execute({ query: "exact-needle", path: "." }, context(workspace));
    assert.match(overflow, /最多返回 20 条匹配/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("search_text 在 AbortSignal 已取消时立即停止并返回取消元数据", async () => {
  const workspace = await createWorkspace();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      searchText.execute(
        { query: "needle", path: "." },
        { ...context(workspace), signal: controller.signal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /文本搜索已取消/);
        assert.deepEqual("metadata" in error ? error.metadata : undefined, {
          action: "search_text",
          cancelled: true,
        });
        return true;
      },
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("源码证据模式强制搜索和读取范围位于 src", async () => {
  const workspace = await createWorkspace();
  const sourceContext = context(workspace, true);
  try {
    const searched = await searchText.execute({ query: "needle" }, sourceContext);
    assert.match(searched, /范围：src/);
    assert.match(searched, /src\/example.ts:2: export const needle/);
    assert.doesNotMatch(searched, /README.md/);

    const read = await readFile.execute({ path: "src/example.ts", startLine: 2, endLine: 2 }, sourceContext);
    assert.match(read.content, /src\/example.ts:2 \| export const needle/);

    await assert.rejects(
      searchText.execute({ query: "公开", path: "." }, sourceContext),
      /源码证据模式只允许在 src 目录内搜索/,
    );
    await assert.rejects(
      readFile.execute({ path: "README.md" }, sourceContext),
      /源码证据模式只允许读取 src 目录内的文件/,
    );
    await assert.rejects(
      readFile.execute({ path: "src/../README.md" }, sourceContext),
      /源码证据模式只允许读取 src 目录内的文件/,
    );
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
  assert.match(result.answer, /源代码原文；\$\{\.\.\.\} 表示运行时插值占位符/u);
  assert.match(result.answer, /src\/agent\/agent-loop.ts/);
  assert.match(result.answer, /未知工具/);
  assert.deepEqual(
    result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
    ["search_text", "read_file"],
  );
});

test("FakeModel 对自由输入说明边界，不伪装成源码侦察", async () => {
  const registry = new ToolRegistry([listFiles, searchText, readFile]);
  const result = await new AgentLoop(new FakeModel(), registry, {
    workspaceRoot: process.cwd(),
  }).run("你好");

  assert.match(result.answer, /离线 FakeModel 演示/u);
  assert.match(result.answer, /本次未执行工具/u);
  assert.doesNotMatch(result.answer, /只读代码侦察闭环已完成/u);
  assert.deepEqual(
    result.events.filter((event) => event.type === "tool_call" || event.type === "tool_execution_started"),
    [],
  );
});
