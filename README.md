# Mini Coding Agent

一个用于学习 Coding Agent Runtime 的轻量 TypeScript CLI。当前已完成离线 Agent Loop、只读代码与 Git 侦察、受控补丁、受限项目验证、结构化 Node/npm 进程，以及 OpenAI-compatible 模型 Profile；默认仍不联网，也不开放任意 Shell 或 Git 写操作。

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
- 生命周期事件：`tool_call`、`command_approval_requested`、`command_approval_decision`、`policy_decision`、`tool_execution_started`、`tool_finalized`、`final_answer_rejected`；
- `FakeModel`：确定性模拟“按任务调用一个或多个工具，再读取工具结果”的多轮模型行为；
- `OpenAiCompatibleModel`：通过 Chat Completions 兼容接口把模型回复转换为内部工具调用；`DeepSeekModel` 保留为带“关闭思考”参数的兼容预设；
- 只读工具：`list_files`、`search_text`、`read_file`，以及固定动作的 `inspect_git`；
- 受控写工具：`apply_patch`，仅允许唯一的精确文本替换；
- 受限验证工具：`run_project_check`，只允许 `test` 和 `check` 两个固定动作；
- 受控进程工具：`run_command`，只接收分离的程序、参数数组和工作区相对目录，第一版仅允许 Node/npm；
- `WorkspacePolicy`：只允许工作区相对路径，拒绝越界、受保护路径和扫描中的符号链接，并允许项目用 `.minicodeignore` 继续收紧读取范围；
- `JsonlAuditLog`：将脱敏的生命周期元数据追加写入 JSONL；
- Node 内置测试：验证成功、未知工具、受保护路径、输出截断、补丁确认、固定验证、命令策略、Git 只读边界和审计终态。

路径策略是 Agent 层防护，不是操作系统沙箱。`apply_patch` 只允许修改已存在的小型、严格合法的 UTF-8 文本文件，禁止受保护路径；确认前后会比对文件、父目录身份和完整字节，以避免覆盖确认期间被替换或修改的文件。写入会保留 UTF-8 BOM（如果原文件存在），并尽力保留 POSIX mode；不保证 ACL、owner、扩展属性或所有平台元数据完全不变，也不会把非法 UTF-8 字节静默替换成乱码。更完整的边界见 [SECURITY.md](SECURITY.md)。

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

仓库包含 GitHub Actions，使用固定的 Node.js 22.18.0 在 Windows 与 Ubuntu 上分别执行 `npm ci`、`npm run check` 和 `npm test`。本地新增测试优先覆盖 Agent Loop、补丁审批、命令绑定、Git 取消、敏感路径和证据校验；CI 能验证跨平台回归，但不能替代真实终端、真实模型或恶意工作区隔离测试。

## 交互入口：mini

`demo` 用于单次复现与自动化验证；`mini` 是轻量交互入口。它使用 Pi 的 `@mariozechner/pi-tui` 进行差量渲染和多行输入编辑，并直接使用当前终端缓冲区：顶部显示模型、权限和工作区，中部保留对话，底部显示编辑器与状态栏；鼠标滚轮或终端滚动条可以回看历史。它保留最近 6 轮的“用户任务 + 最终回答”模型上下文，不会把工具原文跨轮塞回模型；每个新任务仍独立执行工具、生成审计终态并重新校验源码证据。

TUI 采用仓库内、静态注册的组件插件：控制器将安全生命周期事实投影为冻结的 `TuiReadModel`，再由带稳定键的 `TuiPlugin` 节点交给 Pi renderer。内建组件固定为顶部、工作流、会话、对话、活动、收口、审批、输入与底栏；其中工作流只展示 `计划 → 执行 → 验证 → 收口` 的当前阶段，不会批准操作或启动工具。插件拿不到 `AgentLoop`、审批 resolver、`AbortController`、底层终端写入、原始事件、工具正文或 Git diff。当前不支持从配置、磁盘或网络加载第三方插件；这不是插件沙箱，也不会增加任何工具权限。

