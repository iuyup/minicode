import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readFile } from "../src/tools/read-file.ts";

function context(workspaceRoot: string) {
  return { task: "read_file TOCTOU 测试", step: 1, workspaceRoot };
}

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "minicode-read-toctou-"));
  await fs.mkdir(path.join(workspace, "src"));
  return workspace;
}

test("read_file 通过句柄读取并保留 BOM 与截断证据", async () => {
  const workspace = await createWorkspace();
  try {
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`export const first = true;\n${"x".repeat(241)}\n`, "utf8"),
    ]);
    await fs.writeFile(path.join(workspace, "src", "example.ts"), content);

    const result = await readFile.execute(
      { path: "src/example.ts", startLine: 1, endLine: 2 },
      context(workspace),
    );

    assert.match(result.content, /src\/example\.ts:1 \| \uFEFFexport const first = true;/u);
    assert.match(result.content, /src\/example\.ts:2 .*\[行内容已截断\]/u);
    assert.deepEqual(result.sourceEvidence, [{
      path: "src/example.ts",
      startLine: 1,
      endLine: 2,
      truncatedLines: [2],
    }]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("read_file 拒绝 resolve 后、open 前发生的同路径文件替换", async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, "src", "target.ts");
  const replacementPath = path.join(workspace, "src", "replacement.ts");
  const originalPath = path.join(workspace, "src", "original.ts");
  await fs.writeFile(targetPath, "export const version = 'approved';\n");
  await fs.writeFile(replacementPath, "export const version = 'replaced';\n");

  const nativeOpen = fs.open;
  let replaced = false;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (!replaced && path.resolve(String(args[0])) === path.resolve(targetPath)) {
      replaced = true;
      await fs.rename(targetPath, originalPath);
      await fs.rename(replacementPath, targetPath);
    }
    return nativeOpen(...args);
  }) as typeof fs.open;

  try {
    await assert.rejects(
      readFile.execute({ path: "src/target.ts" }, context(workspace)),
      /目标文件在读取期间发生变化/,
    );
    assert.equal(replaced, true);
  } finally {
    fs.open = nativeOpen;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("read_file 拒绝句柄读取期间发生的同 inode 原地修改", async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, "src", "changing.ts");
  await fs.writeFile(targetPath, "export const version = 'before';\n");

  const nativeOpen = fs.open;
  let changed = false;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(targetPath)) {
      const nativeReadFile = handle.readFile.bind(handle);
      Object.defineProperty(handle, "readFile", {
        configurable: true,
        value: async (...readArgs: Parameters<typeof handle.readFile>) => {
          const content = await nativeReadFile(...readArgs);
          await fs.writeFile(targetPath, "export const version = 'after!';\n");
          changed = true;
          return content;
        },
      });
    }
    return handle;
  }) as typeof fs.open;

  try {
    await assert.rejects(
      readFile.execute({ path: "src/changing.ts" }, context(workspace)),
      /目标文件在读取期间发生变化/,
    );
    assert.equal(changed, true);
  } finally {
    fs.open = nativeOpen;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("read_file 在非法 UTF-8 错误前关闭已打开的句柄", async () => {
  const workspace = await createWorkspace();
  const targetPath = path.join(workspace, "src", "invalid.ts");
  await fs.writeFile(targetPath, Buffer.from([0x62, 0x61, 0x64, 0x80]));

  const nativeOpen = fs.open;
  let closeCalls = 0;
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (path.resolve(String(args[0])) === path.resolve(targetPath)) {
      const nativeClose = handle.close.bind(handle);
      Object.defineProperty(handle, "close", {
        configurable: true,
        value: async () => {
          closeCalls += 1;
          return nativeClose();
        },
      });
    }
    return handle;
  }) as typeof fs.open;

  try {
    await assert.rejects(
      readFile.execute({ path: "src/invalid.ts" }, context(workspace)),
      /不是有效 UTF-8 文本/,
    );
    assert.equal(closeCalls, 1);
  } finally {
    fs.open = nativeOpen;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
