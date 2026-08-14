# ci-central

集中化的可复用 CI workflow。目前提供 **AI PR Review**（阿里云单主模型顺序回退 + 独立 Gemini、中文输出、支持 thinking）。

各业务仓库不再各自维护审查逻辑,只放一个十几行的"瘦身调用",指向这里的 `.github/workflows/pr-review.yml`。**换供应商 / 换模型 / 改 prompt 时,绝大多数情况只改这一个仓库。**

---

## 架构

```
业务仓库 (.github/workflows/ai-pr-review.yml)   ← 瘦身 caller,~10 行
        │  uses: TshyGO/ci-central/.github/workflows/pr-review.yml@main
        │  secrets: 显式映射 Model Studio 与 Google AI Studio 的 PR Agent secret
        ▼
ci-central/.github/workflows/pr-review.yml     ← 真正的审查逻辑(本仓库)
        ├─ 阿里云 Model Studio: /chat/completions
        │    glm-5.2（阿里云唯一主模型）
        │      └─ 模型级故障才试 qwen3.8-max
        └─ Google AI Studio: generateContent
             gemini-3.7-flash（独立主模型）
```

健康状态发布两条评论：阿里云通道一条模型评论（优先 GLM-5.2，模型级 fallback 时使用 Qwen3.8-Max），以及独立 Google 通道一条 Gemini 评论。Qwen 只作为阿里云通道的模型级备用，不会并行审查，也不会额外发布阿里云评论。

### Model Studio 模型协议

- `glm-5.2`、`qwen3.8-max` 统一使用 `/chat/completions`、`messages`、`max_tokens` 与 `temperature: 0.2`。
- workflow 只发布 `choices[].message.content`。`reasoning_content` 仅用于日志长度统计，绝不会写入 PR 评论；模型未返回最终内容时将尝试已配置的 fallback。
- 默认备用链只有一个方向：`glm-5.2 → qwen3.8-max`。工作流会拒绝“某个模型既是并行主模型、又出现在 fallback 链”这类重复配置。
- 额度耗尽、认证失败、网关验证页和持续网络不可达属于整条 Model Studio 通道的共享故障；这类错误不会继续向同一端点发送完整 PR 上下文。普通模型限流、5xx、超时和空最终正文仍按原策略重试或进入 Qwen fallback，保留审核可用性。
- workflow 在上下文收集前、模型调用前和评论发布前核对 PR head。事件已过期或收集期间出现新 push 时，在发送任何模型请求前退出；模型执行期间出现新 push 或 PR 被关闭时，丢弃旧结果而不把评论挂到错误的提交上。两条主审线的完整 diff、100k 字符预算和 16k 输出上限保持不变。
- reusable job 自己也按“仓库 + 事件类型 + PR 号”启用 `cancel-in-progress`，即使某个瘦身 caller 忘记配置 concurrency，连续 push 也只保留最新自动审核；手动 `/review` 与 push 仍使用不同并发组。

### Google AI Studio 模型协议

- `gemini-3.7-flash` 使用 Google AI Studio 原生 `v1beta/models/gemini-3.7-flash:generateContent`，认证头为 `x-goog-api-key`，不是 OpenAI 兼容协议。
- 它需要调用仓库传入 `PR_AGENT_GOOGLE_AI_KEY`。该 secret 只在默认模型列表包含 Gemini 时才是必需的；只调用 Model Studio 模型的仓库无需配置它。
- workflow 仅读取 Gemini `candidates[0].content.parts[].text`，不发布任何 provider reasoning 或内部字段。

当前默认包含两个独立通道。阿里云 Model Studio 通道的唯一主模型为 `glm-5.2`，备用模型为 `qwen3.8-max`；Google AI Studio 通道继续独立运行 `gemini-3.7-flash`。2026-08-11 已对 Model Studio `/models` 和 Chat Completions 做真实验证。

两个 Model Studio 模型使用标准 `/chat/completions` 协议；workflow 只发布 `choices[].message.content`，即使供应商返回 `reasoning_content` 也不会写入 PR 评论。Qwen 只覆盖阿里云通道内的单模型暂时不可用；两者共享一个端点和套餐，不能替代供应商级灾备。Gemini 使用独立 Google 端点，不参与阿里云 fallback 链。

