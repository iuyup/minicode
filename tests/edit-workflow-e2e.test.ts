import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Terminal } from "@mariozechner/pi-tui";

import type {
  AgentMessage,
  ChatModel,
  ModelRequest,
  ModelResponse,
  ToolResultMessage,
} from "../src/agent/contracts.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { createMiniTui, type MiniTuiApp } from "../src/mini.ts";
import { createSanitizedChildEnvironment, resolveNpmCli } from "../src/tools/child-process-safety.ts";
import { resolveGitExecutable } from "../src/tools/inspect-git.ts";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "..");
const prepareScript = path.join(projectRoot, "scripts", "create-edit-smoke-workspace.mjs");

const OLD_PATCH_SENTINEL = "return `Hello, ${name}`;";
const NEW_PATCH_SENTINEL = "return `Hello, ${name}!`;";
const DIFF_SENTINEL = "diff --git a/src/greeting.js b/src/greeting.js";
const TEST_OUTPUT_SENTINEL = "formatGreeting returns a complete greeting";
const EXPECTED_GREETING_SENTINEL = "Hello, MiniCode!";
const STAGED_RESET_SENTINEL = "RESET_STAGED_CONTENT_7D31";
const UNTRACKED_RESET_SENTINEL = "RESET_UNTRACKED_CONTENT_5A82";
const CONFIG_RESET_SENTINEL = "reset-config-9c44";

const BROKEN_SOURCE = [
  "export function formatGreeting(name) {",
  `  ${OLD_PATCH_SENTINEL}`,
  "}",
  "",
].join("\n");
const FIXED_SOURCE = [
  "export function formatGreeting(name) {",
  `  ${NEW_PATCH_SENTINEL}`,
  "}",
  "",
].join("\n");
const FINAL_SUMMARY = [
  "修改摘要：为 src/greeting.js 的问候语补上结尾感叹号。",
  "验证结果：npm test 已通过，退出码为 0。",
  "Git 摘要：工作树仅包含 src/greeting.js 的未暂存修改，Git diff 与本次修复一致。",
  "未完成项：无。未执行暂存或 commit，请由用户检查后手动 commit。",
].join("\n");
const REPAIR_DIRECTION = [
  "失败原因：formatGreeting 返回值缺少测试要求的结尾感叹号。",
  "修复方向：读取 src/greeting.js，只补上缺失的 !，随后再次运行 npm test。",
].join("\n");
const REPAIR_FINAL_SUMMARY = [
  "修改摘要：确认修复方向后，为 src/greeting.js 的问候语补上结尾感叹号。",
  "验证结果：首次 npm test 真实失败；最小修复后的第二次 npm test 已通过，退出码为 0。",
  "Git 摘要：工作树仅包含 src/greeting.js 的未暂存修改，Git diff 与本次修复一致。",
  "未完成项：无。未执行暂存或 commit，请由用户检查后手动 commit。",
].join("\n");
const PRODUCTION_EDIT_TOOL_NAMES = [
  "get_project_overview",
  "list_files",
  "search_text",
  "read_file",
  "inspect_git",
  "apply_patch",
  "run_project_check",
  "run_command",
] as const;

class FakeTerminal implements Terminal {
  #onInput?: (data: string) => void;
  output = "";
  columns = 110;
  rows = 36;
  kittyProtocolActive = false;

  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }

  stop(): void {}
  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.output += data;
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void {
    this.#onInput?.(data);
  }
}

class SuccessChainModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  #executionRequest = 0;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      assert.equal(request.phase, "planning");
      assert.equal(request.tools.length, 0, "生产 guided 计划轮不得开放工具");
      const systemMessage = request.messages[0];
      assert.equal(systemMessage?.role, "system");
      if (systemMessage?.role !== "system") throw new Error("生产装配缺少 system prompt。");
      assert.match(systemMessage.content, /受控的 Coding Agent/);
      assert.match(systemMessage.content, /read_file/);
      assert.match(systemMessage.content, /APPLY 是终端本地确认步骤/);
      assert.doesNotMatch(systemMessage.content, /当前处于用户确认的计划阶段/);
      const planningMessage = request.messages.at(-1);
      assert.equal(planningMessage?.role, "user");
      assert.match(planningMessage?.content ?? "", /当前处于用户确认的计划阶段/);
    }

    if (request.phase === "planning") {
      return {
        kind: "final",
        content: "1. 搜索并读取问候实现。\n2. 提交最小补丁并运行测试。\n3. 读取 Git 状态与差异后总结。",
      };
    }

    this.#executionRequest += 1;
    const lastMessage = request.messages.at(-1);
    switch (this.#executionRequest) {
      case 1:
        assert.equal(request.phase, "execution");
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          PRODUCTION_EDIT_TOOL_NAMES,
          "首个执行轮必须使用生产 edit 工具集",
        );
        assert.equal(lastMessage?.role, "user");
        assert.match(lastMessage?.content ?? "", /计划已由用户确认/);
        assert.equal(
          request.messages.some((message) => /当前处于用户确认的计划阶段/u.test(message.content)),
          false,
          "planning 提示不得进入确认后的执行消息历史",
        );
        return toolCall("e2e-search", "search_text", { query: "formatGreeting", path: "src" });
      case 2:
        assertSuccessfulTool(lastMessage, "search_text", /src\/greeting\.js:1/);
        return toolCall("e2e-read", "read_file", { path: "src/greeting.js" });
      case 3:
        assertSuccessfulTool(lastMessage, "read_file", /Hello, \$\{name\}/);
        return toolCall("e2e-patch", "apply_patch", {
          path: "src/greeting.js",
          oldText: OLD_PATCH_SENTINEL,
          newText: NEW_PATCH_SENTINEL,
        });
      case 4:
        assertSuccessfulTool(lastMessage, "apply_patch", /补丁已应用/);
        return toolCall("e2e-test", "run_project_check", { action: "test" });
      case 5:
        assertSuccessfulTool(lastMessage, "run_project_check", /退出码：0/);
        assert.ok(lastMessage.content.includes(TEST_OUTPUT_SENTINEL), "验证工具必须返回真实 Node test 输出");
        return toolCall("e2e-status", "inspect_git", { action: "status" });
      case 6:
        assertSuccessfulTool(lastMessage, "inspect_git", /Git 只读动作：status/);
        assert.match(lastMessage.content, /src\/greeting\.js/);
        return toolCall("e2e-diff", "inspect_git", { action: "diff" });
      case 7:
        assertSuccessfulTool(lastMessage, "inspect_git", /Git 只读动作：diff/);
        assert.ok(lastMessage.content.includes(DIFF_SENTINEL), "diff 工具结果必须包含目标文件差异");
        assert.ok(lastMessage.content.includes(NEW_PATCH_SENTINEL), "diff 工具结果必须包含本次新文本");
        assert.equal(request.tools.length, 0, "六次工具预算后必须进入 final-only 轮次");
        return { kind: "final", content: FINAL_SUMMARY };
      default:
        throw new Error(`脚本模型收到未预期的第 ${this.#executionRequest} 个执行请求。`);
    }
  }
}

class FailureRepairChainModel implements ChatModel {
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const lastMessage = request.messages.at(-1);

