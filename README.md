# ci-central

集中化的可复用 CI workflow。目前提供 **AI PR Review**(多模型并行审查 PR,中文输出,支持 thinking)。

各业务仓库不再各自维护审查逻辑,只放一个十几行的"瘦身调用",指向这里的 `.github/workflows/pr-review.yml`。**换供应商 / 换模型 / 改 prompt 时,绝大多数情况只改这一个仓库。**

---

## 架构

```
业务仓库 (.github/workflows/ai-pr-review.yml)   ← 瘦身 caller,~10 行
        │  uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
        │  secrets: 显式映射两个 PR Agent 仓库级 secret
        ▼
ci-central/.github/workflows/pr-review.yml     ← 真正的审查逻辑(本仓库)
        │  默认调 /chat/completions；Grok 4.5 单独调 /responses
        ▼
供应商:OpenCode Go (https://opencode.ai/zen/go/v1)
        模型:glm-5.2 + kimi-k3 + grok-4.5,各自带 fallback
```

每个模型出一条独立评论(评论头 `<!-- ai-pr-review-bot:<model> -->`),三条并行发。

### OpenCode Go 模型协议兼容

- `kimi-k3` 是默认且明确要求的 Kimi reviewer。Moonshot 要求 K3 完全省略 `temperature`；workflow 按该契约发送。`kimi-k2.6` 只作为 K3 上游故障时的第一备用，`qwen3.7-max` 是第二备用。
- K3 是慢速深度推理模型：为保证它在 GitHub Actions 的 5 分钟请求窗口内由本模型完成，K3 会收到完整文件名列表、1000 字符 patch 样本、精简 PR 摘要和 8192 completion token，定位为高层风险复核。K2.6/K2.7 的 Kimi 上下文上限仍为 50000；GLM/Grok 继续获得完整 `diff_char_budget`（默认 100000）。若 Kimi 只有 `reasoning_content`、没有最终 `content`，workflow 不会把私有推理当 review 发布，而是转到明确标注的 fallback。
- `grok-4.5` 使用 `/responses` 和 `max_output_tokens`。2026-08-06 的实际 PR 日志显示其 `/chat/completions` 路径持续返回 503 `Endpoint is unavailable`；xAI 当前官方 Grok 4.5 示例以及 models.dev 的 `@ai-sdk/openai` 映射均指向 Responses 协议。
- 其余模型仍使用 `/chat/completions`、`messages`、`max_tokens`，请求形状没有变化。

### ⚠️ 选模型看的是「上游」,不是模型本身

OpenCode Go 只是个网关,背后转发给若干第三方上游。**一个上游挂了,它下面挂的所有模型会同时返回 503 `failover_exhausted`。**
2026-07 出现过两次多小时宕机(07-02、07-06→07-07),原因就是当时的第二个模型 `qwen3.7-max` 唯一的上游 `Console Go` 躺了。

当前供应商为阿里云 Model Studio 的 OpenAI 兼容端点。2026-08-11 已对其 `/models` 和 Chat Completions 做真实验证，默认并行审查模型为 `glm-5.2`、`qwen3.8-max`、`deepseek-v4-pro`。

三个模型都使用标准 `/chat/completions` 协议；workflow 只发布 `choices[].message.content`，即使供应商返回 `reasoning_content` 也不会写入 PR 评论。每条备用链仅使用上述三个已验证模型，主要覆盖单模型暂时不可用；它们共享一个端点，不能替代供应商级灾备。

**密钥/地址(secret)来源:**

| 仓库 | secret 来源 |
|---|---|
| NebulaLab | 仓库级 `PR_AGENT_OPENAI_API_BASE` / `PR_AGENT_OPENAI_KEY` |
| NebulaLab-Docs | 仓库级同名 secret |
| NebulaLab-Plugins | 仓库级同名 secret |

> 所有仓库均位于 `TshyGO` 个人账号下。调用方必须显式映射两个 secret，避免依赖组织级 secret 或跨仓继承行为。

---

## 常见操作

### 1. 换模型 / 改默认模型(改 1 处)

编辑本仓库 `.github/workflows/pr-review.yml` 顶部的 input 默认值:

```yaml
on:
  workflow_call:
    inputs:
      models:
        default: "glm-5.2,qwen3.8-max,deepseek-v4-pro" # ← 改这里(逗号分隔,多个并行)
      model_labels:
        default: '{"glm-5.2":"GLM-5.2","qwen3.8-max":"Qwen3.8-Max","deepseek-v4-pro":"DeepSeek-V4-Pro"}' # ← 顺手改显示名
      fallbacks:
        default: '{"glm-5.2":["deepseek-v4-pro"],"qwen3.8-max":["glm-5.2"],"deepseek-v4-pro":["qwen3.8-max"]}'
```

改之前先查询供应商模型列表，并对候选模型做最小 Chat Completions 实测。合并到 `main` 后，所有业务仓库下次审查自动用新模型：

```bash
curl -s "$BASE/models" -H "Authorization: Bearer $KEY" | jq '.data[].id'
```

> 个别仓库想用不同模型,可在它的瘦身 caller 里 `with: { models: "..." }` 覆盖,不影响其它仓库。

### 1b. diff 预算

`diff_char_budget`(默认 100000)是发给模型的 **patch 正文**字符上限。按文件整块打包,**不会把某个 patch 从中间切断**;测试文件排在最后,不够时先丢测试。放不下的文件会在 prompt 末尾列出来。