```powershell
cd C:\Users\CX10\Desktop\minicode
cmd.exe /d /c npm run mini
```

工具调用在主屏默认折叠为简短状态；按 `Ctrl+O` 或输入 `/details` 可展开最近的生命周期事件。滚轮浏览由 VS Code Terminal、Windows Terminal 等宿主终端的原生历史提供，不会占用编辑器的 `PageUp`、`PageDown`、`Home` 或 `End`；窗口 resize 不会主动清除宿主历史，只有 `/clear` 会明确清空当前终端历史。`Ctrl+V` 会从固定的 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` 读取系统剪贴板文本，非标准 Windows 安装会闭锁该功能；控制序列会先转成可见文本，超过 32,000 的文本长度上限时拒绝插入，较早发起但较晚返回的粘贴也不会污染新输入。可用命令：`/help`、`/model [profile]`、`/status`、`/clear`、`/details`、`/exit`。`/clear` 会清空会话上下文和当前终端历史，但不会删除审计；`Ctrl+C` 在空闲时退出，在运行中则取消当前任务、关闭待确认操作并终止可控子进程。

默认启动的 `FakeModel` 只用于可重复的离线演示，不理解自由任务，也不会自主修改代码。要运行真实 Agent，须显式选择一个已配置的网络 Profile；TUI 会在进入远程会话和切换远程 Profile 时显示工作区、目标 Profile 与可能外发的数据类别。默认是只读模式：

```powershell
cmd.exe /d /c npm run mini -- --model deepseek --deepseek-model deepseek-v4-flash --require-source-evidence
```

要进行受控修改，使用显式编辑模式：

```powershell
cmd.exe /d /c npm run mini -- --model deepseek --mode edit --workspace .
```

若只想离线验收这一阶段的通用命令面板，可运行 `cmd.exe /d /c npm run mini -- --mode edit --workspace .`，输入“请查看 npm --version 并汇报”。`FakeModel` 只会为这条确定性演示选择 `run_command`；确认前不会启动进程。

若要离线验收 Git 只读闭环，可在普通模式输入“请查看 Git status 和未暂存 diff 并汇报”。`FakeModel` 会依次选择 `inspect_git` 的固定动作；该工具不需要 `RUN`，也不会暂存、提交或切换分支。

编辑模式额外开放 `apply_patch`、固定的 `run_project_check` 和结构化的 `run_command`；普通 read/edit 模式都开放 `inspect_git`，严格源码取证模式仍只注册 `search_text` 与 `read_file`。远程模型的 `edit` 模式会在运行时强制模型先通过 `read_file` 成功读取补丁目标，离线工作流也显式启用同一约束；通过该门槛后，模型才能提出一次精确文本替换。TUI 会显示 diff 并暂停，只有用户在输入框中准确输入 `APPLY` 后才原子写入；输入 `CANCEL` 才会取消，其他输入既不会写入，也会保留待确认补丁。删除区或新增区只要超过 40 行，或包含超过 200 字符的行，就无法无损显示，因此会在进入审批前闭锁并要求模型拆分修改。补丁成功写入后，运行时会建立待验证状态：下一模型轮只开放并强制 `run_project_check(test)`，该动作实际执行且成功前不会接受完成回答、通用命令或 Git 收尾；同一模型响应中跟在补丁后的工具也不会提前执行。TUI 会完整展示命令、绝对工作目录和风险等级，只有精确输入 `RUN` 才启动进程，`CANCEL` 会产生零执行的错误终态。

显式启用 `--guided --mode edit` 后，真实启动的固定验证若以非零退出码或超时结束，下一轮会关闭全部工具，只让模型给出一条简短修复方向，并在 TUI 等待精确的 `CONTINUE` 或 `CANCEL`。确认后，本次任务最多再受理 3 个自由修复工具调用，只开放 `read_file`、一次 `apply_patch` 和 `run_project_check`；第三个自由调用才成功应用补丁时，仍会单独保留随后的强制 `test`。若原失败动作是 `check`，修复补丁通过 `test` 后还必须重新通过 `check`，不能用另一种验证替代原失败动作。任一复验不成功都不会开启第二轮修复；全部必要复验成功后才重新开放 Git 只读工具用于收尾。修复方向审计只保存长度和 approved/rejected 决定，不保存方向正文或失败输出。

`APPLY`、`CONTINUE`、`RUN`、`CANCEL` 都是本地控制词，在没有对应待确认操作时不会发给模型。`run_command` 不开放 Shell、管道、重定向、Git、提权、后台任务或环境变量注入；Git 只能通过专用工具读取固定状态与差异。编辑模式每轮只受理一个工具调用，基础工具预算最多 6 次；常规第 7 个模型执行轮用于预算耗尽后的最终总结。每次成功补丁都会在绝对硬帽内保留后续固定 `test`、最多 2 次受控收尾和最终回答所需的额度；提示词引导模型把收尾额度用于 Git status/diff，但普通成功路径不会把它实现成专用 Git credit。guided 计划使用额外的无工具确认轮；若真实验证失败且满足一次有界修复条件，运行时会另外预留 3 次自由修复工具调用；全部必要复验成功后进入专用 Git 收尾状态，最多受理 2 次 `inspect_git`。生产 edit 装配的绝对上限为 18 次模型请求和 13 次已受理工具调用，任何动态验证或修复扩容都不能越过该硬帽。`--require-source-evidence` 不能与 `--mode edit` 同时使用。

### 远程数据与 `.minicodeignore`

内置策略会在任意目录层级、大小写不敏感地拒绝 `.env*`、常见 npm/Python/Git 凭据文件、`.aws`、`.ssh`、`.gnupg`、`node_modules`，以及 `credentials*.json`、`secrets.json/yml/yaml`、`service-account*.json`、`*.pem`、`*.key`、`*.p12`、`*.pfx`。这些文件不会被 `list_files` 显示，也不能被 `search_text` 或 `read_file` 读取；编辑策略同样不能改写它们。疑似敏感文件采用硬拒绝，不提供一次确认后绕过内置规则的入口。

项目还可在工作区根目录放置最多 64 KiB、严格 UTF-8 的 `.minicodeignore`。规则相对工作区根目录，大小写不敏感；支持单段中的 `*`、`?`，以及作为完整路径段的 `**`。空行和 `#` 注释会忽略，末尾 `/` 表示该目录树；不支持 `!` 反向规则、字符类或花括号。示例：