    switch (this.requests.length) {
      case 1:
        assert.equal(request.phase, "planning");
        assert.equal(request.tools.length, 0, "生产 guided 计划轮不得开放工具");
        assert.equal(lastMessage?.role, "user");
        assert.match(lastMessage?.content ?? "", /当前处于用户确认的计划阶段/);
        return {
          kind: "final",
          content: [
            "1. 先运行现有测试复现失败。",
            "2. 失败后给出修复方向并等待确认，再读取目标并提交最小补丁。",
            "3. 复验通过后读取 Git 状态与差异并总结。",
          ].join("\n"),
        };
      case 2:
        assert.equal(request.phase, "execution");
        assert.deepEqual(request.tools.map((tool) => tool.name), PRODUCTION_EDIT_TOOL_NAMES);
        assert.equal(lastMessage?.role, "user");
        assert.match(lastMessage?.content ?? "", /计划已由用户确认/);
        assert.equal(
          request.messages.some((message) => /当前处于用户确认的计划阶段/u.test(message.content)),
          false,
          "planning 提示不得进入确认后的执行消息历史",
        );
        return toolCall("repair-initial-test", "run_project_check", { action: "test" });
      case 3: {
        assert.equal(request.phase, "repair_planning");
        assert.equal(request.tools.length, 0, "修复方向轮不得开放工具");
        assert.equal(lastMessage?.role, "user");
        assert.match(lastMessage?.content ?? "", /无工具的修复方向阶段/);
        const failure = [...request.messages].reverse().find(
          (message) => message.role === "tool" && message.toolCallId === "repair-initial-test",
        );
        assertFailedTool(failure, "run_project_check", /退出码：1/);
        assert.equal(failure.metadata?.action, "test");
        assert.equal(failure.metadata?.exitCode, 1);
        assert.equal(failure.metadata?.timedOut, false);
        assert.ok(failure.content.includes(TEST_OUTPUT_SENTINEL));
        assert.ok(failure.content.includes(EXPECTED_GREETING_SENTINEL));
        return { kind: "final", content: REPAIR_DIRECTION };
      }
      case 4:
        assert.equal(request.phase, "execution");
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["read_file", "apply_patch", "run_project_check"],
          "确认修复方向后只能开放一次修复所需工具",
        );
        assert.equal(lastMessage?.role, "user");
        assert.match(lastMessage?.content ?? "", /修复方向已由用户确认/);
        return toolCall("repair-read", "read_file", { path: "src/greeting.js" });
      case 5:
        assertSuccessfulTool(lastMessage, "read_file", /Hello, \$\{name\}/);
        return toolCall("repair-patch", "apply_patch", {
          path: "src/greeting.js",
          oldText: OLD_PATCH_SENTINEL,
          newText: NEW_PATCH_SENTINEL,
        });
      case 6:
        assertSuccessfulTool(lastMessage, "apply_patch", /补丁已应用/);
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["run_project_check"],
          "一次补丁获批后必须先完成固定 test",
        );
        return toolCall("repair-retest", "run_project_check", { action: "test" });
      case 7:
        assertSuccessfulTool(lastMessage, "run_project_check", /退出码：0/);
        assert.equal(lastMessage.metadata?.action, "test");
        assert.equal(lastMessage.metadata?.exitCode, 0);
        assert.equal(lastMessage.metadata?.timedOut, false);
        assert.ok(lastMessage.content.includes(TEST_OUTPUT_SENTINEL));
        assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
        return toolCall("repair-status", "inspect_git", { action: "status" });
      case 8:
        assertSuccessfulTool(lastMessage, "inspect_git", /Git 只读动作：status/);
        assert.match(lastMessage.content, /src\/greeting\.js/);
        assert.deepEqual(request.tools.map((tool) => tool.name), ["inspect_git"]);
        return toolCall("repair-diff", "inspect_git", { action: "diff" });
      case 9:
        assertSuccessfulTool(lastMessage, "inspect_git", /Git 只读动作：diff/);
        assert.ok(lastMessage.content.includes(DIFF_SENTINEL));
        assert.ok(lastMessage.content.includes(NEW_PATCH_SENTINEL));
        assert.equal(request.tools.length, 0, "六次工具预算后必须进入 final-only 轮次");
        return { kind: "final", content: REPAIR_FINAL_SUMMARY };
      default:
        throw new Error(`失败修复脚本模型收到未预期的第 ${this.requests.length} 次请求。`);
    }
  }
}

function toolCall(id: string, name: string, input: Record<string, string>): ModelResponse {
  return {
    kind: "tool_calls",
    content: `执行 ${name}。`,
    toolCalls: [{ id, name, input }],
  };
}

function assertSuccessfulTool(
  message: AgentMessage | undefined,
  name: string,
  contentPattern: RegExp,
): asserts message is ToolResultMessage {
  assert.equal(message?.role, "tool");
  if (message?.role !== "tool") throw new Error(`预期 ${name} 的工具结果。`);
  assert.equal(message.name, name);
  assert.equal(message.status, "success");
  assert.match(message.content, contentPattern);
}

function assertFailedTool(
  message: AgentMessage | undefined,
  name: string,
  contentPattern: RegExp,
): asserts message is ToolResultMessage {
  assert.equal(message?.role, "tool");
  if (message?.role !== "tool") throw new Error(`预期 ${name} 的失败工具结果。`);
  assert.equal(message.name, name);
  assert.equal(message.status, "error");
  assert.match(message.content, contentPattern);
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r/gu, "");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 E2E 状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function prepareWorkspace(
  parent: string,
  name: string,
  mode: "create" | "reset" = "create",
): Promise<string> {
  const workspace = path.join(parent, name);
  const flag = mode === "create" ? "--output" : "--reset-output";
  await execFileAsync(process.execPath, [prepareScript, flag, workspace], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return workspace;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "TEMP",
    "TMP",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LANG: "C",
    LC_ALL: "C",
  };
}

