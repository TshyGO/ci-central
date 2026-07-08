# ci-central

集中化的可复用 CI workflow。目前提供 **AI PR Review**(多模型并行审查 PR,中文输出,支持 thinking)。

各业务仓库不再各自维护审查逻辑,只放一个十几行的"瘦身调用",指向这里的 `.github/workflows/pr-review.yml`。**换供应商 / 换模型 / 改 prompt 时,绝大多数情况只改这一个仓库。**

---

## 架构

```
业务仓库 (.github/workflows/ai-pr-review.yml)   ← 瘦身 caller,~10 行
        │  uses: Nebulalab228/ci-central/.github/workflows/pr-review.yml@main
        │  secrets: inherit
        ▼
ci-central/.github/workflows/pr-review.yml     ← 真正的审查逻辑(本仓库)
        │  调 OpenAI 兼容端点 /chat/completions
        ▼
供应商:OpenCode Go (https://opencode.ai/zen/go/v1)
        模型:glm-5.2 + qwen3.7-plus,各自带一个跨上游的 fallback
```

### ⚠️ 选模型看的是「上游」,不是模型本身

OpenCode Go 只是个网关,背后转发给若干第三方上游。**一个上游挂了,它下面挂的所有模型会同时返回 503 `failover_exhausted`。**
2026-07 出现过两次多小时宕机(07-02、07-06→07-07),原因就是当时的第二个模型 `qwen3.7-max` 唯一的上游 `Console Go` 躺了。

已实测的归属(2026-07-08):

| 上游 | 模型 |
|---|---|
| **`Console Go`**(不稳定,别用) | `qwen3.7-max`、`deepseek-v4-pro`、`deepseek-v4-flash`、`kimi-k2.7-code`、`kimi-k2.5`、`minimax-m2.7` |
| `Alibaba` | `qwen3.7-plus` |
| `MiniMax` | `minimax-m3`(会把 `<think>` 写进 `content`,workflow 里已剥离) |
| `moonshotai` | `kimi-k2.6` |
| `fireworks` / `frank` | `glm-5.2`(两个上游,网关能自己 failover) |

**`models` 里的模型和它的 `fallbacks` 必须落在不同上游**,否则 fallback 形同虚设。

重新测归属的办法——故意发一个非法参数,读错误里的 provider 名:

```bash
curl -sS "$BASE/chat/completions" -H "authorization: Bearer $KEY" \
  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"temperature":99}'
# → {"error":{"message":"Error from provider (Console Go): ..."}}
```

平时也不用猜:每次 review 的 job 日志里都有 `[<model>] upstream=<实际上游>`。

**密钥/地址(secret)来源,分两种仓库:**

| 仓库类型 | secret 来源 | 原因 |
|---|---|---|
| **公开仓**(NebulaLab-Docs、NebulaLab-Plugins) | **组织级 secret** `PR_AGENT_OPENAI_API_BASE` / `PR_AGENT_OPENAI_KEY` | org secret 可下发给公开仓 |
| **私有仓**(NebulaLab) | **仓库级 secret**(同名) | ⚠️ GitHub 免费组织的 org secret **不能**下发给私有仓 |

> 所有仓库必须在 `Nebulalab228` 组织内,且 `secrets: inherit` 会把 caller 仓库可见的 secret 透传给本可复用 workflow。

---

## 常见操作

### 1. 换模型 / 改默认模型(改 1 处)

编辑本仓库 `.github/workflows/pr-review.yml` 顶部的 input 默认值:

```yaml
on:
  workflow_call:
    inputs:
      models:
        default: "glm-5.2,qwen3.7-plus"          # ← 改这里(逗号分隔,多个并行)
      model_labels:
        default: '{"glm-5.2":"GLM-5.2","qwen3.7-plus":"Qwen3.7-Plus", ...}'   # ← 顺手改显示名
      fallbacks:
        default: '{"glm-5.2":["kimi-k2.6"],"qwen3.7-plus":["minimax-m3"]}'    # ← 必须换上游!
```

改之前**先查上游归属**(见上文表格),别把主模型和它的 fallback 放在同一个上游。合并到 `main` 后,所有业务仓库下次审查自动用新模型。可用模型列表:

```bash
curl -s https://opencode.ai/zen/go/v1/models -H "Authorization: Bearer <KEY>" | jq '.data[].id'
```

> 个别仓库想用不同模型,可在它的瘦身 caller 里 `with: { models: "..." }` 覆盖,不影响其它仓库。

### 1b. diff 预算

`diff_char_budget`(默认 100000)是发给模型的 **patch 正文**字符上限。按文件整块打包,**不会把某个 patch 从中间切断**;测试文件排在最后,不够时先丢测试。放不下的文件会在 prompt 末尾列出来。