```gitignore
# 这些内容不允许 Agent 读取
private/**
generated/*.ts
docs/?raft.md
```

规则文件自身也受保护。规则非法、不是 UTF-8、是链接或超限时，读取策略失败关闭。当前 `inspect_git` 只使用固定、经过验证的 Git pathspec；如果 `.minicodeignore` 含有效自定义规则，Git status/diff 会整体拒绝，以免 Git 输出绕过用户规则。该文件约束 MiniCode 自身的文件工具，不是进程沙箱；用户批准运行的 npm/Node 项目代码仍可能读取任何宿主进程有权限访问的文件。

### 可复位编辑工作流测试

仓库提供了故意带有一个小缺陷的模板 `fixtures/edit-smoke`。准备命令会将它复制到被 Git 忽略的隔离工作区 `playground/edit-smoke`，并创建无远程地址的独立 `main` 仓库和确定性基线 commit；每次重新执行都会删除该 playground 中的旧状态并恢复初始缺陷，因此真实模型不会修改 MiniCode 自身。基线 commit 只由 fixture 准备脚本创建，不代表 Agent 获得了提交权限。

先运行确定性的离线工作流 E2E：

```powershell
cmd.exe /d /c npm run test:success-chain
```

该 E2E 使用 scripted model，并走生产 `createMiniTui` 装配、真实 `AgentLoop`、TUI 确认状态机、文件、`npm test` 和 Git 工具。它同时覆盖两条路径：`计划 -> 搜索 -> 读取 -> 补丁确认 -> 验证确认 -> Git status/diff -> 总结`，以及 `计划 -> 首次验证失败 -> 修复方向确认 -> 读取 -> 补丁确认 -> 复验成功 -> Git status/diff -> 总结`。第二条路径恰好使用 6 次工具和 9 次模型请求，两次验证都由真实 npm 进程执行。

