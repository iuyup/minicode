# MiniCode

> A small, auditable TypeScript coding agent that keeps plans, edits, commands, and evidence under local control.

[![CI](https://github.com/iuyup/minicode/actions/workflows/ci.yml/badge.svg)](https://github.com/iuyup/minicode/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** · [简体中文摘要](#简体中文摘要)

MiniCode is an experimental local TUI coding agent for developers who want to see where a model's proposal ends and local authority begins. It combines a compact Agent Loop with explicit approval gates, narrow tools, source evidence, and redacted JSONL audit events.

It is designed for trusted local workspaces. It is not an operating-system sandbox. Its dedicated Git tool is read-only, while approved project scripts remain outside that guarantee.

## Why MiniCode

Most coding-agent demos focus on how much the model can do. MiniCode focuses on what the runtime can prove and control:

- the model may propose a tool call, but a local registry and policy decide whether it exists and is allowed;
- guided plans, patches, and commands pause for exact local controls before side effects;
- remote edit mode requires a successful read before patching, and every applied patch requires a real project check;
- Git access is limited to `status`, `diff`, and `staged_diff`;
- rejected, cancelled, failed, and successful tool calls all receive a terminal lifecycle event;
- audit records keep security metadata while omitting source text, patches, command output, Git diffs, and API keys.

The TUI is built with [`@mariozechner/pi-tui`](https://www.npmjs.com/package/@mariozechner/pi-tui).

## Guided edit workflow

```text
task
  -> plan preview -------------------- CONTINUE / CANCEL
  -> search and read
  -> patch preview ------------------- APPLY / CANCEL
  -> project check ------------------- RUN / CANCEL
  -> optional bounded repair
  -> optional read-only Git status and diff
  -> human commit outside MiniCode
```

The confirmation words are case-sensitive local controls. They are intercepted by the TUI and are not sent to the model as chat messages.

| Control | Meaning |
| --- | --- |
| `CONTINUE` | Accept the displayed plan or one bounded repair direction |
| `APPLY` | Apply the exact patch currently shown |
| `RUN` | Start the exact project check or structured command shown |
| `CANCEL` | Reject the pending action without performing it |

## Local enforcement

| Area | Current boundary |
| --- | --- |
| Files | Workspace-relative paths only; built-in protection for `.git`, `.env*`, `node_modules`, and a fixed set of common credential and key paths |
| Project rules | `.minicodeignore` can only narrow MiniCode's workspace access; it cannot re-allow built-in protected paths, and invalid rules fail closed |
| Edits | Existing small UTF-8 text files only; one unique exact-text replacement; full preview and identity re-check before atomic replacement |
| Commands | Structured `program + args[] + cwd`; a restricted Node/npm subset; no arbitrary shell, pipes, redirects, elevation, or model-provided environment variables |
| Validation | Fixed `test` and `check` project actions; a successful patch must be followed by a real successful `test` before completion |
| Git | Read-only `status`, `diff`, and `staged_diff`; no `add`, `commit`, `checkout`, `reset`, or `push` |
| Remote models | Only explicitly selected and configured remote Profiles can send task and workspace evidence to a provider |
| Audit | Redacted JSONL lifecycle and policy metadata with a terminal outcome for each accepted tool call |

The fixed sensitive-path rules reduce accidental exposure but are not a general secret scanner. A valid custom `.minicodeignore` also constrains edit and command paths; Git inspection fails closed when custom rules could not be represented safely.

See [SECURITY.md](SECURITY.md) for the complete trust model and reporting guidance.

## Quick start

Requirements:

- Node.js 22.18.0 or newer;
- Git 2.45 or newer when using the read-only Git tool;
- when using read-only Git inspection, a workspace that is exactly the root of a normal checkout with a real `.git` directory; parent repositories, bare repositories, and linked worktrees are rejected.

```sh
git clone https://github.com/iuyup/minicode.git
cd minicode
npm ci
npm run mini
```

The default `fake` Profile is fully offline and deterministic. It is a fixed demonstration model, not a general-purpose coding model. For example, in the MiniCode repository you can ask:

```text
Please inspect Git status and the unstaged diff, then summarize them.
```

If PowerShell blocks the `npm.ps1` shim on Windows, use `npm.cmd ci` and `npm.cmd run mini` instead.

MiniCode is currently installed from source and is not published as an npm package. After reviewing and trusting the checkout, `npm link` can expose the local `mini` command globally.

## Use a remote model

Remote Profiles may receive your current task, directory and search results, source snippets, Git output, edit parameters, and bounded output from approved checks or structured Node/npm commands. Later requests in the same TUI session may also include up to six recent user-task and final-answer pairs. `/clear` and Profile switching clear that conversation history. Review the workspace before enabling a remote Profile.

### DeepSeek

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
npm.cmd run prepare:edit-smoke
npm.cmd run mini -- --profile deepseek --mode edit --guided --workspace playground\edit-smoke
```

Bash-compatible shells:

```sh
export DEEPSEEK_API_KEY="your-key"
npm run prepare:edit-smoke
npm run mini -- --profile deepseek --mode edit --guided --workspace playground/edit-smoke
```

The DeepSeek Profile defaults to `deepseek-v4-flash`. Override it with `DEEPSEEK_MODEL` or `--deepseek-model`.

### OpenAI-compatible endpoint

Set these environment variables:

| Variable | Purpose |
| --- | --- |
| `MINICODE_OPENAI_BASE_URL` | API base URL, normally ending in `/v1` |
| `MINICODE_OPENAI_MODEL` | Model identifier |
| `MINICODE_OPENAI_API_KEY` | Bearer API key |

Then start the TUI:

```sh
npm run mini -- --profile openai-compatible --workspace .
```

The endpoint must support Chat Completions tool calls. MiniCode appends `/chat/completions` to the configured base URL. HTTPS is required except for loopback addresses unless insecure HTTP is explicitly enabled.

## Profiles and modes

| Option | Purpose |
| --- | --- |
| `--profile fake` | Default offline fixed demonstration |
| `--profile deepseek` | Built-in DeepSeek-compatible remote Profile |
| `--profile openai-compatible` | Generic Bearer-key Chat Completions Profile |
| `--mode read` | Default remote mode: overview, listing, search, read, and read-only Git inspection |
| `--mode edit` | Adds controlled patching, fixed checks, and restricted Node/npm commands |
| `--guided` | Adds plan approval; in edit mode, an executed failed check can additionally enter one bounded repair decision |
| `--require-source-evidence` | Read-only `src/` evidence workflow with validated line citations; incompatible with `--mode edit` and `--guided` |
| `--workspace <path>` | Select the trusted workspace |
| `--audit <path>` | Override the default user-level JSONL audit path |

Inside the TUI, use `/model` to list Profiles, `/model <profile>` to switch, `/details` to expand lifecycle events, and `/help` for the short command reference. Selecting a remote Profile does not make a request by itself; submitting a task does.

## Evaluation

The repository includes a recorded DeepSeek V4 Flash evaluation matrix from 2026-08-24: 15 tasks × 3 configurations × 3 trials.

| Configuration | Strict passes | Rate |
| --- | ---: | ---: |
| `baseline-3tool` | 27/45 | 60.0% |
| `minicode-3tool` | 40/45 | 88.9% |
| `minicode-product` | 30/45 | 66.7% |
| **Overall** | **97/135** | **71.9%** |

All 45 safety-task trials passed, with no observed secret leakage or successful illegal tool use in this fixed matrix. The lower full-product score is also important: more policy and workflow constraints can make task convergence harder. The harness and plan can be rerun, but an external model service is nondeterministic and the same score is not guaranteed. These results describe this model, configuration, and task set only; they are not a general capability or isolation guarantee.

Read the [full evaluation report](docs/evals/deepseek-v4-flash-2026-08-24/EVAL_REPORT.md) for methodology, limitations, and provenance.

## Validate the repository

```sh
npm run check
npm test
npm run test:success-chain
```

GitHub Actions runs `npm ci`, `npm run check`, and `npm test` with Node.js 22.18.0 on Windows and Ubuntu. The success-chain test exercises plan approval, reading, patch approval, a real npm test, bounded repair, and read-only Git closeout with a deterministic scripted model.

## Current scope

MiniCode v0.1.0 currently includes the TUI, offline fixed demos, remote Profiles, controlled exact-text edits, structured Node/npm execution, read-only Git inspection, source-evidence validation, redacted audit events, and one bounded guided repair loop.

It does not include an arbitrary shell, automatic Git writes, a Web UI, browser tools, multi-agent orchestration, a remote sandbox, or npm package distribution. Model behavior remains probabilistic, and the offline FakeModel only proves deterministic runtime paths.

The current TUI copy and built-in demonstration tasks are Chinese-first. The English README documents the same runtime, but the interactive product has not yet been fully localized.

Issues and focused pull requests are welcome. For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of posting secrets or private source in a public issue.

## License

MiniCode is licensed under the [MIT License](LICENSE). Copyright © 2026 iuyup.

---

## 简体中文摘要

MiniCode 是一个轻量、可审计的 TypeScript TUI Coding Agent。它关注的不是让模型获得尽可能多的权限，而是把“模型建议做什么、本地运行时允许做什么、用户最终批准了什么”分开。

项目目前处于实验阶段，适合可信的本地工作区、Agent 工程学习和受控流程演示。它不是操作系统沙箱；专用 Git 工具只读，但获批运行的项目脚本不在这一保证范围内。

### 为什么做 MiniCode

- 工具是否存在、参数是否合法、路径是否允许，都由本地代码判断，而不是提示词决定；
- guided 编辑流程会在计划、补丁和命令前分别等待 `CONTINUE`、`APPLY` 和 `RUN`；
- 远程 edit 模式在修改前必须成功读取目标文件，每次已应用的修改都必须通过真实 `test` 才能完成任务；
- Git 只开放 `status`、`diff` 和 `staged_diff`，提交与推送始终由用户手动完成；
- 审计保存工具生命周期和安全元数据，但不保存源码、补丁、命令输出、Git diff 或 API Key；
- 默认 `fake` Profile 完全离线，但只支持固定演示，不理解任意编码任务。

推荐的受控编辑流程：

```text
任务
  -> 计划预览 ------------------------ CONTINUE / CANCEL
  -> 搜索与读取
  -> 补丁预览 ------------------------ APPLY / CANCEL
  -> 项目验证 ------------------------ RUN / CANCEL
  -> 必要时进行一次有界修复
  -> 可选的 Git status/diff 只读收尾
  -> 用户在 MiniCode 外手动提交
```

### 快速开始

需要 Node.js 22.18.0 或更高版本。使用 Git 只读工具时，还需要 Git 2.45 或更高版本。

```sh
git clone https://github.com/iuyup/minicode.git
cd minicode
npm ci
npm run mini
```

Windows PowerShell 如果拦截 `npm.ps1`，请改用 `npm.cmd ci` 和 `npm.cmd run mini`。

真实 DeepSeek 的推荐演示配置：

```powershell
$env:DEEPSEEK_API_KEY = "your-key"
npm.cmd run prepare:edit-smoke
npm.cmd run mini -- --profile deepseek --mode edit --guided --workspace playground\edit-smoke
```

启用远程 Profile 后，提交任务可能向服务商发送当前任务、目录与搜索结果、源码片段、Git 输出、编辑参数，以及获批验证或结构化 Node/npm 命令的有限输出。同一 TUI 会话中的后续请求还可能携带最近 6 轮“用户任务 + 最终回答”；`/clear` 或切换 Profile 会清空这部分历史。使用前请先确认工作区中没有不应外发的内容。

### 安全边界

MiniCode 的限制属于可信工作区上的 Agent 层策略，不是进程或文件系统沙箱。用户批准运行的 Node/npm 项目代码仍可能访问网络、修改 MiniCode 之外的文件或启动子进程。不要直接在陌生仓库、客户数据或恶意代码上使用远程 Profile；完整说明见 [SECURITY.md](SECURITY.md)。

### 真实模型评测

2026-08-24 的固定 DeepSeek V4 Flash 矩阵共 135 次运行：总体严格通过率为 71.9%，三工具 MiniCode 配置为 88.9%，完整产品配置为 66.7%，安全任务为 45/45。完整产品配置分数更低，说明增加权限和确认约束后，模型收敛仍是当前最需要改进的问题。

这些数据只代表该模型、配置和任务矩阵，不代表通用能力或系统隔离强度。详见[完整评测报告](docs/evals/deepseek-v4-flash-2026-08-24/EVAL_REPORT.md)。

### 验证与许可证

```sh
npm run check
npm test
npm run test:success-chain
```

CI 使用 Node.js 22.18.0 在 Windows 和 Ubuntu 上执行安装、类型检查与完整测试。MiniCode 采用 [MIT License](LICENSE)。Copyright © 2026 iuyup。

[返回英文介绍](#minicode)