> 历史坑:旧版硬编码 24000 且从中间一刀切,PR #374 的 18 个文件里有 10 个(**全部前端组件**)根本没进 prompt,模型只能反复说"前端组件无法审阅"。

### 2. 换供应商 / 换 key(改 2 处)

新供应商需是 **OpenAI 兼容**(`/chat/completions`,返回 `choices[].message.content`;思考链放 `reasoning_content`)。

```bash
# 隐藏输入一次，再通过 stdin 写入三个调用仓库
read -rsp "PR Agent API base: " NEW_BASE && printf '\n'
read -rsp "PR Agent API key: " NEW_KEY && printf '\n'
for repo in TshyGO/NebulaLab TshyGO/NebulaLab-Docs TshyGO/NebulaLab-Plugins; do
  printf '%s' "$NEW_BASE" | gh secret set PR_AGENT_OPENAI_API_BASE -R "$repo"
  printf '%s' "$NEW_KEY" | gh secret set PR_AGENT_OPENAI_KEY -R "$repo"
done
unset NEW_BASE NEW_KEY
```

> GitHub 不允许读取已有 secret 的明文。轮换密钥时应从同一可信来源向三个调用仓库重新写入。

### 3. 改 prompt / 审查重点(改 1 处)

编辑本仓库 `pr-review.yml` 里 `script:` 内的 `system` / `user` 文案。

### 4. 接入一个新仓库

1. 在 `TshyGO` 账号下创建或转入仓库。
2. 加文件 `.github/workflows/ai-pr-review.yml`,内容见下方"瘦身 caller 模板"。
3. 在调用仓库设置 `PR_AGENT_OPENAI_API_BASE` 和 `PR_AGENT_OPENAI_KEY` 两个仓库级 secret。

<details><summary>瘦身 caller 模板</summary>

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
  issue_comment:
    types: [created]
concurrency:
  group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false
jobs:
  ai-pr-review:
    if: |
      github.event.sender.type != 'Bot' &&
      (
        github.event_name == 'pull_request' ||
        (
          github.event_name == 'issue_comment' &&
          github.event.issue.pull_request != null &&
          contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
          startsWith(github.event.comment.body, '/review')
        )
      )
    uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
    secrets:
      PR_AGENT_OPENAI_KEY: ${{ secrets.PR_AGENT_OPENAI_KEY }}
      PR_AGENT_OPENAI_API_BASE: ${{ secrets.PR_AGENT_OPENAI_API_BASE }}
```
</details>

### 触发方式

- 开 / reopen / ready-for-review / push 到 PR → 自动审查。
- 在 PR 里评论 `/review`(限 OWNER/MEMBER/COLLABORATOR)→ 手动重审。

---

## 维护者备忘(踩过的坑)

- **本仓库必须保持公开**:GitHub 不允许"公开仓调用私有仓的可复用 workflow";本仓库公开后,公开+私有业务仓都能调。本仓库内**无任何密钥**(secret 运行时注入),公开安全。
- **个人账号下的调用仓库**:每个仓库各自保存 repo secret，并在 caller 中显式映射。
- **业务仓的 main 有 ruleset 拦直推时**:临时给 ruleset 加 `RepositoryRole admin / always` bypass → `gh pr merge <n> --admin --squash` → 把 `bypass_actors` 还原。
- **测 `/review` 别用 Git Bash**:它会把 `/review` 当路径转换成 `D:/Git/review` 导致 `if` 不匹配。用 PowerShell 发评论,或设 `MSYS_NO_PATHCONV=1`。
- 模型响应:最终结论读 `message.content`,思考链读 `message.reasoning_content`。
- **别加 `enable_thinking: true`**。它曾经能用(当时 `glm-5.2` 走 `frank` 上游),网关把 `glm-5.2` 换到 Fireworks 之后直接 400:`Extra inputs are not permitted, field: 'enable_thinking'`。而且**根本不需要**——会思考的模型不带这个字段照样返回 `reasoning_content`(实测 glm-5.2 28266 字、qwen3.7-plus 24417 字)。同理,任何"可选参数"都可能被下一个上游拒绝,`callModel()` 会按名字摘掉被拒字段重试一次。
- **上游会在你不知情时被换掉**。同一个模型 id,今天是 `frank/GLM-5.2`,明天是 `accounts/fireworks/models/glm-5p2`,请求契约跟着变。所以请求体只带各家都认的字段,并且靠 job 日志里的 `upstream=` 追踪实际由谁服务。
- **上游会「假死」**(TCP 连上但一直不回包),不只是报 5xx。所以每个模型有一个 `MODEL_BUDGET_MS`(~6 分钟)的**总时长上限**:单次尝试封顶 `requestTimeoutMs`(5 分钟,够最重的思考响应 ~270s),预算耗尽就放弃该模型转 fallback,重试的退避永不睡过预算线。job 上还有 `timeout-minutes: 20` 兜底。**别再把这些值往大调**——曾经把单次超时抬到 480s×4 次,撞上上游假死时一个 job 空转了 26 分钟。想验证:测试里 `clockPerFetch` 用假时钟把预算路径跑通,不需要真等。
- **改完先跑测试**:`node test/pr-review.test.mjs`。它把 `pr-review.yml` 里那段内联 `script:` 原样抠出来,配 mock 的 GitHub API 和 stub 的 `fetch` 执行,覆盖降级链、剥 `<think>`、字段自愈、diff 打包/截断、发评论失败等路径。不需要任何密钥,PR 上自动跑(见 `.github/workflows/test.yml`)。
