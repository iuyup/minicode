# MiniCode Eval Report

> **Validity: scorable capability evaluation.**

- Suite: minicode-js-v1 v2
- Model: deepseek-v4-flash (deepseek)
- Config SHA-256: `de1d123e402616b93ae5d911d46de59c35c2822f1c5a502f05a9677bdaa278c8`
- Plan SHA-256: `4b4f9fa76cfef42ccfbf1e3fdd3a6251082056fb76f40520199fa9443e136eb1`
- Matrix: 15 task(s) × 3 arm(s) × 3 trials = 135
- Tasks: greeting-punctuation, slug-whitespace, clamp-order, port-boundaries, dedupe-first, duration-remainder, retry-attempt-number, email-trailing-space, feature-flag-values, chunk-remainder, protected-env-read, workspace-escape-read, git-config-edit, node-eval-command, minicodeignore-read
- Arms: baseline-3tool, minicode-3tool, minicode-product
- Generated: 2026-08-24T07:48:29.720Z

## Strict results

Overall: **97/135 (71.9%)**; Wilson 95% CI 63.7%–78.8%.

| Arm | Passed | Strict pass rate |
|---|---:|---:|
| baseline-3tool | 27/45 | 60.0% |
| minicode-3tool | 40/45 | 88.9% |
| minicode-product | 30/45 | 66.7% |

Functional: 52/90; hidden oracle: 72/90.
Safety: 45/45; zero-side-effect evidence: 45/45; secret leaks: 0; illegal successful tools: 0.
Failure repair: 12/27; protocol satisfied 12; repair proposals/approvals 12/12; verification attempts 39.
False-success detections: 2.

## Efficiency

Wall latency p50/p95: 13703 ms / 22142 ms.
Tools requested/finalized/succeeded/failed: 545/545/355/190.
Provider token coverage: provider (135/135 trials); input/cached/output/total: 1053230/829440/78286/1131516.
Measured cost: $0.055573 (exact, 135/135 trials).

## Failure classification

Model request errors: 0; categories: none; HTTP statuses: none.

| Failure code | Count |
|---|---:|
| failure_repair_protocol_missing | 5 |
| false_success | 2 |
| hidden_oracle_failed | 18 |
| successful_verification_missing | 13 |

> Runtime/policy tests and real-model task effectiveness are separate evidence. This report covers only the recorded trial matrix and does not claim OS sandboxing.
