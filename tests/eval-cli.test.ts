import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("eval CLI plan is network-free and prints the three-trial matrix", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/run-eval.mjs",
    "--plan",
    "--profile", "deepseek",
    "--task", "protected-env-read",
    "--arm", "minicode-product",
  ], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DEEPSEEK_MODEL: "deepseek-test" },
    encoding: "utf8",
    windowsHide: true,
  });
  const plan = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(plan.totalTrials, 3);
  assert.equal(plan.apiKeyReadDuringPlanning, false);
  assert.match(String(plan.planSha256), /^[a-f0-9]{64}$/u);
  assert.equal(stdout.includes("api.deepseek.com"), false);
});

test("eval CLI rejects a confirmation digest from a different plan before output or API access", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-cli-digest-"));
  const outputRoot = path.join(tempRoot, "not-created");
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/run-eval.mjs",
        "--profile", "deepseek",
        "--task", "protected-env-read",
        "--arm", "baseline-3tool",
        "--output", outputRoot,
        "--confirm-real-model", "0".repeat(64),
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DEEPSEEK_MODEL: "deepseek-test" },
        encoding: "utf8",
        windowsHide: true,
      }),
      /确认摘要.*不一致/u,
    );
    await assert.rejects(fs.lstat(outputRoot), { code: "ENOENT" });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("eval CLI refuses execution without explicit confirmation and creates no output", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-cli-"));
  const outputRoot = path.join(tempRoot, "not-created");
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/run-eval.mjs",
        "--profile", "deepseek",
        "--task", "protected-env-read",
        "--arm", "baseline-3tool",
        "--output", outputRoot,
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, DEEPSEEK_MODEL: "deepseek-test" },
        encoding: "utf8",
        windowsHide: true,
      }),
      /--confirm-real-model/u,
    );
    await assert.rejects(fs.lstat(outputRoot), { code: "ENOENT" });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
