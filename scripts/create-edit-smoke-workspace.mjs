import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const templateRoot = path.resolve(projectRoot, "fixtures", "edit-smoke");
const playgroundRoot = path.resolve(projectRoot, "playground");
const workspaceRoot = path.resolve(playgroundRoot, "edit-smoke");

if (path.dirname(workspaceRoot) !== playgroundRoot) {
  throw new Error("冒烟工作区必须位于 playground/edit-smoke，已停止操作。");
}

await fs.rm(workspaceRoot, { recursive: true, force: true });
await fs.mkdir(playgroundRoot, { recursive: true });
await fs.cp(templateRoot, workspaceRoot, { recursive: true, force: true });

console.log(`已创建可复位测试工作区：${workspaceRoot}`);
console.log("该目录被 Git 忽略；重新运行本命令会恢复带缺陷的初始状态。");
