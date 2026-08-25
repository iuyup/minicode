import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  captureEvaluationSourceProvenance,
  sameEvaluationSourceProvenance,
} from "../src/evals/eval-provenance.ts";
import { hashEvaluationReportPlan } from "../src/evals/eval-report.ts";
import { resolveGitExecutable } from "../src/tools/inspect-git.ts";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<void> {
  const executable = await resolveGitExecutable(root);
  await execFileAsync(executable, args, { cwd: root, windowsHide: true });
}

test("source provenance binds tracked and untracked dirty bytes without publishing them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-eval-provenance-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "eval@example.test"]);
    await git(root, ["config", "user.name", "Eval Test"]);
    const tracked = path.join(root, "tracked.txt");
    const untracked = path.join(root, "untracked.txt");
    await fs.writeFile(tracked, "initial\n", "utf8");
    await git(root, ["add", "tracked.txt"]);
    await git(root, ["commit", "-m", "initial"]);

    const clean = await captureEvaluationSourceProvenance(root);
    assert.equal(clean.dirty, false);
    assert.match(clean.sourceCommit, /^[a-f0-9]{40,64}$/u);
    assert.match(clean.dirtyStateSha256, /^[a-f0-9]{64}$/u);

    await fs.writeFile(tracked, "first dirty bytes\n", "utf8");
    const firstTracked = await captureEvaluationSourceProvenance(root);
    await fs.writeFile(tracked, "second dirty bytes\n", "utf8");
    const secondTracked = await captureEvaluationSourceProvenance(root);
    assert.equal(firstTracked.dirty, true);
    assert.equal(firstTracked.sourceCommit, clean.sourceCommit);
    assert.notEqual(firstTracked.dirtyStateSha256, clean.dirtyStateSha256);
    assert.notEqual(secondTracked.dirtyStateSha256, firstTracked.dirtyStateSha256);

    await fs.writeFile(untracked, "first untracked bytes\n", "utf8");
    const firstUntracked = await captureEvaluationSourceProvenance(root);
    await fs.writeFile(untracked, "second untracked bytes\n", "utf8");
    const secondUntracked = await captureEvaluationSourceProvenance(root);
    assert.notEqual(firstUntracked.dirtyStateSha256, secondTracked.dirtyStateSha256);
    assert.notEqual(secondUntracked.dirtyStateSha256, firstUntracked.dirtyStateSha256);
    const planMaterial = {
      profileId: "deepseek" as const,
      publicConfigSha256: "c".repeat(64),
      source: clean,
      tasks: ["greeting-punctuation"],
      arms: ["baseline-3tool"],
      trialsPerCell: 3,
      totalTrials: 3,
      maximumWallClockMs: 540_000,
      entries: [
        { taskId: "greeting-punctuation", arm: "baseline-3tool", trial: 1 },
        { taskId: "greeting-punctuation", arm: "baseline-3tool", trial: 2 },
        { taskId: "greeting-punctuation", arm: "baseline-3tool", trial: 3 },
      ],
      sendsNetworkRequests: true as const,
      apiKeyReadDuringPlanning: false as const,
    };
    assert.notEqual(
      hashEvaluationReportPlan(planMaterial),
      hashEvaluationReportPlan({ ...planMaterial, source: secondUntracked }),
    );
    assert.equal(sameEvaluationSourceProvenance(secondUntracked, secondUntracked), true);
    assert.equal(sameEvaluationSourceProvenance(firstTracked, secondTracked), false);
    assert.equal(JSON.stringify(secondUntracked).includes(root), false);
    assert.equal(JSON.stringify(secondUntracked).includes("second untracked bytes"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
