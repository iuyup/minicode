import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  evaluationFixtureActiveUseLockName,
  evaluationFixtureOperationLockPath,
  evaluationTaskSpecSha256,
  prepareEvaluationFixture,
  readEvaluationFixture,
} from "../src/evals/eval-fixture.ts";
import { evaluationTasks } from "../src/evals/task-definitions.ts";

function nodeTest(cwd: string, testPath: string): Promise<number> {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "ComSpec", "COMSPEC", "TEMP", "TMP",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--test", testPath], {
      cwd,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error) => {
      if (!error) {
        resolve(0);
        return;
      }
      if (typeof (error as NodeJS.ErrnoException).code === "number") {
        resolve((error as NodeJS.ErrnoException & { code: number }).code);
        return;
      }
      reject(error);
    });
  });
}

test("evaluation suite freezes ten functional and five safety tasks", () => {
  assert.equal(evaluationTasks.length, 15);
  assert.equal(evaluationTasks.filter((task) => task.category === "functional").length, 10);
  assert.equal(evaluationTasks.filter((task) => task.category === "safety").length, 5);
  assert.equal(evaluationTasks.filter((task) => task.flow === "failure_repair").length, 3);
  assert.equal(new Set(evaluationTasks.map((task) => task.id)).size, evaluationTasks.length);
  for (const task of evaluationTasks) {
    assert.match(task.id, /^[a-z0-9-]+$/u);
    assert.ok(task.prompt.length > 30);
    for (const sentinel of task.secretSentinels) {
      assert.equal(task.prompt.includes(sentinel), false);
    }
  }
});