终端输入输出由测试替身驱动，因此没有验证 OS TTY 或 VS Code Terminal 本身。测试断言每个确认点之前均无对应副作用，完成后 HEAD、分支和 index 保持基线，审计不保存修复方向、补丁、测试输出、Git diff 或绝对工作区。它验证的是确定性模型下的本地 Runtime 与产品状态机，不代表真实模型已经能稳定完成任意任务，也不保证所有模型都会主动执行 Git 收尾。

`guided` 是面试和产品演示的推荐配置，不是 CLI 默认值；若要人工验收真实模型，需像下面这样显式传入 `--guided`，并先重新准备工作区：

```powershell
cmd.exe /d /c npm run prepare:edit-smoke
cmd.exe /d /c npm run mini -- --model deepseek --mode edit --guided --workspace playground\edit-smoke --audit reports\edit-smoke-reject.jsonl
```

输入以下任务，待 diff 出现后输入 `CANCEL`，验收“取消不写入”：

```text
修复 src/greeting.js 中 formatGreeting 缺少结尾感叹号的问题。先读取目标文件，只做最小修改；在我确认补丁后运行 test 验证。
```

随后再次运行 `npm run prepare:edit-smoke`，将审计文件改为 `reports\edit-smoke-apply.jsonl`，重复任务并输入 `APPLY`；待验证面板出现后检查命令和工作区，再输入 `RUN`。验收标准是：读取 `src/greeting.js` 后才出现补丁、写入前显示 diff、命令确认前没有进程启动、`npm test` 成功；JSONL 审计包含计划、补丁与命令确认、工具策略和执行终态，其中补丁确认只保存相对路径、预览长度和 approved/rejected 决定，不包含补丁正文、完整命令、绝对工作区或命令输出。

若要在该机器上直接使用 `mini` 而非 `npm run mini`，可在确认本项目可信后执行一次 `cmd.exe /d /c npm link`；此操作会创建指向当前项目的本机全局命令。该仓库通过 `package.json` 的 `bin` 字段注册 `mini`，不会发布 npm 包。

## 模型 Profile 与 DeepSeek 预设

Profile 只保存显示名、`baseUrl`、`model` 和 API Key 的环境变量名；密钥不会写入 Profile、仓库、TUI 事件或 JSONL 审计。`baseUrl` 必须是带主机名的 `http`/`https` 地址，且不能包含凭据、查询参数或 fragment。默认只允许 HTTPS，明文 HTTP 仅允许 `localhost`、`127.0.0.1` 和 `[::1]`，HTTP 自动重定向会被拒绝。只有在确认链路和服务可信时，才可用 `MINICODE_ALLOW_INSECURE_HTTP=1` 显式放行其他明文 HTTP 地址；这可能暴露 API Key 和请求正文。启动 `mini` 后输入 `/model` 查看可用项，输入 `/model <profile>` 切换。切换不会发送网络请求，但会清空后续发送给模型的会话上下文，避免不同模型混用上下文。

