import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { AgentLoop } from "../src/agent/agent-loop.ts";
import type { ChatModel, JsonObject, ModelRequest, ModelResponse, ToolResultMessage } from "../src/agent/contracts.ts";
import { JsonlAuditLog } from "../src/agent/events.ts";
import { ToolRegistry } from "../src/agent/tool-registry.ts";
import { FakeModel } from "../src/models/fake-model.ts";
import type { BoundedProcessResult } from "../src/tools/child-process-safety.ts";
import {
  createInspectGitTool,
  inspectGit,
  resolveGitExecutable,
  type GitInspectionAction,
  type GitRunRequest,
  type GitRunner,
} from "../src/tools/inspect-git.ts";

const execFileAsync = promisify(execFile);

interface FakeGitRunner extends GitRunner {
  calls: GitRunRequest[];
  mainCalls: GitRunRequest[];
}

function processResult(
  output: string,
  exitCode: number | null = 0,
  overrides: Partial<BoundedProcessResult> = {},
): BoundedProcessResult {
  return {
    exitCode,
    durationMs: 7,
    output,
    outputLength: output.length,
    outputTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

async function createRepositoryShell(prefix = "minicode-git-"): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(workspace, ".git"));
  return workspace;
}

function fakeRunner(
  workspace: string,
  mainOutput: (request: GitRunRequest) => BoundedProcessResult = () => processResult(""),
): FakeGitRunner {
  const calls: GitRunRequest[] = [];
  const mainCalls: GitRunRequest[] = [];
  return {
    calls,
    mainCalls,
    async run(request): Promise<BoundedProcessResult> {
      calls.push(request);
      if (request.args.length === 1 && request.args[0] === "--version") {
        return processResult("git version 2.55.0.windows.2\n");
      }
      if (request.args.includes("rev-parse")) {
        return processResult(`${workspace}\n`);
      }
      if (request.args.includes("config")) {
        return processResult("", 1);
      }
      mainCalls.push(request);
      return mainOutput(request);
    },
  };
}

function toolContext(workspaceRoot: string, recordPolicyDecision?: (decision: { decision: "allowed" | "blocked"; path: string; reason: string }) => void) {
  return { task: "读取 Git 变更", step: 1, workspaceRoot, recordPolicyDecision };
}

function scriptedGitModel(input: JsonObject): ChatModel {
  let calls = 0;
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "tool_calls",
          content: "读取固定 Git 信息。",
          toolCalls: [{ id: "inspect-git-1", name: "inspect_git", input }],
        };
      }
      const result = request.messages.at(-1);
      assert.equal(result?.role, "tool");
      return { kind: "final", content: result?.status === "success" ? "Git 检查完成。" : "Git 检查失败。" };
    },
  };
}

test("inspect_git 只接受三个固定动作，不能注入路径或任意 Git 参数", () => {
  const tool = createInspectGitTool();
  for (const action of ["status", "diff", "staged_diff"] as const) {
    assert.deepEqual(tool.validate({ action }), { ok: true, value: { action } });
  }
  const invalidInputs: JsonObject[] = [
    { action: "commit" },
    { action: "add" },
    { action: "status", path: "src" },
    { action: "diff", args: ["--output=marker"] },
    {},
  ];
  for (const input of invalidInputs) {
    assert.equal(tool.validate(input).ok, false);
  }
});

