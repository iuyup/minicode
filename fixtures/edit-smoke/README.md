# 受控编辑冒烟工作区

这是故意带有一个小缺陷的独立 Node.js 项目，用于验证 MiniCode 的真实编辑闭环。

已知缺陷：`src/greeting.js` 的 `formatGreeting` 少了结尾的 `!`，因此 `npm test` 初始应失败。

建议交给 Agent 的任务：

```text
修复 src/greeting.js 中 formatGreeting 缺少结尾感叹号的问题。先读取目标文件，只做最小修改；在我确认补丁后运行 test 验证。
```

不要直接修改该模板。每次测试前在 MiniCode 根目录运行 `npm run prepare:edit-smoke`，它会复制出被 Git 忽略的 `playground/edit-smoke` 工作区。