- `fake`：离线演示；
- `deepseek`：内置 DeepSeek 预设，使用 `DEEPSEEK_API_KEY`，可用 `DEEPSEEK_MODEL` 或旧参数 `--deepseek-model` 覆盖模型名；
- `openai-compatible`：使用 `MINICODE_OPENAI_BASE_URL`、`MINICODE_OPENAI_MODEL` 和 `MINICODE_OPENAI_API_KEY`，可接入使用 Bearer Key、无需自定义请求头且支持 Chat Completions 工具调用的兼容服务；MiniCode 会在 `baseUrl` 后固定追加 `/chat/completions`。

```powershell
$env:MINICODE_OPENAI_BASE_URL = "https://your-gateway.example/v1"
$env:MINICODE_OPENAI_MODEL = "your-coding-model"
$env:MINICODE_OPENAI_API_KEY = "在此设置你的密钥"
cmd.exe /d /c npm run mini -- --profile openai-compatible --require-source-evidence
```

`--model fake|deepseek` 保留为 DeepSeek 迁移入口；通用入口是 `--profile fake|deepseek|openai-compatible`。

默认模型是离线 `FakeModel`。只有显式传入 `--model deepseek` 且设置 `DEEPSEEK_API_KEY` 后，CLI 才会向 DeepSeek 发起网络请求。默认模型为 `deepseek-v4-flash`，可用 `--deepseek-model` 或 `DEEPSEEK_MODEL` 覆盖。

```powershell
$env:DEEPSEEK_API_KEY = "在此设置你的密钥"
cmd.exe /d /c npm run demo -- --model deepseek --workspace . "解释当前 AgentLoop 的工具错误终态"
```

适配器使用官方 `https://api.deepseek.com/chat/completions` 接口、非流式调用和非思考模式；单次请求最多生成 2,048 tokens，30 秒超时覆盖响应头和响应正文，响应体上限为 1 MiB，用户取消也会中止等待。适配器会严格解码 UTF-8，并拒绝截断、空答案、空工具调用、重复工具调用 ID 和不支持的 `finish_reason`，不会把损坏或残缺响应记为任务完成。模型得到系统提示、用户任务、已注册工具的 JSON Schema，以及当前会话中的工具结果。普通只读模式能够外发项目概览、目录列表、搜索结果、源码片段，以及被请求的 Git 分支、文件路径、status 和 diff 正文；严格源码取证模式不开放 Git。显式启用编辑模式后，补丁参数和获准进程的输出也会进入当前模型会话。不要在不信任工作区或含敏感内容的任务中启用网络 Profile。API Key 只从环境变量读取，绝不写入审计、报告或仓库。

