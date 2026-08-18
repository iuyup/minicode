# 受控编辑冒烟工作区

这是故意带有一个小缺陷的独立 Node.js 项目，用于验证 MiniCode 的真实编辑闭环。

已知缺陷：`src/greeting.js` 的 `formatGreeting` 少了结尾的 `!`，因此 `npm test` 初始应失败。

建议交给 Agent 的任务：

```text
修复 src/greeting.js 中 formatGreeting 缺少结尾感叹号的问题。先读取目标文件，只做最小修改；在我确认补丁后运行 test 验证。
```

若要演示“先失败、再确认修复”的有界分支，可使用：

```text
先运行 test 复现已知失败。失败后先给出一个最小修复方向并等待我确认，再读取 src/greeting.js、修复、复验，并查看 Git status/diff；不要提交。
```

不要直接修改该模板。每次测试前在 MiniCode 根目录运行 `npm run prepare:edit-smoke`，它会复制出被 Git 忽略的 `playground/edit-smoke` 工作区，并在其中创建一个无远程地址的本地 Git 基线。这个 fixture commit 只用于建立可复位起点，不是 Agent 自动提交；任务中的修改仍只留在工作树中，由用户手动检查和 commit。