> 历史坑:旧版硬编码 24000 且从中间一刀切,PR #374 的 18 个文件里有 10 个(**全部前端组件**)根本没进 prompt,模型只能反复说"前端组件无法审阅"。

### 2. 换供应商 / 换 key(改 2 处)

新供应商需是 **OpenAI 兼容**(`/chat/completions`,返回 `choices[].message.content`;思考链放 `reasoning_content`)。

```bash
# (a) 公开仓 —— 改组织级 secret(覆盖 Docs / Plugins)
gh secret set PR_AGENT_OPENAI_API_BASE --org Nebulalab228 --visibility selected \
  --repos "NebulaLab,NebulaLab-Docs,NebulaLab-Plugins" --body "<新 base>"
gh secret set PR_AGENT_OPENAI_KEY      --org Nebulalab228 --visibility selected \
  --repos "NebulaLab,NebulaLab-Docs,NebulaLab-Plugins" --body "<新 key>"

# (b) 私有仓 NebulaLab —— 改它自己的仓库级 secret
gh secret set PR_AGENT_OPENAI_API_BASE -R Nebulalab228/NebulaLab --body "<新 base>"
gh secret set PR_AGENT_OPENAI_KEY      -R Nebulalab228/NebulaLab --body "<新 key>"
```

> 想做到"真·改 1 处":把 NebulaLab 改为公开仓,或把 org 升级到 GitHub Team——届时私有仓也能吃 org secret,(b) 步可省。

### 3. 改 prompt / 审查重点(改 1 处)

编辑本仓库 `pr-review.yml` 里 `script:` 内的 `system` / `user` 文案。

### 4. 接入一个新仓库

1. 把仓库转入 `Nebulalab228` 组织。
2. 加文件 `.github/workflows/ai-pr-review.yml`,内容见下方"瘦身 caller 模板"。
3. secret:公开仓自动吃 org secret(若用 `--visibility selected` 记得把新仓库加进 `--repos`);私有仓需 `gh secret set ... -R <repo>` 各设一份。

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
    uses: Nebulalab228/ci-central/.github/workflows/pr-review.yml@main
    permissions:
      contents: read
      issues: write
      pull-requests: write
    secrets: inherit
```
</details>

### 触发方式

- 开 / reopen / ready-for-review / push 到 PR → 自动审查。
- 在 PR 里评论 `/review`(限 OWNER/MEMBER/COLLABORATOR)→ 手动重审。

---

## 维护者备忘(踩过的坑)

- **本仓库必须保持公开**:GitHub 不允许"公开仓调用私有仓的可复用 workflow";本仓库公开后,公开+私有业务仓都能调。本仓库内**无任何密钥**(secret 运行时注入),公开安全。
- **免费 org 的私有仓**:用不了 org secret,也用不了 ruleset(返回 403)。私有业务仓只能各自带 repo secret。
- **业务仓的 main 有 ruleset 拦直推时**:临时给 ruleset 加 `RepositoryRole admin / always` bypass → `gh pr merge <n> --admin --squash` → 把 `bypass_actors` 还原。
- **测 `/review` 别用 Git Bash**:它会把 `/review` 当路径转换成 `D:/Git/review` 导致 `if` 不匹配。用 PowerShell 发评论,或设 `MSYS_NO_PATHCONV=1`。
- 模型响应:最终结论读 `message.content`,思考链读 `message.reasoning_content`。
- **别加 `enable_thinking: true`**。它曾经能用(当时 `glm-5.2` 走 `frank` 上游),网关把 `glm-5.2` 换到 Fireworks 之后直接 400:`Extra inputs are not permitted, field: 'enable_thinking'`。而且**根本不需要**——会思考的模型不带这个字段照样返回 `reasoning_content`(实测 glm-5.2 28266 字、qwen3.7-plus 24417 字)。同理,任何"可选参数"都可能被下一个上游拒绝,`callModel()` 会按名字摘掉被拒字段重试一次。
- **上游会在你不知情时被换掉**。同一个模型 id,今天是 `frank/GLM-5.2`,明天是 `accounts/fireworks/models/glm-5p2`,请求契约跟着变。所以请求体只带各家都认的字段,并且靠 job 日志里的 `upstream=` 追踪实际由谁服务。
- **改完先跑测试**:`node test/pr-review.test.mjs`。它把 `pr-review.yml` 里那段内联 `script:` 原样抠出来,配 mock 的 GitHub API 和 stub 的 `fetch` 执行,覆盖降级链、剥 `<think>`、字段自愈、diff 打包/截断、发评论失败等路径。不需要任何密钥,PR 上自动跑(见 `.github/workflows/test.yml`)。