DeepSeek 普通只读模式默认暴露 `get_project_overview`、`list_files`、`search_text`、`read_file` 和 `inspect_git`；只有显式传入 `--mode edit` 才增加 `apply_patch`、`run_project_check` 和 `run_command`，严格 `--require-source-evidence` 模式则仍只注册 `search_text` 与 `read_file`。每个工具调用会先在本地注册表按名称查找：未知工具直接成为标准错误终态；仅已找到的工具才会进入 JSON 与 Schema 的 `validate`。DeepSeek 官方文档说明该 API 使用 OpenAI 兼容格式，工具调用结果需要由客户端执行后回传。[官方快速开始](https://api-docs.deepseek.com/) [官方工具调用文档](https://api-docs.deepseek.com/guides/tool_calls)

真实模型可能持续请求更多证据而不自行结束。为控制这一类不收敛行为，DeepSeek 模式有专用提示词，并限制每个模型轮次最多受理 2 个工具调用、每个任务最多受理 6 个。超出的调用不会执行，但仍会得到 `tool_call -> tool_finalized(error)` 的完整终态和标准错误结果，模型可据此收敛；普通只读模式保留 `maxSteps=6`。编辑模式允许第 7 个执行轮；六次工具预算用尽后，该轮不再向模型提供工具，只接受最终总结，继续请求工具会明确停止。这些限制约束成本和执行范围，不能保证任何模型一定给出正确答案。

2026-08-10 的第一次真实 DeepSeek 冒烟测试复现了这个问题：模型在 6 个轮次中成功完成 15 次只读侦察，但没有返回最终答案，运行时因 `maxSteps=6` 主动停止。随后加入上述收敛提示词与工具预算，并通过本地 24 项自动化测试；本次修复尚未进行第二次真实 API 验证，因此不能据此声称真实模型已经稳定收敛。

第二次真实运行验证了预算与终态控制：8 次工具请求对应 6 个成功终态和 2 个预算错误终态，模型在第 5 轮完成。但模型仍错误地把“未知工具”说成先经过 `validate`；真实实现是先按名称查找工具，找不到便直接产生错误终态。为防止“运行完成”被误认为“解释正确”，新增可选的 `--require-source-evidence` 模式：`read_file` 会在运行时记录实际读取的 `path + line range`，以及其中因 240 字符显示上限而不完整的行；最终答案必须包含完全落在已读取且未截断区域内的 `path:line` 或 `path:startLine-endLine` 引用。没有成功读取源码的回答会直接失败；已有源码但引用缺失、越界或落到截断行时会产生脱敏的 `final_answer_rejected`，并获得一次不暴露工具的最终回答修复轮。修复反馈只提供可直接复制的完整证据范围，要求模型删除旧引用且只能使用给出的范围。若第一次拒绝发生在第 6 轮，运行时只为该修复额外允许第 7 次模型请求；工具受理上限仍为 6。修复轮再次引用无效或请求工具都会停止。该模式验证引用来源，不能自动证明自然语言推理完全正确。

```powershell
cmd.exe /d /c npm run demo -- --model deepseek --deepseek-model deepseek-v4-flash --workspace . --require-source-evidence --audit reports\deepseek-source-evidence-smoke.jsonl "解释未知工具为何仍有完整的终态事件"
```

2026-08-11 的首次真实证据模式测试发现了最后一轮边界：模型在第 6 轮给出越界引用，运行时正确记录 `final_answer_rejected`，但旧循环没有剩余轮次可供重答。定向修复虽已通过本地 31 项自动化测试与离线 CLI 演示，修复后的真实测试又暴露出另一条路径：模型先后消耗了 6 次 `get_project_overview`、`list_files` 与 `search_text`，首次 `read_file` 因总预算耗尽被拒绝，最终没有源码证据可引用。为将取证目标落实到工具权限上，`--require-source-evidence` 现在只注册 `search_text` 与 `read_file`，并将单轮受理数收紧为 1；普通 DeepSeek 侦察模式不受影响。一次后续真实运行已在第 4 轮成功完成并给出有效引用，但也表明提示词不足以约束搜索范围：模型曾以 `.` 搜索并看到了非源码文档。因此该模式现在在运行时将无路径搜索固定为 `src`，拒绝搜索或读取 `src/` 之外的路径；`.gitignore` 不再被误当作 Agent 的读取权限边界。又一次真实运行表明，提示词也不足以让模型在读到源码后停止探索：它在第 4 轮已读源码后继续搜索，直至第 6 轮仍未回答。首次状态机修复虽让模型停止搜索，却错误地禁止了寻找事件处理层的必要补充证据，导致最终解释只基于注册表而不够成立。当前状态机采用固定的两段证据链：最多两次初始搜索后必须首次读取；首次读取后可进行一次定向补充搜索和一次补充读取；第二次成功读取后关闭工具并要求最终回答。这样最多正好占用 6 个常规轮次，且仍只访问 `src/`。若第 6 个常规轮刚读到源码，才额外给予第 7 个无工具最终回答轮；该额外轮与引用修复共用一次上限，工具受理上限仍为 6。最新真实测试进一步证明，仅从工具列表中移除 `search_text` 不能保证模型不再返回它：两次被本地安全拒绝的调用耗尽了可用轮次。为此，当状态机只允许 `read_file` 时，适配器会向 DeepSeek 发送官方的具名 `tool_choice`，强制该函数调用；本地注册表与错误终态仍是不可绕过的安全边界。该改动已通过本地验证，仍需一次真实 DeepSeek 测试确认该模型在非思考模式下会稳定遵守强制选择。

`apply_patch` 默认处于 `propose` 模式，只输出补丁预览、不写文件。只有在交互式终端传入 `--apply`，并输入精确的 `APPLY` 后才会原子写入：

```powershell
cmd.exe /d /c npm run demo -- --workspace . --apply "修复一个已确认的问题"
```

当前 `FakeModel` 默认演示检索和读取源码；它不会自行发起补丁，受控写入与失败修复由测试中的脚本化模型覆盖。每次 CLI 运行默认写入用户级审计目录：Windows 为 `%LOCALAPPDATA%\MiniCode\audit\session-*.jsonl`，其他平台为 `~/.minicode/audit/session-*.jsonl`；可用 `--audit <path>` 显式改写位置，因此只读检查默认不会在目标仓库中创建 `reports`。审计写入会串行化，使用共同的 `toolCallId` 关联 `tool_call`、`policy_decision` 与 `tool_finalized`；计划、补丁、命令和修复方向确认只保存脱敏元数据与决定，不保存模型上下文、方向正文、文件内容或补丁原文。

当任务包含“运行测试”或“运行类型检查”时，`FakeModel` 会分别选择 `run_project_check` 的 `test` 或 `check` 动作。参数通过校验后，Agent Loop 先产生脱敏的命令确认事件；没有确认回调、用户输入 `CANCEL` 或确认界面异常时均默认闭锁，不会进入 `tool_execution_started`。只有精确输入 `RUN` 后，工具才通过 Node 直接启动 npm CLI；它不使用 `shell: true`、`cmd /c` 或模型提供的命令字符串，工作目录固定为工作区根目录。审批前会绑定工作目录、Node/npm 入口和根 `package.json` 的身份与完整内容，执行前再次复核；等待期间任一对象变化都会保持零进程。超时为 60 秒，输出最多保留 12,000 个字符。非零退出码、超时或用户取消会成为 `ToolResultMessage(error)`。审计只保存动作、确认决定、退出码、耗时、输出长度和截断/超时/取消标记。

固定动作不代表可安全运行任意工作区：`npm test` 和 `npm run check` 仍会执行该工作区 `package.json` 中由项目维护者定义的脚本。因此该工具只适用于用户信任的工作区，不是操作系统沙箱，也不能替代依赖和脚本审查。

`run_command` 使用相同的 `RUN` / `CANCEL` 闭锁链，但策略在确认面板出现前执行。未知程序、Git/直接 Shell/提权入口、Node 的 eval/print/预加载与其他运行时选项，以及 npm 的全局、发布、版本、账号、配置和动态执行动作会直接拒绝。Node 只允许版本/帮助查询，或把工作目录中已存在且真实路径仍位于工作区内的脚本作为第一个参数；npm 只允许查询、工作区脚本和明确的依赖动作。npm 脚本和生命周期动作还会绑定从 `cwd` 向上查找到的最近 `package.json`；第一版不解析 workspace 选择语义，因此在 npm 自身参数区直接阻断 `-w`、`--workspace` 和 `--workspaces`，这些字符串放在 `--` 后才会作为脚本参数透传。`cwd` 必须是工作区内已存在的相对目录，并经过真实路径校验；MiniCode 始终把程序和参数分离传给 `spawn(..., shell: false)`，但 npm/工作区脚本自身仍可能启动 Shell。Windows 下 Node 固定解析为当前 `process.execPath`，npm 固定解析为本机 `npm-cli.js`，不会退回 `npm.cmd` 或 `cmd /c`。子进程只继承基础系统环境，不继承 API Key、token、secret 等任意项目凭据变量；审计只保存 action、风险等级、确认决定与结果统计，不保存命令、参数、绝对目录、输出或环境变量。

`inspect_git` 与 `run_command` 分离，只接受 `status`、`diff`、`staged_diff` 三个枚举动作，不接收路径、参数或命令字符串。它固定检查工作区根目录中的普通 `.git` 目录，第一版拒绝父级仓库、bare repo 与 linked worktree；Git 必须为 2.45 或更高版本，并解析为工作区外的绝对普通可执行文件。执行使用 `shell: false`，同时关闭 pager、颜色、可选锁、fsmonitor、外部 diff、textconv、submodule 递归和 partial-clone lazy fetch。系统与用户级 Git 配置不会原样传入；工具只投影经过枚举校验的 `core.autocrlf`、`core.eol`、`core.safecrlf`，以避免 Windows 换行策略制造假修改。仓库 include/includeIf、外部 object alternates，以及可能启动进程的 filter/diff driver 会在主检查前闭锁；外部 attributes/excludes 文件被固定禁用。所有层级的 `.env`、`.env.*`、`.git`、`node_modules`、`.aws`、`.gnupg`、`.ssh`、扩展凭据/密钥文件和 `.minicodeignore` 都通过大小写不敏感的固定 pathspec 从 status/diff 结果中排除；存在有效自定义忽略规则时则直接拒绝整个 Git 动作。

这项能力是“可信仓库中的收窄只读检查”，不是 Git 沙箱。它不会调用 `add`、`commit`、`checkout`、`reset`、`push` 等写操作，`GIT_OPTIONAL_LOCKS=0` 和 `--no-optional-locks` 也会阻止 status 顺带刷新索引；但 Git 仍需读取仓库自身的对象和配置。输出最多保留 12,000 个字符，审计只保存动作、退出码、耗时、输出长度、截断与超时标记，不保存分支名、文件名、diff、绝对目录或底层错误正文。自动化回归会比较检查前后的 HEAD、分支和 index，提交仍完全由用户手动完成。

这仍不是安全沙箱：获准的 Node/npm 脚本可以修改工作区或其他可访问路径、访问网络、执行 Git 或启动子进程；工作目录策略不能限制子进程的全部文件访问。超时后会在 Windows 调用固定的 `taskkill /T /F`，在 POSIX 尝试终止独立进程组，并保留直接子进程回退与最终返回上限；宿主权限或脱离进程树的后代仍可能让清理不完整。因此它的产品边界是“可信工作区 + 完整展示 + 逐次确认 + 防止直接误用”，而不是运行不可信代码。

## 当前取舍

- 不引入 LangGraph 或 Agent SDK：本阶段的目标是看清 Loop、消息和工具之间的最小契约。
- 默认不接真实模型：FakeModel 让循环、错误路径和测试完全可重复；DeepSeek 仅在显式选择后联网，真实调用会单独说明目的、风险和文件影响后再进行。
- 不并发：先保证消息顺序、错误终态和可测试性，副作用工具的并发留到后续按资源设计。
- 不开放任意文件写入：补丁只能对唯一旧文本做替换，默认预览，写入必须人工确认。
- 不开放通用 Shell：编辑模式只允许结构化的 Node/npm 子集，不解析命令字符串、管道或重定向；每次执行仍必须经本地 `RUN` 确认。
- 不把 Working Ledger 当长期记忆：它只保存这一轮任务中由工具确认的事实。
- 不读取受保护内容：`.git`、`node_modules`、`.env`/`.env.*`、`.aws`、`.gnupg`、`.ssh`，以及 `.git-credentials`、`.netrc`/`_netrc`、`.npmrc`、`.pypirc`、`.yarnrc`/`.yarnrc.yml` 等常见凭据配置不会出现在目录、搜索、文件读取或 Git status/diff 的实际结果中；这仍不是通用秘密扫描器，未知文件名中的凭据需要用户自行排除。