async function git(executable: string, cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    cwd,
    env: isolatedGitEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function runFixtureTest(workspace: string): Promise<{ exitCode: number; output: string }> {
  const npmCli = await resolveNpmCli();
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [npmCli, "test"], {
      cwd: workspace,
      env: createSanitizedChildEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const numericCode = typeof failure.code === "number" ? failure.code : Number(failure.code);
    if (!Number.isInteger(numericCode)) throw error;
    return { exitCode: numericCode, output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}` };
  }
}

function collectStringValues(value: unknown, strings: string[] = []): string[] {
  if (typeof value === "string") {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, strings);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, strings);
  }
  return strings;
}

function normalizePathForComparison(value: string): string {
  return value.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/").toLowerCase();
}

function containsNormalizedPath(value: unknown, targetPath: string): boolean {
  const normalizedTarget = normalizePathForComparison(targetPath);
  return collectStringValues(value).some((candidate) =>
    normalizePathForComparison(candidate).includes(normalizedTarget)
  );
}

function eventIndex(events: readonly AgentEvent[], predicate: (event: AgentEvent) => boolean): number {
  const index = events.findIndex(predicate);
  assert.notEqual(index, -1, "缺少预期生命周期事件");
  return index;
}

test("prepare:edit-smoke 可在同一路径复位 modified、staged、untracked 与 local config", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-edit-prepare-"));
  try {
    const workspace = await prepareWorkspace(tempRoot, "workspace");
    const executable = await resolveGitExecutable(workspace);
    const baselineHead = await git(executable, workspace, ["rev-parse", "HEAD"]);

    assert.equal(await git(executable, workspace, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(await git(executable, workspace, ["branch", "--show-current"]), "main");
    assert.equal(await git(executable, workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(await git(executable, workspace, ["remote"]), "");
    assert.equal(await fs.readFile(path.join(workspace, "src", "greeting.js"), "utf8"), BROKEN_SOURCE);

    const initialFailure = await runFixtureTest(workspace);
    assert.equal(initialFailure.exitCode, 1);
    assert.ok(initialFailure.output.includes(TEST_OUTPUT_SENTINEL), "初始失败必须来自目标测试");
    assert.ok(initialFailure.output.includes(EXPECTED_GREETING_SENTINEL), "初始失败必须显示预期问候语");

    await fs.writeFile(path.join(workspace, "src", "greeting.js"), FIXED_SOURCE, "utf8");
    await fs.appendFile(path.join(workspace, "README.md"), `\n${STAGED_RESET_SENTINEL}\n`, "utf8");
    await git(executable, workspace, ["add", "--", "README.md"]);
    await fs.writeFile(path.join(workspace, "reset-untracked.txt"), `${UNTRACKED_RESET_SENTINEL}\n`, "utf8");
    await git(executable, workspace, ["config", "--local", "minicode.resetSentinel", CONFIG_RESET_SENTINEL]);

    const dirtyStatus = await git(executable, workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
    assert.match(dirtyStatus, /^M  README\.md$/mu);
    assert.match(dirtyStatus, /^ M src\/greeting\.js$/mu);
    assert.match(dirtyStatus, /^\?\? reset-untracked\.txt$/mu);
    assert.match(await git(executable, workspace, ["config", "--local", "--list"]), /minicode\.resetsentinel=/iu);

    await prepareWorkspace(tempRoot, "workspace", "reset");

    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), baselineHead);
    assert.equal(await git(executable, workspace, ["branch", "--show-current"]), "main");
    assert.equal(await git(executable, workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(await git(executable, workspace, ["remote"]), "");
    assert.equal(await fs.readFile(path.join(workspace, "src", "greeting.js"), "utf8"), BROKEN_SOURCE);
    assert.doesNotMatch(
      await git(executable, workspace, ["config", "--local", "--list"]),
      /minicode\.resetsentinel|reset-config-9c44/iu,
    );
    await assert.rejects(fs.access(path.join(workspace, "reset-untracked.txt")));
    assert.doesNotMatch(await fs.readFile(path.join(workspace, "README.md"), "utf8"), /RESET_STAGED_CONTENT_7D31/u);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepare:edit-smoke 拒绝经目录链接写入 fixture 模板", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-edit-link-"));
  const linkedTemplate = path.join(tempRoot, "linked-template");
  const escapedChild = path.join(linkedTemplate, "must-not-exist");
  let linkCreated = false;
  try {
    await fs.symlink(
      path.join(projectRoot, "fixtures", "edit-smoke"),
      linkedTemplate,
      process.platform === "win32" ? "junction" : "dir",
    );
    linkCreated = true;

    await assert.rejects(
      execFileAsync(process.execPath, [prepareScript, "--output", escapedChild], {
        cwd: projectRoot,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }),
      (error: Error & { stderr?: string }) => {
        assert.match(`${error.message}\n${error.stderr ?? ""}`, /不能与模板目录重叠/u);
        return true;
      },
    );
    await assert.rejects(fs.access(escapedChild));
    await assert.rejects(fs.access(path.join(projectRoot, "fixtures", "edit-smoke", "must-not-exist")));
  } finally {
    if (linkCreated) await fs.unlink(linkedTemplate);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("生产 guided TUI 在同一任务完成搜索、确认编辑、真实测试和 Git 只读收尾", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-edit-e2e-"));
  let app: MiniTuiApp | undefined;
  let task: Promise<void> | undefined;
  try {
    const workspace = await prepareWorkspace(tempRoot, "workspace");
    const auditPath = path.join(tempRoot, "audit.jsonl");
    const targetPath = path.join(workspace, "src", "greeting.js");
    const executable = await resolveGitExecutable(workspace);
    const headBefore = await git(executable, workspace, ["rev-parse", "HEAD"]);
    const branchBefore = await git(executable, workspace, ["branch", "--show-current"]);
    const indexBefore = await fs.readFile(path.join(workspace, ".git", "index"));
    const terminal = new FakeTerminal();
    const model = new SuccessChainModel();
    const observedEvents: AgentEvent[] = [];
    app = createMiniTui(
      [
        "--workspace",
        workspace,
        "--audit",
        auditPath,
        "--profile",
        "deepseek",
        "--mode",
        "edit",
        "--guided",
      ],
      terminal,
      {
        model,
        onAgentEvent: (event) => observedEvents.push(event),
      },
    );

    app.start();
    task = app.submit("修复 greeting 缺少感叹号的问题，运行测试，并检查 Git 状态与未暂存差异。");

    await waitFor(() => app?.awaitingPlanApproval === true && stripAnsi(terminal.output).includes("待确认计划"));
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.equal(observedEvents.some((event) => event.type === "tool_call"), false);
    await app.submit("CONTINUE");

    await waitFor(
      () => app?.approvalPrompt === "APPLY / CANCEL" && stripAnsi(terminal.output).includes("待确认补丁"),
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["search_text", "read_file", "apply_patch"],
    );
    assert.equal(
      observedEvents.some(
        (event) => event.type === "tool_finalized" && event.toolCallId === "e2e-patch",
      ),
      false,
      "APPLY 前补丁不得产生成功或失败终态",
    );
    await app.submit("APPLY");

    await waitFor(
      () => app?.awaitingCommandApproval === true && stripAnsi(terminal.output).includes("待确认验证"),
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), FIXED_SOURCE);
    assert.equal(
      observedEvents.some(
        (event) => event.type === "tool_execution_started" && event.toolName === "run_project_check",
      ),
      false,
    );
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    await app.submit("RUN");

    await task;
    await waitFor(
      () => app?.running === false && stripAnsi(terminal.output).includes("修改摘要：为 src/greeting.js"),
    );
    const output = stripAnsi(terminal.output);
    assert.match(output, /修改摘要：为 src\/greeting\.js/);
    assert.match(output, /验证结果：npm test 已通过/);
    assert.match(output, /未执行暂存或 commit/);
    assert.equal(app.contextTurns, 1);
    assert.equal(model.requests.length, 8);

    assert.deepEqual(
      observedEvents.filter((event) => event.type === "model_requested").map((event) => event.step),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["search_text", "read_file", "apply_patch", "run_project_check", "inspect_git", "inspect_git"],
    );
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_finalized").map((event) => [event.toolName, event.status]),
      [
        ["search_text", "success"],
        ["read_file", "success"],
        ["apply_patch", "success"],
        ["run_project_check", "success"],
        ["inspect_git", "success"],
        ["inspect_git", "success"],
      ],
    );
    assert.equal(observedEvents.some((event) => event.type === "agent_stopped"), false);
    assert.equal(observedEvents.at(-1)?.type, "agent_completed");

    const planProposedIndex = eventIndex(observedEvents, (event) => event.type === "plan_proposed");
    const planApprovedIndex = eventIndex(
      observedEvents,
      (event) => event.type === "plan_decision" && event.decision === "approved",
    );
    const firstToolIndex = eventIndex(observedEvents, (event) => event.type === "tool_call");
    assert.ok(planProposedIndex < planApprovedIndex && planApprovedIndex < firstToolIndex);

    const approvalRequestedIndex = eventIndex(
      observedEvents,
      (event) => event.type === "command_approval_requested" && event.toolCallId === "e2e-test",
    );
    const approvalDecisionIndex = eventIndex(
      observedEvents,
      (event) =>
        event.type === "command_approval_decision" &&
        event.toolCallId === "e2e-test" &&
        event.decision === "approved",
    );
    const checkStartedIndex = eventIndex(
      observedEvents,
      (event) => event.type === "tool_execution_started" && event.toolCallId === "e2e-test",
    );
    const checkPolicyIndex = eventIndex(
      observedEvents,
      (event) =>
        event.type === "policy_decision" &&
        event.toolCallId === "e2e-test" &&
        event.decision === "allowed",
    );
    const checkFinalizedIndex = eventIndex(
      observedEvents,
      (event) =>
        event.type === "tool_finalized" &&
        event.toolCallId === "e2e-test" &&
        event.status === "success",
    );
    assert.ok(approvalRequestedIndex < approvalDecisionIndex);
    assert.ok(approvalDecisionIndex < checkStartedIndex);
    assert.ok(checkStartedIndex < checkFinalizedIndex);
    assert.ok(checkPolicyIndex < checkFinalizedIndex);

    const checkFinalized = observedEvents.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "e2e-test",
    );
    assert.equal(checkFinalized?.type, "tool_finalized");
    if (checkFinalized?.type !== "tool_finalized") throw new Error("缺少验证完成事件。");
    assert.equal(checkFinalized.metadata?.action, "test");
    assert.equal(checkFinalized.metadata?.exitCode, 0);
    assert.equal(checkFinalized.metadata?.timedOut, false);
    assert.ok((checkFinalized.metadata?.outputLength ?? 0) > 0);

    const gitFinalized = observedEvents.filter(
      (event): event is Extract<AgentEvent, { type: "tool_finalized" }> =>
        event.type === "tool_finalized" && event.toolName === "inspect_git",
    );
    assert.deepEqual(gitFinalized.map((event) => event.metadata?.action), ["git_status", "git_diff"]);
    assert.deepEqual(gitFinalized.map((event) => event.metadata?.exitCode), [0, 0]);

    assert.equal(await fs.readFile(targetPath, "utf8"), FIXED_SOURCE);
    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(await git(executable, workspace, ["branch", "--show-current"]), branchBefore);
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    assert.equal(
      await git(executable, workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "M src/greeting.js",
    );
    assert.equal(await git(executable, workspace, ["diff", "--cached", "--name-only"]), "");
    const finalDiff = await git(executable, workspace, ["diff", "--", "src/greeting.js"]);
    assert.ok(finalDiff.includes(DIFF_SENTINEL));
    assert.ok(finalDiff.includes(NEW_PATCH_SENTINEL));
    assert.equal((await fs.readdir(path.join(workspace, "src"))).some((name) => name.includes(".minicode-")), false);

    const rawAudit = await fs.readFile(auditPath, "utf8");
    const auditEvents = rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(auditEvents.some((event) => event.type === "plan_decision" && event.planDecision === "approved"), true);
    assert.equal(
      auditEvents.some(
        (event) => event.type === "command_approval_decision" && event.commandDecision === "approved",
      ),
      true,
    );
    assert.equal(auditEvents.filter((event) => event.type === "tool_finalized").length, 6);
    assert.equal(auditEvents.at(-1)?.type, "agent_completed");
    const auditStrings = collectStringValues(auditEvents);
    const forbiddenWorkspacePaths = [path.resolve(workspace), await fs.realpath(workspace)].map(
      normalizePathForComparison,
    );
    const positiveLeakProbe = [{ nested: { value: `prefix/${workspace.toUpperCase()}\\suffix` } }];
    assert.equal(
      containsNormalizedPath(positiveLeakProbe, workspace),
      true,
      "审计路径检测器必须能识别大小写和分隔符不同的 Windows 路径",
    );
    for (const value of auditStrings) {
      const normalizedValue = normalizePathForComparison(value);
      for (const forbiddenPath of forbiddenWorkspacePaths) {
        assert.equal(
          normalizedValue.includes(forbiddenPath),
          false,
          `审计字符串泄漏了绝对工作区路径：${value}`,
        );
      }
    }
    for (const sentinel of [OLD_PATCH_SENTINEL, NEW_PATCH_SENTINEL, DIFF_SENTINEL, TEST_OUTPUT_SENTINEL]) {
      assert.equal(rawAudit.includes(sentinel), false, `审计不应保存正文 sentinel：${sentinel}`);
    }
  } finally {
    app?.stop();
    await task?.catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("生产 guided TUI 在六次工具内完成真实失败、修复方向确认、复验和 Git 收尾", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-repair-e2e-"));
  let app: MiniTuiApp | undefined;
  let task: Promise<void> | undefined;
  try {
    const workspace = await prepareWorkspace(tempRoot, "workspace");
    const auditPath = path.join(tempRoot, "audit.jsonl");
    const targetPath = path.join(workspace, "src", "greeting.js");
    const executable = await resolveGitExecutable(workspace);
    const headBefore = await git(executable, workspace, ["rev-parse", "HEAD"]);
    const branchBefore = await git(executable, workspace, ["branch", "--show-current"]);
    const indexBefore = await fs.readFile(path.join(workspace, ".git", "index"));
    const terminal = new FakeTerminal();
    const model = new FailureRepairChainModel();
    const observedEvents: AgentEvent[] = [];
    app = createMiniTui(
      [
        "--workspace",
        workspace,
        "--audit",
        auditPath,
        "--profile",
        "deepseek",
        "--mode",
        "edit",
        "--guided",
      ],
      terminal,
      {
        model,
        onAgentEvent: (event) => observedEvents.push(event),
      },
    );

    app.start();
    task = app.submit(
      "先运行 test 复现 greeting 的已知失败；失败后先给出修复方向并等待确认，再做最小修复、复验并检查 Git status/diff。",
    );

    await waitFor(() => app?.awaitingPlanApproval === true && stripAnsi(terminal.output).includes("待确认计划"));
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.equal(observedEvents.some((event) => event.type === "tool_call"), false);
    await app.submit("CONTINUE");

    await waitFor(
      () => app?.awaitingCommandApproval === true && stripAnsi(terminal.output).includes("待确认验证"),
    );
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_project_check"],
    );
    assert.equal(
      observedEvents.some(
        (event) => event.type === "tool_execution_started" && event.toolCallId === "repair-initial-test",
      ),
      false,
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), headBefore);
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    await app.submit("RUN");

    await waitFor(
      () => app?.awaitingRepairApproval === true && stripAnsi(terminal.output).includes("待确认修复方向"),
    );
    const initialFailure = observedEvents.find(
      (event) => event.type === "tool_finalized" && event.toolCallId === "repair-initial-test",
    );
    assert.equal(initialFailure?.type, "tool_finalized");
    if (initialFailure?.type !== "tool_finalized") throw new Error("缺少首次验证失败终态。");
    assert.equal(initialFailure.status, "error");
    assert.equal(initialFailure.metadata?.action, "test");
    assert.equal(initialFailure.metadata?.exitCode, 1);
    assert.equal(initialFailure.metadata?.timedOut, false);
    assert.equal(app.approvalPrompt, "CONTINUE / CANCEL");
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(await git(executable, workspace, ["branch", "--show-current"]), branchBefore);
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_project_check"],
      "确认修复方向前不得读取或修改文件",
    );
    await app.submit("CONTINUE");

    await waitFor(
      () => app?.approvalPrompt === "APPLY / CANCEL" && stripAnsi(terminal.output).includes("待确认补丁"),
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), BROKEN_SOURCE);
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_project_check", "read_file", "apply_patch"],
    );
    assert.equal(
      observedEvents.some(
        (event) => event.type === "tool_finalized" && event.toolCallId === "repair-patch",
      ),
      false,
      "APPLY 前修复补丁不得产生终态",
    );
    await app.submit("APPLY");

    await waitFor(
      () => app?.awaitingCommandApproval === true && stripAnsi(terminal.output).includes("待确认验证"),
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), FIXED_SOURCE);
    assert.equal(
      observedEvents.some(
        (event) => event.type === "tool_execution_started" && event.toolCallId === "repair-retest",
      ),
      false,
      "第二次 RUN 前不得启动复验进程",
    );
    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), headBefore);
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    await app.submit("RUN");

    await task;
    await waitFor(
      () => app?.running === false && stripAnsi(terminal.output).includes("首次 npm test 真实失败"),
    );
    const output = stripAnsi(terminal.output);
    assert.match(output, /待确认修复方向/);
    assert.match(output, /修复方向已确认/);
    assert.match(output, /首次 npm test 真实失败/);
    assert.match(output, /第二次 npm test 已通过/);
    assert.match(output, /未执行暂存或 commit/);
    assert.equal(app.contextTurns, 1);
    assert.equal(model.requests.length, 9);

    assert.deepEqual(
      observedEvents.filter((event) => event.type === "model_requested").map((event) => event.step),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["run_project_check", "read_file", "apply_patch", "run_project_check", "inspect_git", "inspect_git"],
    );
    assert.deepEqual(
      observedEvents.filter((event) => event.type === "tool_finalized").map((event) => [event.toolName, event.status]),
      [
        ["run_project_check", "error"],
        ["read_file", "success"],
        ["apply_patch", "success"],
        ["run_project_check", "success"],
        ["inspect_git", "success"],
        ["inspect_git", "success"],
      ],
    );
    assert.equal(observedEvents.filter((event) => event.type === "tool_call").length, 6);
    assert.equal(observedEvents.some((event) => event.type === "agent_stopped"), false);
    assert.equal(observedEvents.at(-1)?.type, "agent_completed");

    const initialFinalizedIndex = eventIndex(
      observedEvents,
      (event) => event.type === "tool_finalized" && event.toolCallId === "repair-initial-test",
    );
    const repairProposedIndex = eventIndex(observedEvents, (event) => event.type === "repair_proposed");
    const repairDecisionIndex = eventIndex(
      observedEvents,
      (event) => event.type === "repair_decision" && event.decision === "approved",
    );
    const readCallIndex = eventIndex(
      observedEvents,
      (event) => event.type === "tool_call" && event.toolCallId === "repair-read",
    );
    assert.ok(initialFinalizedIndex < repairProposedIndex);
    assert.ok(repairProposedIndex < repairDecisionIndex);
    assert.ok(repairDecisionIndex < readCallIndex);
    const repairProposed = observedEvents[repairProposedIndex];
    assert.equal(repairProposed.type, "repair_proposed");
    if (repairProposed.type !== "repair_proposed") throw new Error("缺少修复方向事件。");
    assert.equal(repairProposed.directionLength, REPAIR_DIRECTION.length);

    const verificationIds = ["repair-initial-test", "repair-retest"];
    const expectedExitCodes = [1, 0];
    for (const [index, toolCallId] of verificationIds.entries()) {
      const requested = eventIndex(
        observedEvents,
        (event) => event.type === "command_approval_requested" && event.toolCallId === toolCallId,
      );
      const approved = eventIndex(
        observedEvents,
        (event) =>
          event.type === "command_approval_decision" &&
          event.toolCallId === toolCallId &&
          event.decision === "approved",
      );
      const started = eventIndex(
        observedEvents,
        (event) => event.type === "tool_execution_started" && event.toolCallId === toolCallId,
      );
      const finalized = eventIndex(
        observedEvents,
        (event) => event.type === "tool_finalized" && event.toolCallId === toolCallId,
      );
      assert.ok(requested < approved && approved < started && started < finalized);
      const event = observedEvents[finalized];
      assert.equal(event.type, "tool_finalized");
      if (event.type !== "tool_finalized") throw new Error("缺少验证终态。");
      assert.equal(event.metadata?.exitCode, expectedExitCodes[index]);
      assert.equal(event.metadata?.timedOut, false);
    }

    const gitFinalized = observedEvents.filter(
      (event): event is Extract<AgentEvent, { type: "tool_finalized" }> =>
        event.type === "tool_finalized" && event.toolName === "inspect_git",
    );
    assert.deepEqual(gitFinalized.map((event) => event.metadata?.action), ["git_status", "git_diff"]);
    assert.deepEqual(gitFinalized.map((event) => event.metadata?.exitCode), [0, 0]);

    assert.equal(await fs.readFile(targetPath, "utf8"), FIXED_SOURCE);
    assert.equal(await git(executable, workspace, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(await git(executable, workspace, ["branch", "--show-current"]), branchBefore);
    assert.deepEqual(await fs.readFile(path.join(workspace, ".git", "index")), indexBefore);
    assert.equal(
      await git(executable, workspace, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "M src/greeting.js",
    );
    assert.equal(await git(executable, workspace, ["diff", "--cached", "--name-only"]), "");
    const finalDiff = await git(executable, workspace, ["diff", "--", "src/greeting.js"]);
    assert.ok(finalDiff.includes(DIFF_SENTINEL));
    assert.ok(finalDiff.includes(NEW_PATCH_SENTINEL));
    assert.equal((await fs.readdir(path.join(workspace, "src"))).some((name) => name.includes(".minicode-")), false);

    const rawAudit = await fs.readFile(auditPath, "utf8");
    const auditEvents = rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const repairProposalAudit = auditEvents.find((event) => event.type === "repair_proposed");
    assert.equal(repairProposalAudit?.directionLength, REPAIR_DIRECTION.length);
    assert.equal(
      auditEvents.some(
        (event) => event.type === "repair_decision" && event.repairDecision === "approved",
      ),
      true,
    );
    assert.equal(auditEvents.filter((event) => event.type === "repair_proposed").length, 1);
    assert.equal(auditEvents.filter((event) => event.type === "repair_decision").length, 1);
    assert.deepEqual(
      auditEvents
        .filter((event) => event.type === "tool_finalized" && event.toolName === "run_project_check")
        .map((event) => [event.status, event.exitCode]),
      [["error", 1], ["success", 0]],
    );
    assert.equal(auditEvents.filter((event) => event.type === "tool_finalized").length, 6);
    assert.equal(auditEvents.at(-1)?.type, "agent_completed");
    const auditStrings = collectStringValues(auditEvents);
    const forbiddenWorkspacePaths = [path.resolve(workspace), await fs.realpath(workspace)].map(
      normalizePathForComparison,
    );
    for (const value of auditStrings) {
      const normalizedValue = normalizePathForComparison(value);
      for (const forbiddenPath of forbiddenWorkspacePaths) {
        assert.equal(normalizedValue.includes(forbiddenPath), false, `审计字符串泄漏了绝对工作区路径：${value}`);
      }
    }
    for (const sentinel of [
      ...REPAIR_DIRECTION.split("\n"),
      OLD_PATCH_SENTINEL,
      NEW_PATCH_SENTINEL,
      DIFF_SENTINEL,
      TEST_OUTPUT_SENTINEL,
      EXPECTED_GREETING_SENTINEL,
    ]) {
      assert.equal(rawAudit.includes(sentinel), false, `修复审计不应保存正文 sentinel：${sentinel}`);
    }
  } finally {
    app?.stop();
    await task?.catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