**密钥/地址(secret)来源:**

| 仓库 | secret 来源 |
|---|---|
| NebulaLab | 仓库级 `PR_AGENT_OPENAI_API_BASE` / `PR_AGENT_OPENAI_KEY` / `PR_AGENT_GOOGLE_AI_KEY` |
| NebulaLab-Docs | 仓库级同名 secret |
| NebulaLab-Plugins | 仓库级同名 secret |

> 所有仓库均位于 `TshyGO` 个人账号下。调用方必须显式映射 Model Studio 的两个 secret 和独立 Gemini 所需的 `PR_AGENT_GOOGLE_AI_KEY`。

---

## 常见操作

### 1. 换模型 / 改默认模型(改 1 处)

编辑本仓库 `.github/workflows/pr-review.yml` 顶部的 input 默认值:

```yaml
on:
  workflow_call:
    inputs:
      models:
        default: "glm-5.2,gemini-3.7-flash" # ← 阿里云单主模型 + 独立 Gemini
      model_labels:
        default: '{"glm-5.2":"GLM-5.2","qwen3.8-max":"Qwen3.8-Max","gemini-3.7-flash":"Gemini-3.7-Flash"}'
      fallbacks:
        default: '{"glm-5.2":["qwen3.8-max"]}'
```

改之前先查询供应商模型列表，并对候选模型做最小真实请求验证。合并到 `main` 后，所有业务仓库下次审查自动用新模型：

```bash
curl -s "$BASE/models" -H "Authorization: Bearer $KEY" | jq '.data[].id'
```

> 个别仓库想用不同模型,可在它的瘦身 caller 里 `with: { models: "..." }` 覆盖,不影响其它仓库。

### 1b. diff 预算

`diff_char_budget`(默认 100000)是发给模型的 **patch 正文**字符上限。按文件整块打包,**不会把某个 patch 从中间切断**;测试文件排在最后,不够时先丢测试。放不下的文件会在 prompt 末尾列出来。

> 历史坑:旧版硬编码 24000 且从中间一刀切,PR #374 的 18 个文件里有 10 个(**全部前端组件**)根本没进 prompt,模型只能反复说"前端组件无法审阅"。

### 2. 换供应商 / 换 key(改 2 处)

新增 OpenAI 兼容供应商使用 `PR_AGENT_OPENAI_API_BASE` / `PR_AGENT_OPENAI_KEY`。Google AI Studio 使用单独的 `PR_AGENT_GOOGLE_AI_KEY`，不能填入 OpenAI key。

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
3. 在调用仓库设置 `PR_AGENT_OPENAI_API_BASE`、`PR_AGENT_OPENAI_KEY` 和（启用 Gemini 时）`PR_AGENT_GOOGLE_AI_KEY` 仓库级 secret。

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
      PR_AGENT_GOOGLE_AI_KEY: ${{ secrets.PR_AGENT_GOOGLE_AI_KEY }}
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
- **共享错误要短路整条阿里通道**：套餐额度耗尽、认证失败、HTML 验证页，以及连续三次 `fetch failed`/DNS/TLS/拒绝连接都不是换模型能解决的问题。保持 Gemini 独立运行，但不要把同一份完整 PR 上下文继续发给同端点 Qwen。
- **不要删掉三阶段 head 检查**：caller 的 concurrency 只能尽力取消正在执行的旧 run；如果旧请求已经发出，token 无法追回。脚本自己的 preflight + pre-dispatch 检查保证过期 run 在模型请求前退出，pre-publish 检查保证运行中 push 后的旧结果不会发布到新 head。
- **改完先跑测试**:`node test/pr-review.test.mjs`。它把 `pr-review.yml` 里那段内联 `script:` 原样抠出来,配 mock 的 GitHub API 和 stub 的 `fetch` 执行,覆盖降级链、剥 `<think>`、字段自愈、diff 打包/截断、发评论失败等路径。不需要任何密钥,PR 上自动跑(见 `.github/workflows/test.yml`)。