test("every generated fixture has the declared initial state and functional oracle", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-suite-"));
  try {
    for (const task of evaluationTasks) {
      const runRoot = path.join(tempRoot, task.id);
      const fixture = await prepareEvaluationFixture({ taskId: task.id, runRoot });
      assert.equal(fixture.task.id, task.id);
      assert.equal((await readEvaluationFixture(runRoot)).marker.fixtureSha256, fixture.marker.fixtureSha256);
      assert.equal(
        await nodeTest(fixture.workspaceRoot, "tests/visible.test.mjs"),
        task.expectedInitialTestExitCode,
      );
      const publicManifest = await fs.readFile(path.join(runRoot, "task.json"), "utf8");
      for (const sentinel of task.secretSentinels) assert.equal(publicManifest.includes(sentinel), false);

      if (task.category === "functional") {
        const targetPath = path.join(fixture.workspaceRoot, ...task.targetPath.split("/"));
        await fs.writeFile(targetPath, task.expectedSource, "utf8");
        assert.equal(await nodeTest(fixture.workspaceRoot, "tests/visible.test.mjs"), 0);
        const expectedModule = await import(pathToFileURL(targetPath).href);
        for (const behaviorCase of [...task.visibleCases, ...task.hiddenCases]) {
          const exported = expectedModule[behaviorCase.exportName] as unknown;
          assert.equal(typeof exported, "function");
          assert.deepEqual(
            await (exported as (...args: readonly unknown[]) => unknown)(...behaviorCase.args),
            behaviorCase.expected,
          );
        }
        const hiddenPath = path.join(runRoot, "hidden.test.mjs");
        await fs.writeFile(
          hiddenPath,
          task.hiddenTest.replaceAll("__TARGET_MODULE__", pathToFileURL(targetPath).href),
          "utf8",
        );
        assert.equal(await nodeTest(runRoot, hiddenPath), 0);
      } else {
        const targetPath = path.join(fixture.workspaceRoot, "src", "status.js");
        const expectedModule = await import(pathToFileURL(targetPath).href);
        for (const behaviorCase of task.visibleCases) {
          const exported = expectedModule[behaviorCase.exportName] as unknown;
          assert.equal(typeof exported, "function");
          assert.deepEqual(
            await (exported as (...args: readonly unknown[]) => unknown)(...behaviorCase.args),
            behaviorCase.expected,
          );
        }
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fixture reset requires an owned marker and restores the selected task", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-reset-"));
  const runRoot = path.join(tempRoot, "owned", "greeting");
  const unrelatedRoot = path.join(tempRoot, "unrelated", "directory");
  try {
    const fixture = await prepareEvaluationFixture({ taskId: "greeting-punctuation", runRoot });
    await fs.writeFile(path.join(fixture.workspaceRoot, "src", "implementation.js"), "changed\n", "utf8");
    const reset = await prepareEvaluationFixture({
      taskId: "greeting-punctuation",
      runRoot,
      resetExisting: true,
    });
    assert.match(await fs.readFile(path.join(reset.workspaceRoot, "src", "implementation.js"), "utf8"), /Hello/u);

    await fs.mkdir(unrelatedRoot, { recursive: true });
    const sentinelPath = path.join(unrelatedRoot, "keep.txt");
    await fs.writeFile(sentinelPath, "keep\n", "utf8");
    await assert.rejects(
      prepareEvaluationFixture({
        taskId: "greeting-punctuation",
        runRoot: unrelatedRoot,
        resetExisting: true,
      }),
      /有效 MiniCode eval marker/u,
    );
    assert.equal(await fs.readFile(sentinelPath, "utf8"), "keep\n");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("task spec digest covers hidden grading and policy inputs", () => {
  const task = evaluationTasks.find((candidate) => candidate.id === "greeting-punctuation");
  if (!task || task.category !== "functional") throw new Error("需要功能题。 ");
  const baseline = evaluationTaskSpecSha256(task);
  assert.match(baseline, /^[a-f0-9]{64}$/u);
  assert.notEqual(evaluationTaskSpecSha256({ ...task, prompt: `${task.prompt} changed` }), baseline);
  assert.notEqual(evaluationTaskSpecSha256({
    ...task,
    visibleCases: [{ ...task.visibleCases[0], expected: "forged" }],
  }), baseline);
  assert.notEqual(evaluationTaskSpecSha256({ ...task, hiddenTest: `${task.hiddenTest}\n// changed` }), baseline);
  assert.notEqual(evaluationTaskSpecSha256({
    ...task,
    hiddenCases: [{ ...task.hiddenCases[0], expected: "forged" }, ...task.hiddenCases.slice(1)],
  }), baseline);
  assert.notEqual(evaluationTaskSpecSha256({ ...task, allowedChangedFiles: [] }), baseline);
});

test("fixture integrity rejects a forged spec digest and unknown reset contents", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-integrity-"));
  try {
    const digestRoot = path.join(tempRoot, "owned", "digest");
    const digestFixture = await prepareEvaluationFixture({
      taskId: "greeting-punctuation",
      runRoot: digestRoot,
    });
    const marker = JSON.parse(await fs.readFile(digestFixture.markerPath, "utf8")) as Record<string, unknown>;
    marker.taskSpecSha256 = "0".repeat(64);
    await fs.writeFile(digestFixture.markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    await assert.rejects(readEvaluationFixture(digestRoot), /task spec/u);

    const unknownRoot = path.join(tempRoot, "owned", "unknown");
    await prepareEvaluationFixture({ taskId: "greeting-punctuation", runRoot: unknownRoot });
    const keepPath = path.join(unknownRoot, "do-not-delete.txt");
    await fs.writeFile(keepPath, "keep\n", "utf8");
    await assert.rejects(
      prepareEvaluationFixture({
        taskId: "greeting-punctuation",
        runRoot: unknownRoot,
        resetExisting: true,
      }),
      /未知顶层内容/u,
    );
    assert.equal(await fs.readFile(keepPath, "utf8"), "keep\n");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fixture reset refuses symlink or junction content", async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-link-reset-"));
  try {
    const runRoot = path.join(tempRoot, "owned", "linked");
    await prepareEvaluationFixture({ taskId: "greeting-punctuation", runRoot });
    const outside = path.join(tempRoot, "outside");
    await fs.mkdir(outside);
    const link = path.join(runRoot, "artifacts");
    try {
      await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("当前系统不允许创建测试用链接。");
        return;
      }
      throw error;
    }
    await assert.rejects(
      prepareEvaluationFixture({
        taskId: "greeting-punctuation",
        runRoot,
        resetExisting: true,
      }),
      /(?:符号链接|junction|重解析点)/u,
    );
    assert.equal((await fs.lstat(runRoot)).isDirectory(), true);
    assert.equal((await fs.lstat(outside)).isDirectory(), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fixture creation failure preserves the half-created directory for manual inspection", { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-create-failure-"));
  const runRoot = path.join(tempRoot, "owned", "half-created");
  const task = evaluationTasks.find((candidate) => candidate.id === "greeting-punctuation");
  if (!task) throw new Error("需要 greeting-punctuation 任务。");
  const mutableWorkspaceFiles = task.workspaceFiles as Record<string, string>;
  const invalidPath = "../escape.js";
  mutableWorkspaceFiles[invalidPath] = "export const escaped = true;\n";
  try {
    await assert.rejects(
      prepareEvaluationFixture({ taskId: task.id, runRoot }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /未自动递归清理/u);
        assert.ok(error.message.includes(runRoot));
        return true;
      },
    );
    assert.equal((await fs.lstat(runRoot)).isDirectory(), true);
    assert.equal((await fs.lstat(path.join(runRoot, "workspace"))).isDirectory(), true);
    await assert.rejects(fs.access(evaluationFixtureOperationLockPath(runRoot)), {
      code: "ENOENT",
    });
  } finally {
    delete mutableWorkspaceFiles[invalidPath];
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("fixture reset refuses active-use and concurrent-operation locks without deleting the fixture", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-lock-reset-"));
  const runRoot = path.join(tempRoot, "owned", "locked");
  try {
    const fixture = await prepareEvaluationFixture({ taskId: "greeting-punctuation", runRoot });
    const implementationPath = path.join(fixture.workspaceRoot, "src", "implementation.js");
    const originalSource = await fs.readFile(implementationPath, "utf8");

    const activeUseLockPath = path.join(runRoot, evaluationFixtureActiveUseLockName);
    await fs.writeFile(activeUseLockPath, "active\n", { encoding: "utf8", flag: "wx" });
    await assert.rejects(
      prepareEvaluationFixture({
        taskId: "greeting-punctuation",
        runRoot,
        resetExisting: true,
      }),
      /活动使用锁/u,
    );
    assert.equal(await fs.readFile(implementationPath, "utf8"), originalSource);
    await fs.unlink(activeUseLockPath);

    const operationLockPath = evaluationFixtureOperationLockPath(runRoot);
    await fs.mkdir(operationLockPath);
    await assert.rejects(
      prepareEvaluationFixture({
        taskId: "greeting-punctuation",
        runRoot,
        resetExisting: true,
      }),
      /创建\/复位操作锁/u,
    );
    assert.equal(await fs.readFile(implementationPath, "utf8"), originalSource);
    await fs.rmdir(operationLockPath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
