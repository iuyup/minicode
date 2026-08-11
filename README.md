# Mini Coding Agent

一个用于学习 Coding Agent Runtime 的轻量 TypeScript CLI。当前已完成离线 Agent Loop、只读代码侦察、受控补丁、受限项目验证，以及 DeepSeek 模型适配；默认仍不联网，也不接受任意命令。

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
- 生命周期事件：`tool_call`、`policy_decision`、`tool_execution_started`、`tool_finalized`、`final_answer_rejected`；
- `FakeModel`：确定性模拟“先调用工具，再读取工具结果”的两轮模型行为；
- `DeepSeekModel`：通过官方 OpenAI 兼容 Chat Completions 接口把模型回复转换为内部工具调用；
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

## DeepSeek 模型适配

默认模型是离线 `FakeModel`。只有显式传入 `--model deepseek` 且设置 `DEEPSEEK_API_KEY` 后，CLI 才会向 DeepSeek 发起网络请求。默认模型为 `deepseek-v4-flash`，可用 `--deepseek-model` 或 `DEEPSEEK_MODEL` 覆盖。

```powershell
$env:DEEPSEEK_API_KEY = "在此设置你的密钥"
cmd.exe /d /c npm run demo -- --model deepseek --workspace . "解释当前 AgentLoop 的工具错误终态"
```

适配器使用官方 `https://api.deepseek.com/chat/completions` 接口、非流式调用和非思考模式；单次请求最多生成 2,048 tokens，并在 30 秒后超时。模型得到系统提示、用户任务、已注册工具的 JSON Schema，以及当前会话中的工具结果。在当前 CLI 的 DeepSeek 模式下，能够外发的是项目概览、目录列表、搜索结果和源码片段；不会向模型暴露补丁或项目验证工具。不要在不信任工作区或含敏感内容的任务中启用该模式。API Key 只从环境变量读取，绝不写入审计、报告或仓库。

DeepSeek 模式默认只暴露 `get_project_overview`、`list_files`、`search_text` 和 `read_file`；不向真实模型暴露 `apply_patch` 或 `run_project_check`。每个工具调用会先在本地注册表按名称查找：未知工具直接成为标准错误终态；仅已找到的工具才会进入 JSON 与 Schema 的 `validate`。DeepSeek 官方文档说明该 API 使用 OpenAI 兼容格式，工具调用结果需要由客户端执行后回传。[官方快速开始](https://api-docs.deepseek.com/) [官方工具调用文档](https://api-docs.deepseek.com/guides/tool_calls)

真实模型可能持续请求更多证据而不自行结束。为控制这一类不收敛行为，DeepSeek 模式有专用提示词，并限制每个模型轮次最多受理 2 个工具调用、每个任务最多受理 6 个。超出的调用不会执行，但仍会得到 `tool_call -> tool_finalized(error)` 的完整终态和标准错误结果，模型可据此收敛；`maxSteps=6` 保留为最后一道循环保护。这些限制约束成本和执行范围，不能保证任何模型一定给出正确答案。

2026-08-10 的第一次真实 DeepSeek 冒烟测试复现了这个问题：模型在 6 个轮次中成功完成 15 次只读侦察，但没有返回最终答案，运行时因 `maxSteps=6` 主动停止。随后加入上述收敛提示词与工具预算，并通过本地 24 项自动化测试；本次修复尚未进行第二次真实 API 验证，因此不能据此声称真实模型已经稳定收敛。

第二次真实运行验证了预算与终态控制：8 次工具请求对应 6 个成功终态和 2 个预算错误终态，模型在第 5 轮完成。但模型仍错误地把“未知工具”说成先经过 `validate`；真实实现是先按名称查找工具，找不到便直接产生错误终态。为防止“运行完成”被误认为“解释正确”，新增可选的 `--require-source-evidence` 模式：`read_file` 会在运行时记录实际读取的 `path + line range`，最终答案必须包含落在该范围内的 `path:line` 引用。引用缺失或越界时会产生脱敏的 `final_answer_rejected` 事件并要求模型重答一次；第二次仍不合格则停止。该模式验证引用来源，不能自动证明自然语言推理完全正确。

```powershell
cmd.exe /d /c npm run demo -- --model deepseek --deepseek-model deepseek-v4-flash --workspace . --require-source-evidence --audit reports\deepseek-source-evidence-smoke.jsonl "解释未知工具为何仍有完整的终态事件"
```

该模式已通过本地 28 项自动化测试与离线 CLI 演示；尚未进行真实 DeepSeek API 验证。

`apply_patch` 默认处于 `propose` 模式，只输出补丁预览、不写文件。只有在交互式终端传入 `--apply`，并输入精确的 `APPLY` 后才会原子写入：

```powershell
cmd.exe /d /c npm run demo -- --workspace . --apply "修复一个已确认的问题"
```

当前 `FakeModel` 默认演示检索和读取源码；它不会自行发起补丁，受控写入由测试中的脚本化模型覆盖。每次 CLI 运行都会在 `reports/tool-audit.jsonl` 追加审计记录，也可用 `--audit <path>` 改写位置。审计通过共同的 `toolCallId` 关联 `tool_call`、`policy_decision` 与 `tool_finalized`，但不保存模型上下文、文件内容或补丁原文。

当任务包含“运行测试”或“运行类型检查”时，`FakeModel` 会分别选择 `run_project_check` 的 `test` 或 `check` 动作。工具通过 Node 直接启动 npm CLI，不使用 `shell: true`、`cmd /c` 或模型提供的命令字符串；工作目录固定为工作区根目录，超时为 60 秒，输出最多保留 12,000 个字符。非零退出码或超时会成为 `ToolResultMessage(error)`。审计只保存动作、退出码、耗时、输出长度和截断/超时标记。

固定动作不代表可安全运行任意工作区：`npm test` 和 `npm run check` 仍会执行该工作区 `package.json` 中由项目维护者定义的脚本。因此该工具只适用于用户信任的工作区，不是操作系统沙箱，也不能替代依赖和脚本审查。

## 当前取舍

- 不引入 LangGraph 或 Agent SDK：本阶段的目标是看清 Loop、消息和工具之间的最小契约。
- 默认不接真实模型：FakeModel 让循环、错误路径和测试完全可重复；DeepSeek 仅在显式选择后联网，真实调用会单独说明目的、风险和文件影响后再进行。
- 不并发：先保证消息顺序、错误终态和可测试性，副作用工具的并发留到后续按资源设计。
- 不开放任意文件写入：补丁只能对唯一旧文本做替换，默认预览，写入必须人工确认。
- 不开放任意命令：模型只能选择固定的 `test` 或 `check` 动作，不能传入命令、参数、环境变量或工作目录。
- 不把 Working Ledger 当长期记忆：它只保存这一轮任务中由工具确认的事实。
- 不读取受保护路径：`.git`、`node_modules`、`.env` 和 `.env.*` 不会出现在目录、搜索或读取结果中。
