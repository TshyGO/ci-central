# ci-central

NebulaLab 系列仓库的 AI PR Review 唯一中央实现。业务仓库只保留稳定 caller；模型、供应商、协议、fallback、prompt、预算、重试和仓库审核策略全部由本仓库维护。

## 边界

```text
业务仓库 .github/workflows/pr-agent.yml
  ├─ PR 与 /review 触发
  ├─ 按 PR 合并自动与手动触发的并发组，新触发取消旧运行
  ├─ uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
  └─ 只映射 PR_AGENT_LANE_{A,B,C}_{KEY,API_BASE}
                         │
                         ▼
ci-central
  ├─ .github/workflows/pr-review.yml
  ├─ review-action/config/repositories/*.json
  ├─ review-action/src + dist
  ├─ scripts/
  └─ test/
```

caller 不得传入模型、供应商、fallback、prompt、token/context 预算、重试策略或仓库审核策略。`ci-center` 不放完整 NebulaLab，也不长期放 NebulaLab worktree。

## 当前 NebulaLab Lane

| Lane | 当前供应商 | 协议 | 模型链 |
|---|---|---|---|
| A | 阿里 | OpenAI Chat Completions | Qwen3.8-Max → Kimi-K3 |
| B | 腾讯 | OpenAI Chat Completions | GLM-5.2 → DeepSeek-V4-Pro |
| C | Google | Google generateContent | Gemini-3.7-Flash |

配置由 `github.repository` 自动选择：

```text
review-action/config/repositories/
├─ TshyGO__ci-central.json
├─ TshyGO__NebulaLab.json
├─ TshyGO__NebulaLab-Docs.json
└─ TshyGO__NebulaLab-Plugins.json
```

四个仓库都使用相同的三 Lane 拓扑。`ci-central` 的 policy 更侧重 reusable workflow、Action 供应链、Secret 边界和失败可见性；其余仓库按各自代码与文档风险调整 prompt。

CodeRabbit 和 GitHub Copilot 不作为默认自动审核器；三 Lane 中央审核是默认 AI review。CodeRabbit 仓库配置关闭 `reviews.auto_review`，需要时可手动触发。Copilot 自动审核需在 GitHub Copilot Code review 设置中保持关闭。

供应商、协议和 Secret 槽位绑定 Lane，不绑定模型 ID。同一个模型 ID 可以出现在不同 Lane，执行时仍使用各自 Lane 的地址和密钥。fallback 只能写在同一个 Lane 的 `fallbacks` 内，结构上不存在跨供应商 fallback。

## 固定 Secret 槽位

每个调用仓库一次性映射以下仓库级 GitHub Actions Secret：

```text
PR_AGENT_LANE_A_KEY
PR_AGENT_LANE_A_API_BASE
PR_AGENT_LANE_B_KEY
PR_AGENT_LANE_B_API_BASE
PR_AGENT_LANE_C_KEY
PR_AGENT_LANE_C_API_BASE
```

供应商迁移不改 caller。例如 Lane B 换供应商时：

1. 用 `scripts/set-lane-secret.ps1` 更新 Lane B 的 Key 与 API Base。
2. 修改目标仓库 JSON 内 Lane B 的 `provider`、`protocol` 和模型链。
3. 用 `scripts/probe-provider.ps1` 做最小真实请求验证。
4. 运行本地测试，提交并合并 `ci-central` PR。

密钥不写入配置、日志、命令参数或提交。脚本通过安全提示读取 Key，并从 stdin 交给 `gh secret set`。

### Caller 迁移状态

四个仓库 caller 已全部切换到固定 Lane A/B/C 槽位。reusable workflow 不再声明或读取任何旧供应商命名 Secret；缺少固定槽位凭据的 Lane 会发布一条配置诊断，其他 Lane 继续审核。

## 配置契约

每个仓库 JSON 包含：

- `review_policy`：系统 prompt、diff 预算、单次请求超时、单模型总预算和重试次数。
- `lanes[].id`：固定 `A`、`B` 或 `C`，也是 Secret 槽位。
- `lanes[].provider`：运维标签；不会用于选择 Secret。
- `lanes[].protocol`：`openai-chat-completions` 或 `google-generate-content`。
- `primary` 与 `fallbacks`：Lane 内有序模型链。
- 模型的 `context_profile` 与 `max_output_tokens`：Qwen、GLM、Gemini 使用完整上下文；Kimi 使用 `kimi-k3-throttled`。

`review-action` 在发送模型请求前校验配置。文件名、`repository` 字段和 `github.repository` 必须一致；未知仓库会失败关闭，不会落回某个默认模型。

reusable workflow 使用 `github.job_workflow_sha` 检出定义当前 reusable job 的同一提交，从而让 `review-action` 与仓库 JSON 精确匹配工作流版本，也不会误把业务仓的 PR ref 当成 `ci-central` ref。