test("三个动作映射为固定参数、根目录和脱敏环境，且不包含 Git 写操作", async () => {
  const workspace = await createRepositoryShell();
  const previousApiKey = process.env.MINICODE_OPENAI_API_KEY;
  const previousGitConfigCount = process.env.GIT_CONFIG_COUNT;
  process.env.MINICODE_OPENAI_API_KEY = "SENSITIVE_GIT_API_KEY_7A91";
  process.env.GIT_CONFIG_COUNT = "99";
  try {
    for (const action of ["status", "diff", "staged_diff"] as const) {
      const runner = fakeRunner(workspace, () => processResult(action === "status" ? "## main\n M src/app.ts\n" : "diff --git a/src/app.ts b/src/app.ts\n"));
      const decisions: string[] = [];
      const result = await createInspectGitTool(runner).execute(
        { action },
        toolContext(workspace, (decision) => decisions.push(`${decision.decision}:${decision.path}`)),
      );
      assert.equal(runner.mainCalls.length, 1);
      const main = runner.mainCalls[0];
      assert.equal(main.cwd, await fs.realpath(workspace));
      assert.equal(main.action, action === "status" ? "git_status" : action === "diff" ? "git_diff" : "git_staged_diff");
      assert.equal(main.env.MINICODE_OPENAI_API_KEY, undefined);
      assert.equal(main.env.GIT_CONFIG_COUNT, undefined);
      assert.equal(main.env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(main.env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(main.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(main.args.includes("--no-optional-locks"), true);
      assert.equal(main.args.includes("--no-lazy-fetch"), true);
      assert.equal(main.args.includes("core.fsmonitor=false"), true);
      assert.equal(main.args.includes(`core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`), true);
      assert.equal(main.args.includes(`core.excludesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`), true);
      assert.equal(main.args.includes("--no-pager"), true);
      assert.equal(runner.calls.filter((call) => call.args.includes("config")).every((call) => call.args.includes("--no-includes")), true);
      assert.equal(main.args.some((argument) => argument.includes(".env.*")), true);
      assert.equal(main.args.some((argument) => argument.includes("node_modules")), true);
      for (const forbidden of ["add", "commit", "checkout", "reset", "push", "switch", "restore"] ) {
        assert.equal(main.args.includes(forbidden), false);
      }
      if (action === "status") {
        assert.equal(main.args.includes("--porcelain=v1"), true);
        assert.equal(main.args.includes("--no-ahead-behind"), true);
      } else {
        assert.equal(main.args.includes("--no-ext-diff"), true);
        assert.equal(main.args.includes("--no-textconv"), true);
        assert.equal(main.args.includes("--cached"), action === "staged_diff");
      }
      assert.deepEqual(decisions, ["allowed:."]);
      assert.match(result.content, new RegExp(`Git 只读动作：${action}`));
    }
  } finally {
    if (previousApiKey === undefined) delete process.env.MINICODE_OPENAI_API_KEY;
    else process.env.MINICODE_OPENAI_API_KEY = previousApiKey;
    if (previousGitConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previousGitConfigCount;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("只把三项白名单换行配置投影到隔离的 Git 主调用", async () => {
  const workspace = await createRepositoryShell();
  const runner = fakeRunner(workspace, () => processResult("## main\n"));
  runner.run = async (request): Promise<BoundedProcessResult> => {
    runner.calls.push(request);
    if (request.args.length === 1 && request.args[0] === "--version") {
      return processResult("git version 2.55.0\n");
    }
    if (request.args.includes("rev-parse")) return processResult(`${workspace}\n`);
    if (
      request.args.includes("config") &&
      request.args.includes("--no-includes") &&
      request.args.some((argument) => argument.includes("autocrlf"))
    ) {
      return processResult([
        "core.autocrlf true",
        "core.eol CRLF",
        "core.safecrlf warn",
        "alias.status !SENSITIVE_CONFIG_COMMAND",
        "core.hooksPath SENSITIVE_HOOK_PATH",
        "core.eol SENSITIVE_INVALID_VALUE",
        "",
      ].join("\n"));
    }
    if (request.args.includes("config")) return processResult("", 1);
    runner.mainCalls.push(request);
    return processResult("## main\n");
  };

  try {
    await createInspectGitTool(runner).execute({ action: "status" }, toolContext(workspace));
    const safeProbe = runner.calls.find((call) => call.args.includes("--no-includes"));
    assert.ok(safeProbe);
    assert.equal(safeProbe.env.GIT_CONFIG_GLOBAL, undefined);
    assert.equal(safeProbe.args.includes("--no-lazy-fetch"), true);

    assert.equal(runner.mainCalls.length, 1);
    const main = runner.mainCalls[0];
    const projectedConfiguration = main.args.filter((_, index) => main.args[index - 1] === "-c");
    assert.equal(projectedConfiguration.includes("core.autocrlf=true"), true);
    assert.equal(projectedConfiguration.includes("core.safecrlf=warn"), true);
    assert.equal(projectedConfiguration.some((value) => value.startsWith("core.eol=")), false);
    assert.equal(projectedConfiguration.some((value) => /SENSITIVE_CONFIG|SENSITIVE_HOOK/iu.test(value)), false);
    assert.notEqual(main.env.GIT_CONFIG_GLOBAL, undefined);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Git 2.44 与仓库 include 配置会在主检查前闭锁", async () => {
  const oldGitWorkspace = await createRepositoryShell("minicode-git-old-version-");
  const oldGitRunner = fakeRunner(oldGitWorkspace);
  oldGitRunner.run = async (request): Promise<BoundedProcessResult> => {
    oldGitRunner.calls.push(request);
    return processResult("git version 2.44.9\n");
  };
  try {
    await assert.rejects(
      createInspectGitTool(oldGitRunner).execute({ action: "status" }, toolContext(oldGitWorkspace)),
      /需要 Git 2\.45 或更高版本/,
    );
    assert.equal(oldGitRunner.calls.length, 1);
    assert.equal(oldGitRunner.mainCalls.length, 0);
  } finally {
    await fs.rm(oldGitWorkspace, { recursive: true, force: true });
  }

  for (const fileName of ["config", "config.worktree"] as const) {
    const workspace = await createRepositoryShell("minicode-git-include-");
    const runner = fakeRunner(workspace);
    try {
      await fs.writeFile(
        path.join(workspace, ".git", fileName),
        fileName === "config"
          ? "[include]\n\tpath = //server/share/unsafe-config\n"
          : '[includeIf "gitdir:**"]\n\tpath = //server/share/unsafe-config\n',
        "utf8",
      );
      await assert.rejects(
        createInspectGitTool(runner).execute({ action: "diff" }, toolContext(workspace)),
        /包含 include 或 includeIf/,
      );
      assert.equal(runner.calls.length, 0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }
});

test("仓库外部对象库在启动 Git 前闭锁", async () => {
  const workspace = await createRepositoryShell("minicode-git-alternates-");
  const runner = fakeRunner(workspace);
  try {
    const infoDirectory = path.join(workspace, ".git", "objects", "info");
    await fs.mkdir(infoDirectory, { recursive: true });
    await fs.writeFile(path.join(infoDirectory, "alternates"), "//server/share/objects\n", "utf8");
    await assert.rejects(
      createInspectGitTool(runner).execute({ action: "status" }, toolContext(workspace)),
      /声明了外部 Git 对象库/,
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("非仓库、父级仓库子目录和 linked worktree 在启动 Git 前闭锁", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-git-boundary-"));
  const child = path.join(parent, "child");
  await fs.mkdir(path.join(parent, ".git"));
  await fs.mkdir(child);
  const linked = path.join(parent, "linked");
  await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, ".git"), "gitdir: ../.git/worktrees/linked\n", "utf8");
  const runner = fakeRunner(child);
  try {
    for (const workspace of [child, linked]) {
      await assert.rejects(
        createInspectGitTool(runner).execute({ action: "status" }, toolContext(workspace)),
        /只支持工作区根目录内包含普通 \.git 目录/,
      );
    }
    assert.equal(runner.calls.length, 0);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("Git 根目录不一致或存在外部 filter/diff driver 时不会执行主检查", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-git-preflight-"));
  const workspace = path.join(parent, "workspace");
  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  try {
    const wrongRootRunner = fakeRunner(parent);
    await assert.rejects(
      createInspectGitTool(wrongRootRunner).execute({ action: "diff" }, toolContext(workspace)),
      /工作区必须与 Git 仓库根目录完全一致/,
    );
    assert.equal(wrongRootRunner.mainCalls.length, 0);

    const ownershipRunner = fakeRunner(workspace);
    ownershipRunner.run = async (request): Promise<BoundedProcessResult> => {
      ownershipRunner.calls.push(request);
      if (request.args.length === 1 && request.args[0] === "--version") return processResult("git version 2.55.0\n");
      if (request.args.includes("rev-parse")) {
        return processResult("fatal: detected dubious ownership; add safe.directory to continue\n", 128);
      }
      ownershipRunner.mainCalls.push(request);
      return processResult("SHOULD_NOT_RUN");
    };
    await assert.rejects(
      createInspectGitTool(ownershipRunner).execute({ action: "status" }, toolContext(workspace)),
      (error: Error) => {
        assert.match(error.message, /不会绕过该安全检查/);
        assert.doesNotMatch(error.message, /检查 safe\.directory 后重试/);
        return true;
      },
    );
    assert.equal(ownershipRunner.mainCalls.length, 0);

    const marker = "SENSITIVE_FILTER_COMMAND_2F41";
    const filterRunner = fakeRunner(workspace);
    filterRunner.run = async (request): Promise<BoundedProcessResult> => {
      filterRunner.calls.push(request);
      if (request.args.length === 1 && request.args[0] === "--version") return processResult("git version 2.55.0\n");
      if (request.args.includes("rev-parse")) return processResult(`${workspace}\n`);
      if (request.args.includes("config")) return processResult(`filter.evil.process ${marker}\n`, 0);
      filterRunner.mainCalls.push(request);
      return processResult("SHOULD_NOT_RUN");
    };
    await assert.rejects(
      createInspectGitTool(filterRunner).execute({ action: "diff" }, toolContext(workspace)),
      (error: Error) => {
        assert.match(error.message, /可能启动外部进程/);
        assert.doesNotMatch(error.message, new RegExp(marker));
        return true;
      },
    );
    assert.equal(filterRunner.mainCalls.length, 0);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("空结果、截断、非零退出和超时形成明确终态与安全元数据", async () => {
  const workspace = await createRepositoryShell();
  const cases: Array<{
    action: GitInspectionAction;
    result: BoundedProcessResult;
    message: RegExp;
    succeeds: boolean;
  }> = [
    { action: "status", result: processResult("## main\n"), message: /工作区干净/, succeeds: true },
    { action: "diff", result: processResult("", 0, { outputTruncated: true, outputLength: 50_000 }), message: /输出已截断/, succeeds: true },
    { action: "diff", result: processResult("SENSITIVE_GIT_STDERR", 7), message: /底层错误输出未发送给模型/, succeeds: false },
    { action: "staged_diff", result: processResult("", null, { timedOut: true }), message: /检查超时/, succeeds: false },
  ];
  try {
    for (const gitCase of cases) {
      const runner = fakeRunner(workspace, () => gitCase.result);
      const promise = createInspectGitTool(runner).execute({ action: gitCase.action }, toolContext(workspace));
      if (gitCase.succeeds) {
        const output = await promise;
        assert.match(output.content, gitCase.message);
        assert.equal(output.metadata?.outputLength, gitCase.result.outputLength);
      } else {
        await assert.rejects(promise, (error: Error) => {
          assert.match(error.message, gitCase.message);
          assert.doesNotMatch(error.message, /SENSITIVE_GIT_STDERR/);
          return true;
        });
      }
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("AgentLoop 的 Git 读取不请求 RUN，审计不保存 diff、文件名或绝对目录", async () => {
  const workspace = await createRepositoryShell();
  const auditPath = path.join(workspace, "audit", "inspect-git.jsonl");
  const secretOutput = "diff --git a/src/SENSITIVE_AUDIT_FILE.ts b/src/SENSITIVE_AUDIT_FILE.ts\n+SENSITIVE_DIFF_BODY_1D88\n";
  const runner = fakeRunner(workspace, () => processResult(secretOutput));
  let approvalCalls = 0;
  try {
    const result = await new AgentLoop(
      scriptedGitModel({ action: "diff" }),
      new ToolRegistry([createInspectGitTool(runner)]),
      {
        workspaceRoot: workspace,
        auditLog: new JsonlAuditLog(auditPath),
        requestCommandApproval: async () => {
          approvalCalls += 1;
          return true;
        },
      },
    ).run("读取 Git diff。");
    assert.equal(approvalCalls, 0);
    assert.equal(runner.mainCalls.length, 1);
    assert.equal(result.events.some((event) => event.type === "command_approval_requested"), false);
    assert.deepEqual(
      result.events.filter((event) => !["model_requested", "agent_completed"].includes(event.type)).map((event) => event.type),
      ["tool_call", "tool_execution_started", "policy_decision", "tool_finalized"],
    );
    const rawAudit = await fs.readFile(auditPath, "utf8");
    assert.doesNotMatch(rawAudit, /SENSITIVE_AUDIT_FILE|SENSITIVE_DIFF_BODY/);
    assert.equal(rawAudit.includes(workspace), false);
    const finalized = rawAudit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === "tool_finalized");
    assert.equal(finalized?.action, "git_diff");
    assert.equal(finalized?.outputLength, secretOutput.length);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 可依次读取 status 与 diff，并只给紧凑总结", async () => {
  const workspace = await createRepositoryShell();
  const secretBody = "SENSITIVE_FAKE_DIFF_BODY_5E02";
  const statusItems = Array.from({ length: 10 }, (_, index) => ` M src/example-${index + 1}.ts`).join("\n");
  const runner = fakeRunner(workspace, (request) => request.args.includes("status")
    ? processResult(`## main\n${statusItems}\n`)
    : processResult(
        `diff --git a/src/example.ts b/src/example.ts\n+${secretBody}\n`,
        0,
        { outputTruncated: true },
      ));
  try {
    const result = await new AgentLoop(
      new FakeModel(),
      new ToolRegistry([createInspectGitTool(runner)]),
      { workspaceRoot: workspace },
    ).run("请查看 Git status 和未暂存 diff 并汇报。");
    assert.equal(runner.mainCalls.length, 2);
    assert.deepEqual(
      result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["inspect_git", "inspect_git"],
    );
    assert.match(result.answer, /Git 只读检查闭环已完成/);
    assert.match(result.answer, /仅展示前 8 项、另有 2 项/);
    assert.match(result.answer, /src\/example-1\.ts/);
    assert.doesNotMatch(result.answer, /src\/example-9\.ts/);
    assert.match(result.answer, /Git 原始输出已截断，摘要不完整/);
    assert.match(result.answer, /涉及文件：src\/example\.ts/);
    assert.match(result.answer, /手动 commit/);
    assert.doesNotMatch(result.answer, new RegExp(secretBody));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 在 guided 计划确认后仍按原始 Git task 执行只读检查", async () => {
  const workspace = await createRepositoryShell();
  const runner = fakeRunner(workspace, (request) => request.args.includes("status")
    ? processResult("## main\n M src/guided.ts\n")
    : processResult("diff --git a/src/guided.ts b/src/guided.ts\n+guided change\n"));
  let planApprovalCalls = 0;
  try {
    const result = await new AgentLoop(
      new FakeModel(),
      new ToolRegistry([createInspectGitTool(runner)]),
      {
        workspaceRoot: workspace,
        requirePlanApproval: true,
        requestPlanApproval: async ({ plan }) => {
          planApprovalCalls += 1;
          assert.match(plan, /执行计划/);
          return true;
        },
      },
    ).run("请查看 Git status 和未暂存 diff 并汇报。");

    assert.equal(planApprovalCalls, 1);
    assert.equal(runner.mainCalls.length, 2);
    assert.deepEqual(
      result.events.filter((event) => event.type === "tool_call").map((event) => event.toolName),
      ["inspect_git", "inspect_git"],
    );
    assert.match(result.answer, /Git 只读检查闭环已完成/);
    assert.match(result.answer, /src\/guided\.ts/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("FakeModel 也识别工具元数据中的 Git 输出截断状态", async () => {
  const model = new FakeModel();
  const response = await model.complete({
    messages: [
      { role: "user", content: "请查看 Git diff 并汇报。" },
      {
        role: "tool",
        toolCallId: "call-inspect-git-diff-metadata",
        name: "inspect_git",
        status: "success",
        content: [
          "Git 只读动作：diff",
          "范围：工作区根目录",
          "结果：",
          "diff --git a/src/metadata.ts b/src/metadata.ts",
          "+SENSITIVE_METADATA_DIFF_BODY_332A",
        ].join("\n"),
        metadata: { outputTruncated: true },
      } as ToolResultMessage & { metadata: { outputTruncated: boolean } },
    ],
    tools: [{ name: "inspect_git", description: "", parameters: {} }],
    workingState: "",
    phase: "execution",
  });

  assert.equal(response.kind, "final");
  assert.match(response.content, /Git 原始输出已截断，摘要不完整/);
  assert.match(response.content, /src\/metadata\.ts/);
  assert.doesNotMatch(response.content, /SENSITIVE_METADATA_DIFF_BODY/);
});

async function git(executable: string, cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

test("真实 Git 检查排除受保护内容，且不改变 HEAD、分支或 index", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-git-real-"));
  const executable = await resolveGitExecutable(workspace);
  try {
    await git(executable, workspace, ["init", "--quiet"]);
    await git(executable, workspace, ["config", "user.email", "minicode@example.invalid"]);
    await git(executable, workspace, ["config", "user.name", "MiniCode Test"]);
    await fs.mkdir(path.join(workspace, "src"));
    await fs.mkdir(path.join(workspace, "nested"));
    await fs.mkdir(path.join(workspace, "node_modules", "fixture"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "app.ts"), "export const value = 'baseline';\n", "utf8");
    await fs.writeFile(path.join(workspace, ".gitattributes"), "*.ts filter=evil\n", "utf8");
    await fs.writeFile(
      path.join(workspace, "filter-marker.mjs"),
      "import fs from 'node:fs'; fs.writeFileSync('filter-ran.txt', 'unsafe');\n",
      "utf8",
    );
    await fs.writeFile(path.join(workspace, ".ENV"), "ROOT_SECRET_BASELINE\n", "utf8");
    await fs.writeFile(path.join(workspace, ".npmrc"), "NPM_SECRET_BASELINE\n", "utf8");
    await fs.writeFile(path.join(workspace, "nested", ".Env.Local"), "NESTED_SECRET_BASELINE\n", "utf8");
    await fs.writeFile(path.join(workspace, "nested", ".Pypirc"), "PYPI_SECRET_BASELINE\n", "utf8");
    await fs.writeFile(path.join(workspace, "node_modules", "fixture", "secret.js"), "MODULE_SECRET_BASELINE\n", "utf8");
    await git(executable, workspace, ["add", "--all"]);
    await git(executable, workspace, ["commit", "--quiet", "-m", "baseline"]);

    const headBefore = (await git(executable, workspace, ["rev-parse", "HEAD"])).trim();
    const branchBefore = (await git(executable, workspace, ["branch", "--show-current"])).trim();
    await fs.writeFile(path.join(workspace, "src", "app.ts"), "export const value = 'VISIBLE_CHANGE';\n", "utf8");
    await fs.writeFile(path.join(workspace, "src", "new.ts"), "export const added = true;\n", "utf8");
    await fs.writeFile(path.join(workspace, ".ENV"), "ROOT_SECRET_CHANGED_91AA\n", "utf8");
    await fs.writeFile(path.join(workspace, ".npmrc"), "NPM_SECRET_CHANGED_A4D2\n", "utf8");
    await fs.writeFile(path.join(workspace, "nested", ".Env.Local"), "NESTED_SECRET_CHANGED_72BB\n", "utf8");
    await fs.writeFile(path.join(workspace, "nested", ".Pypirc"), "PYPI_SECRET_CHANGED_C6E3\n", "utf8");
    await fs.writeFile(path.join(workspace, "node_modules", "fixture", "secret.js"), "MODULE_SECRET_CHANGED_53CC\n", "utf8");

    await git(executable, workspace, ["config", "filter.evil.clean", "node filter-marker.mjs"]);
    await assert.rejects(
      inspectGit.execute({ action: "diff" }, toolContext(workspace)),
      /可能启动外部进程的 Git filter/,
    );
    await assert.rejects(fs.access(path.join(workspace, "filter-ran.txt")));
    await git(executable, workspace, ["config", "--unset-all", "filter.evil.clean"]);

    await git(executable, workspace, ["config", "extensions.worktreeConfig", "true"]);
    await git(executable, workspace, ["config", "--worktree", "filter.evil.clean", "node filter-marker.mjs"]);
    await assert.rejects(
      inspectGit.execute({ action: "status" }, toolContext(workspace)),
      /可能启动外部进程的 Git filter/,
    );
    await assert.rejects(fs.access(path.join(workspace, "filter-ran.txt")));
    await git(executable, workspace, ["config", "--worktree", "--unset-all", "filter.evil.clean"]);

    const indexBefore = await fs.readFile(path.join(workspace, ".git", "index"));
    const status = await inspectGit.execute({ action: "status" }, toolContext(workspace));
    const diff = await inspectGit.execute({ action: "diff" }, toolContext(workspace));
    const indexAfterWorkingChecks = await fs.readFile(path.join(workspace, ".git", "index"));
    assert.deepEqual(indexAfterWorkingChecks, indexBefore);
    assert.match(status.content, /src\/app\.ts/);
    assert.match(status.content, /src\/new\.ts/);
    assert.doesNotMatch(status.content, /\.ENV|\.npmrc|nested\/\.Env\.Local|nested\/\.Pypirc|node_modules\/fixture|ROOT_SECRET|NPM_SECRET|NESTED_SECRET|PYPI_SECRET|MODULE_SECRET/);
    assert.match(diff.content, /VISIBLE_CHANGE/);
    assert.doesNotMatch(diff.content, /ROOT_SECRET|NPM_SECRET|NESTED_SECRET|PYPI_SECRET|MODULE_SECRET|\.npmrc|nested\/\.env\.local|nested\/\.pypirc|node_modules\/fixture/);

    await git(executable, workspace, ["add", "--all"]);
    const indexBeforeStagedCheck = await fs.readFile(path.join(workspace, ".git", "index"));
    const stagedDiff = await inspectGit.execute({ action: "staged_diff" }, toolContext(workspace));
    const indexAfterStagedCheck = await fs.readFile(path.join(workspace, ".git", "index"));
    assert.deepEqual(indexAfterStagedCheck, indexBeforeStagedCheck);
    assert.match(stagedDiff.content, /VISIBLE_CHANGE/);
    assert.doesNotMatch(stagedDiff.content, /ROOT_SECRET|NPM_SECRET|NESTED_SECRET|PYPI_SECRET|MODULE_SECRET|\.npmrc|nested\/\.env\.local|nested\/\.pypirc|node_modules\/fixture/);

    assert.equal((await git(executable, workspace, ["rev-parse", "HEAD"])).trim(), headBefore);
    assert.equal((await git(executable, workspace, ["branch", "--show-current"])).trim(), branchBefore);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("真实全局 core.autocrlf 会被安全投影，不制造 CRLF 假修改", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-git-autocrlf-"));
  const workspace = path.join(fixtureRoot, "workspace");
  const configHome = path.join(fixtureRoot, "home");
  await fs.mkdir(workspace);
  await fs.mkdir(configHome);
  const executable = await resolveGitExecutable(workspace);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = configHome;
  process.env.USERPROFILE = configHome;
  delete process.env.XDG_CONFIG_HOME;
  try {
    await fs.writeFile(path.join(configHome, ".gitconfig"), "[core]\n\tautocrlf = true\n", "utf8");
    await git(executable, workspace, ["init", "--quiet"]);
    await git(executable, workspace, ["config", "user.email", "minicode@example.invalid"]);
    await git(executable, workspace, ["config", "user.name", "MiniCode Test"]);
    await fs.writeFile(path.join(workspace, "windows.txt"), "first\r\nsecond\r\n", "utf8");
    await git(executable, workspace, ["add", "windows.txt"]);
    await git(executable, workspace, ["commit", "--quiet", "-m", "crlf baseline"]);

    assert.equal((await git(executable, workspace, ["status", "--porcelain=v1"])).trim(), "");
    const result = await inspectGit.execute({ action: "status" }, toolContext(workspace));
    assert.match(result.content, /工作区干净/);
    assert.doesNotMatch(result.content, /windows\.txt/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});
