# ci-central

NebulaLab 系列仓库的 AI PR Review 唯一中央实现。业务仓库只保留稳定 caller；模型、供应商、协议、fallback、prompt、预算、重试和仓库审核策略全部由本仓库维护。

## 边界

```text
业务仓库 .github/workflows/pr-agent.yml
  ├─ PR 与 /review 触发
  ├─ concurrency 与权限
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
├─ TshyGO__NebulaLab.json
├─ TshyGO__NebulaLab-Docs.json
└─ TshyGO__NebulaLab-Plugins.json
```

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

### 一次性迁移兼容层

在三个 caller 全部切换到固定 Lane 槽位前，reusable workflow 暂时声明旧的 `PR_AGENT_OPENAI_*`、`PR_AGENT_TENCENT_*` 和 `PR_AGENT_GOOGLE_AI_KEY`，仅在对应 Lane 新槽位为空时回退读取。缺少凭据的 Lane 会发布一条配置诊断，其他 Lane 继续审核。所有 caller 和 Lane Secret 验证完成后，必须从中央 workflow 删除这组旧声明和 `LEGACY_*` 环境映射；仓库 JSON 和最终 caller 不得引用它们。

## 配置契约

每个仓库 JSON 包含：

- `review_policy`：系统 prompt、diff 预算、单次请求超时、单模型总预算和重试次数。
- `lanes[].id`：固定 `A`、`B` 或 `C`，也是 Secret 槽位。
- `lanes[].provider`：运维标签；不会用于选择 Secret。
- `lanes[].protocol`：`openai-chat-completions` 或 `google-generate-content`。
- `primary` 与 `fallbacks`：Lane 内有序模型链。
- 模型的 `context_profile` 与 `max_output_tokens`：Qwen、GLM、Gemini 使用完整上下文；Kimi 使用 `kimi-k3-throttled`。

`review-action` 在发送模型请求前校验配置。文件名、`repository` 字段和 `github.repository` 必须一致；未知仓库会失败关闭，不会落回某个默认模型。

reusable workflow 会从 `github.workflow_ref` 解析调用它的 branch、tag 或 commit，并检出同一版本的 `review-action` 与仓库 JSON，避免 workflow 固定在旧版本时却误用 `main` 的新配置。

## 精度与节流保证

- reusable job 按仓库、事件类型和 PR 号启用 `cancel-in-progress: true`。
- 上下文收集前、模型调用前、发布评论前分别核对 PR head SHA。
- Lane 主模型成功时绝不调用 fallback。
- 配额、认证、HTML 验证页、DNS、TLS 和共享端点故障会短路当前 Lane，不影响其他 Lane。
- Qwen、GLM、Gemini 保留完整审核上下文和 16384 输出上限。
- Kimi 只在 Qwen 失败时调用：完整文件清单、1000 字符代表性 patch、8192 输出上限且不发送 `temperature`。
- 每个健康 Lane 只发布一条稳定标记评论；隐藏 reasoning 永不进入 PR 评论。
- 未配置或失败的 Lane 会发布诊断；如果所有 Lane 都只有诊断而没有真实模型 review，job 明确失败。

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
  group: ai-pr-review-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.issue.number }}
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
