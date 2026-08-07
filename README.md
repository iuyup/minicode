# Mini Coding Agent

一个用于学习 Coding Agent Runtime 的轻量 TypeScript CLI。当前已完成离线 Agent Loop、只读代码侦察、受控补丁与受限项目验证闭环；不接入真实模型，也不接受任意命令。

## 已完成的闭环

```text
用户任务
  -> Agent Loop 请求模型
  -> FakeModel 请求工具
  -> 工具执行并产生 ToolResultMessage
  -> ToolResultMessage 回填消息历史与 Working Ledger
  -> FakeModel 基于结果给出最终回答
```

当前实现包含：

- `AgentLoop`：最大轮数控制、消息历史和工具调度；
- `AgentTool`：工具名、描述、参数校验和执行函数的契约；
- `ToolRegistry`：工具按名字查找，禁止重复注册；
- `WorkingLedger`：只记录当前任务已验证的观察结果；
- 生命周期事件：`tool_call`、`policy_decision`、`tool_execution_started`、`tool_finalized`；
- `FakeModel`：确定性模拟“先调用工具，再读取工具结果”的两轮模型行为；
- 只读工具：`list_files`、`search_text`、`read_file`；
- 受控写工具：`apply_patch`，仅允许唯一的精确文本替换；
- 受限验证工具：`run_project_check`，只允许 `test` 和 `check` 两个固定动作；
- `WorkspacePolicy`：只允许工作区相对路径，拒绝越界、受保护路径和扫描中的符号链接；
- `JsonlAuditLog`：将脱敏的生命周期元数据追加写入 JSONL；
- Node 内置测试：验证成功、未知工具、受保护路径、输出截断、补丁确认、固定验证动作和审计终态。

路径策略是 Agent 层防护，不是操作系统沙箱。`apply_patch` 只允许修改已存在的小型 UTF-8 文本文件，禁止受保护路径；确认前后会比对文件字节，以避免覆盖确认期间发生的修改。

## 运行

要求：Node.js 22.18 或以上。先安装开发依赖以运行 TypeScript 类型检查；Node 的 TypeScript type stripping 会直接运行 `.ts` 文件。

```powershell
cd C:\Users\CX10\Desktop\minicode
cmd.exe /d /c npm install
cmd.exe /d /c npm run demo -- --workspace . "说明未知工具为何仍有完整的终态事件"
cmd.exe /d /c npm test
cmd.exe /d /c npm run check
```

本机 PowerShell 会拦截 `npm.ps1`，所以示例通过 `cmd.exe` 调用 npm 的 Windows 命令入口。在未受该执行策略影响的终端中，直接使用 `npm run demo`、`npm test` 和 `npm run check` 即可。

`apply_patch` 默认处于 `propose` 模式，只输出补丁预览、不写文件。只有在交互式终端传入 `--apply`，并输入精确的 `APPLY` 后才会原子写入：

```powershell
cmd.exe /d /c npm run demo -- --workspace . --apply "修复一个已确认的问题"
```

当前 `FakeModel` 默认演示检索和读取源码；它不会自行发起补丁，受控写入由测试中的脚本化模型覆盖。每次 CLI 运行都会在 `reports/tool-audit.jsonl` 追加审计记录，也可用 `--audit <path>` 改写位置。审计通过共同的 `toolCallId` 关联 `tool_call`、`policy_decision` 与 `tool_finalized`，但不保存模型上下文、文件内容或补丁原文。

当任务包含“运行测试”或“运行类型检查”时，`FakeModel` 会分别选择 `run_project_check` 的 `test` 或 `check` 动作。工具通过 Node 直接启动 npm CLI，不使用 `shell: true`、`cmd /c` 或模型提供的命令字符串；工作目录固定为工作区根目录，超时为 60 秒，输出最多保留 12,000 个字符。非零退出码或超时会成为 `ToolResultMessage(error)`。审计只保存动作、退出码、耗时、输出长度和截断/超时标记。

固定动作不代表可安全运行任意工作区：`npm test` 和 `npm run check` 仍会执行该工作区 `package.json` 中由项目维护者定义的脚本。因此该工具只适用于用户信任的工作区，不是操作系统沙箱，也不能替代依赖和脚本审查。

## 当前取舍

- 不引入 LangGraph 或 Agent SDK：本阶段的目标是看清 Loop、消息和工具之间的最小契约。
- 不接真实模型：FakeModel 让循环、错误路径和测试完全可重复；真实调用会单独说明目的、风险和文件影响后再进行。
- 不并发：先保证消息顺序、错误终态和可测试性，副作用工具的并发留到后续按资源设计。
- 不开放任意文件写入：补丁只能对唯一旧文本做替换，默认预览，写入必须人工确认。
- 不开放任意命令：模型只能选择固定的 `test` 或 `check` 动作，不能传入命令、参数、环境变量或工作目录。
- 不把 Working Ledger 当长期记忆：它只保存这一轮任务中由工具确认的事实。
- 不读取受保护路径：`.git`、`node_modules`、`.env` 和 `.env.*` 不会出现在目录、搜索或读取结果中。
