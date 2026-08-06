# Mini Coding Agent

一个用于学习 Coding Agent Runtime 的轻量 TypeScript CLI。第一周只实现离线闭环，不接入任何真实模型，也不修改用户项目文件。

## 已完成的闭环

```text
用户任务
  -> Agent Loop 请求模型
  -> FakeModel 请求工具
  -> 工具执行并产生 ToolResultMessage
  -> ToolResultMessage 回填消息历史与 Working Ledger
  -> FakeModel 基于结果给出最终回答
```

当前实现刻意只包含：

- `AgentLoop`：最大轮数控制、消息历史和工具调度；
- `AgentTool`：工具名、描述、参数校验和执行函数的契约；
- `ToolRegistry`：工具按名字查找，禁止重复注册；
- `WorkingLedger`：只记录当前任务已验证的观察结果；
- 生命周期事件：`tool_call`、`tool_execution_started`、`tool_finalized`；
- `FakeModel`：确定性模拟“先调用工具，再读取工具结果”的两轮模型行为；
- Node 内置测试：验证成功和未知工具失败都拥有完整终态。

这不是可用的生产 Coding Agent。文件读写、补丁、命令执行、路径策略、持久化审计和真实模型适配会在后续阶段逐步加入。

## 运行

要求：Node.js 22.18 或以上。项目没有 npm 依赖，Node 的 TypeScript type stripping 会直接运行 `.ts` 文件。

```powershell
cd C:\Users\CX10\Desktop\mini-coding-agent
cmd.exe /d /c npm run demo -- "解释第一周离线闭环"
cmd.exe /d /c npm test
cmd.exe /d /c npm run check
```

本机 PowerShell 会拦截 `npm.ps1`，所以示例通过 `cmd.exe` 调用 npm 的 Windows 命令入口。在未受该执行策略影响的终端中，直接使用 `npm run demo`、`npm test` 和 `npm run check` 即可。

## 当前取舍

- 不引入 LangGraph 或 Agent SDK：本阶段的目标是看清 Loop、消息和工具之间的最小契约。
- 不接真实模型：FakeModel 让循环、错误路径和测试完全可重复；真实调用会单独说明目的、风险和文件影响后再进行。
- 不并发：先保证消息顺序、错误终态和可测试性，副作用工具的并发留到后续按资源设计。
- 不把 Working Ledger 当长期记忆：它只保存这一轮任务中由工具确认的事实。