## 精度、去重与节流保证

- reusable job 按仓库和 PR 号启用 `cancel-in-progress: true`：自动 PR 事件与手动 `/review` 共享同一并发组，新触发取消旧运行，不会并发更新同一组评论。
- 上下文收集前、模型调用前、发布评论前分别核对 PR head SHA。
- 每条 Lane 评论都包含 v2 机器证据：Lane、完整 40 位 head SHA、`github.job_workflow_sha` 和 `valid`、`diagnostic` 或 `partial` 状态。
- 自动触发只复用“同一 head、同一 reusable workflow 版本、状态为 `valid`”的 Lane；缺失、旧版、诊断和不完整 Lane 会单独重跑。
- 显式 `/review` 保持强制重跑语义，不受同 HEAD 去重限制。
- Lane 主模型成功时绝不调用 fallback。
- 配额、认证、HTML 验证页、DNS、TLS 和共享端点故障会短路当前 Lane，不影响其他 Lane。
- Qwen、GLM、Gemini 保留完整审核上下文；三个业务仓维持 16384 输出上限。公开的 `ci-central` 元 CI 审核更容易触发长推理，因此仅其 Lane B 的 GLM/DeepSeek completion ceiling 为 32768，单请求/单模型预算分别为 10/12 分钟。
- Kimi 只在 Qwen 失败时调用：完整文件清单、1000 字符代表性 patch、8192 输出上限且不发送 `temperature`。
- reusable job 的 30 分钟硬上限允许 `ci-central` Lane B 在 32K 主模型后执行同 Lane fallback；正常模型主动 `stop` 时不会因为 ceiling 提高而强制消耗更多 tokens。
- 每个健康 Lane 只发布一条稳定标记评论；隐藏 reasoning 永不进入 PR 评论。
- 未配置、失败或输出不完整的 Lane 会保留诊断/部分结果；任一必需 Lane 没有 `valid` 证据时，job 在发布其他健康 Lane 后明确失败。

### Draft 冻结门禁

PR 在集中修复阶段保持 Draft。每次推送后，等待 Lane A/B/C、常规 CI 和 review threads 全部稳定在同一个最终 head SHA。满足工作区 clean、成功刷新远端后的本地/远端 0/0、三条 Lane 都有当前 workflow 生成的 `valid` 证据、CI 全绿、unresolved threads 为 0 且没有待修改事项后，才标记 Ready。

`ready_for_review` 事件保留：如果该 head 已在 `synchronize` 中完成有效审核，中央工作流会直接复用三条 Lane 证据而不调用模型；此前审核失败、部分完成、来自旧 workflow 或没有生成评论时，只重跑对应 Lane。Ready 后不再修改代码；如果意外发现问题，先转回 Draft，再集中修复。最终合并应冻结完整 head SHA，并使用 `gh pr merge --admin --match-head-commit <SHA>` 防止检查结束到合并之间 HEAD 被替换。

## 运维命令

```powershell
# 只探测，不写 Secret；Key 通过安全提示输入
pwsh ./scripts/probe-provider.ps1 -Lane B -Repository TshyGO/NebulaLab -ApiBase https://example.invalid/v1

# 向三个业务仓库写固定 Lane 槽位；支持 -WhatIf
pwsh ./scripts/set-lane-secret.ps1 -Lane B -ApiBase https://example.invalid/v1

# 离线验证
node ./test/review-config.test.mjs
node ./test/pr-review.test.mjs
git diff --check
```

`probe-provider.ps1` 会依据中央配置选择协议，对 OpenAI 兼容端点先读取 `/models` 再发极小 Chat Completions 请求；Google Lane 发送极小 `generateContent` 请求。脚本不输出 Key。

## 最小 caller 模板

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  issue_comment:
    types: [created]

concurrency:
  group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

jobs:
  ai-pr-review:
    if: >-
      github.event.sender.type != 'Bot' &&
      (github.event_name == 'pull_request' ||
       (github.event_name == 'issue_comment' &&
        github.event.issue.pull_request != null &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
        startsWith(github.event.comment.body, '/review')))
    uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
    secrets:
      PR_AGENT_LANE_A_KEY: ${{ secrets.PR_AGENT_LANE_A_KEY }}
      PR_AGENT_LANE_A_API_BASE: ${{ secrets.PR_AGENT_LANE_A_API_BASE }}
      PR_AGENT_LANE_B_KEY: ${{ secrets.PR_AGENT_LANE_B_KEY }}
      PR_AGENT_LANE_B_API_BASE: ${{ secrets.PR_AGENT_LANE_B_API_BASE }}
      PR_AGENT_LANE_C_KEY: ${{ secrets.PR_AGENT_LANE_C_KEY }}
      PR_AGENT_LANE_C_API_BASE: ${{ secrets.PR_AGENT_LANE_C_API_BASE }}
```
