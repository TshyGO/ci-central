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

| Lane | 当前供应商 | 协议 | 模型链 | 是否阻塞 |
|---|---|---|---|---|
| A | OpenCode Go | OpenAI SDK / Responses SSE | Muse Spark 1.3 Contributor；失败时经 Lane C 槽位改问 Command Code 上的同一模型 | 计入两路 quorum |
| B | Anthropic 官方 API（只经 szlab 台湾专用节点出口；两个账号按 PR 号 2:1 分摊） | Anthropic SDK / Messages SSE | 每个 PR 的首次审核：Claude Sonnet 5.5（`first_pass`，effort high）；之后的提交：Claude Haiku 5.5（effort high）；Haiku 失败时经 Lane C 槽位改问 Command Code 上的 Haiku | 计入两路 quorum |
| C | Command Code | OpenAI SDK / Responses SSE | GPT-6 Luna（`gpt-6-luna`，报告校准）；失败时经 Lane A 槽位改问 Go 上的同一模型（`gpt-6-luna`） | advisory；有效时计入 quorum |

NebulaLab 的 Lane B 使用 Anthropic 官方 API（每月赠送额度）：首审由 Sonnet 5.5 完成，之后的提交由 Haiku 5.5 审核，首审结果折叠保留在同一条 Lane B 评论底部；2026-10-15 在 #1133/#1237/#1241 上实测，Sonnet 被核实的发现全部成立，Haiku 独有的发现（含两条 P1）全部是误报。首审时的 diff 中位数已是最终 diff 的 97%，因此每个 PR 只做一次首审。Haiku 在 Anthropic 上失败（额度耗尽、出口被拒或其他任何原因）时，经 Lane C 槽位改问 Command Code 上的同一模型一次；首审不跨供应商。2026-10-23 起 Lane B 槽位放两个 Anthropic 账号的 key（每月 $200 与 $100），按 PR 号 2:1 分摊，同一 PR 的首审和后续都在同一账号；某个 key 余额用完、被拒或被限流时，同一请求先换另一把 key 发一次，再按上面的规则跨供应商（见“配置契约”的 `key_weights`）。其余六个仓库的 Lane B 是 OpenCode Go 上的 Claude Haiku 5.5，失败时同样改问 Command Code 上的 Haiku。

Lane A/B 使用 OpenCode Go（整个 workspace 共用一个 5 小时/每周/每月额度池；NebulaLab 的 Lane B 除外），Lane C 使用 Command Code；额度以供应商实际返回为准，额度耗尽时返回 429 属于预期行为。每条 Lane 只有一个兜底，而且不换模型：主模型在本供应商没有产生可用审核时（任何原因，包括额度耗尽、超时、5xx、限流、认证、网络和不完整输出），把同一请求经另一条 Lane 的固定槽位改发另一供应商上的同一模型一次（见“配置契约”的 `cross_provider`）：A/B 改走 Command Code（Lane C 槽位），C 改走 Go（Lane A 槽位）。因此任一供应商用尽或故障时三路仍可发布；但三路的主模型和兜底都在 Go 与 Command Code 这两家上（只有 NebulaLab 的 Lane B 主模型在 Anthropic），两家同时不可用时这些 Lane 会一起失败，达不到两路 quorum，检查变红。失败的 Lane 仍然发布评论和诊断；七份配置均使用 `min_valid_lanes=2`，任何两路有效即可，包括 A+C 或 B+C。绿色检查不能证明每条 Lane 都成功。

### 统一 SDK 接入

A 使用官方 `openai` JavaScript SDK 的 Responses SSE；B 和 C 使用同一 SDK 的 Chat Completions SSE。每次请求创建独立 client 和 Undici dispatcher，明确 `maxRetries: 0`、禁止重定向、按当前模型预算配置响应头/正文超时；外层 AbortSignal 覆盖连接、接收和完整流迭代。没有全局 dispatcher、跨 Lane 连接共享或参数修复重发；跨 Lane 使用密钥只有跨供应商兜底一种情况，即按配置使用另一条 Lane 的固定槽位。

连接阶段最多 30 秒且不超过模型总预算；IPv4/IPv6 地址探测间隔为 1 秒，避免跨区域连接被 Node 默认 250ms 探测窗口过早放弃。地址探测不重复发送审核请求，也不会增加模型的总时间预算。

SDK 负责 SSE 分帧、UTF-8 和 JSON 解码。适配层逐事件累计最终正文，只计数而不保存 `reasoning_content`、Responses reasoning item 等供应商私有思考；收到 choice 0 的 `finish_reason` 即确定审核结果，不等待 `[DONE]` 或 TCP EOF；Chat Completions 随后最多再读 1 秒 usage 尾帧，只用于 token 统计，尾帧缺失、超时、格式错误或错误事件都不改变已确定的结果。只有正文非空且 `finish_reason=stop` 才计入有效审核；断流、缺少结束原因、截断、错误事件均不能变成有效证据。Responses 仅将 `response.completed` 且状态 `completed` 的最终 `output_text` 归一为成功；incomplete、工具调用、refusal-only、错误和断流不算有效审核。

安全日志区分响应头时间、首个事件、首个正文、正文/思考字符数、结束原因和实际耗时；不记录请求正文、Key 或私有思考。原始响应限制为 32 MiB。B 使用 Claude Haiku 5.5（输出上限 120000），C 使用 GPT-6 Luna（输出上限 65536），跨供应商兜底沿用同一模型的参数。Haiku 固定 effort high，不添加 low/关闭思考参数；B 的 Haiku 与 C 的 GPT-6 Luna 在每个供应商上的时限各 15 分钟。本地截止明确报 `REVIEW_DEADLINE`，不再把持续推理后的主动中止说成上游不可用。

SDK 对干净 EOF、`[DONE]` 和传输层 `AbortError` 都会静默结束迭代，因此适配层在原始正文层记录终止方式。流没有结束原因时仍报 `REVIEW_INCOMPLETE_STREAM`。失败评论只附 `code`、`http`、`end`、`last_event` 类型、`idle_before_end_ms` 和本地词汇内的 `body_error`；`finished` 日志记录全部脱敏证据：`incomplete_end`（`clean_close` 正常关流、`idle_close` 静默 60 秒以上后关流、`done_without_finish` 有 `[DONE]` 无结束原因、`transport_error` 被 SDK 吞掉的传输错误；未观察到正文结束时为 `unknown`）、`body_end`/`body_error`、`done_marker`、`frame_boundary`（是否停在完整 SSE 帧之后，零字节时为 null）、`max_gap_ms`、`idle_before_end_ms`、`last_event`（Chat Completions 为 `reasoning`、`content`、`no_choice:<键名>` 等，只含键名；Responses 为事件 type）以及 usage token 数；供应商报告套餐额度用尽时另记 `quota_exhausted`、`quota_window`（5h/weekly/monthly/daily）和校验过的 `quota_reset_at`，不记报错原文。TCP 断开或重置不属于这一类，仍报 `UND_ERR_SOCKET`/`ECONNRESET`。每个失败还带 `unserved`：请求在产生任何正文、推理或结束原因之前就失败时为 true，供“未受理重发”判断；`done_marker` 按数据块逐段扫描，`[DONE]` 之后再跟多少数据都不会漏判。上游接受请求后在结束原因前关流（`REVIEW_INCOMPLETE_STREAM`）时，失败评论的 Tried 列表写成 `HTTP 200, stream closed before the model finished after N s`，Action needed 说明这不是限流、额度或认证问题；此前它显示为 `HTTP request failed` 并提示检查请求或认证，NebulaLab #1296 因此被误读为限流。

依赖版本和 lockfile 在中央仓库管理；`npm run build` 打包 SDK 到 `review-action/dist/sdk-client.js`，真实审核只执行固定中央 SHA 的产物，不运行 npm、不下载依赖。CI 重建并比较产物，同时测试源码和产物的真实 TLS/SSE 行为。`SDK_LONG_HEADER_TEST=1` 可额外运行 310 秒响应头回归，验证请求不会被旧的 300 秒底层限制截断。

真实审核由固定 SHA 的 `actions/github-script` v8 执行，其 `action.yml` 声明 `using: node24`，不依赖 runner 的 shell Node 版本；添加 `setup-node` 也不会改变 JavaScript Action 自身运行时。配置解析 Action 独立使用 Node 20，不加载 SDK。没有活动 Lane 使用 Google 协议，保留的 legacy Google 分支不在这次迁移范围内。

配置由 `github.repository` 自动选择：

```text
review-action/config/repositories/
├─ TshyGO__ci-central.json
├─ TshyGO__NebulaLab.json
├─ TshyGO__NebulaLab-Docs.json
├─ ptjworks__NebulaLab-Docs.json
├─ TshyGO__NebulaLab-Plugins.json
├─ ptjworks__NebulaLab-Plugins.json
├─ TshyGO__resume-form-assistant-plugin.json
├─ TshyGO__AI-Thesis-Polisher.json
└─ TshyGO__NebulaGraph-License-Service.json
```

七个仓库（九个仓库身份，Docs 与 Plugins 同时保留迁移前后身份）都使用相同的三 Lane 拓扑；唯一差别是 NebulaLab 的 Lane B 在 Anthropic 上并带首审模型。`ci-central` 的 policy 更侧重 reusable workflow、Action 供应链、Secret 边界和失败可见性；其余仓库按各自代码与文档风险调整 prompt。业务仓 caller 固定到已审核的 ci-central commit；`ci-central` 自身使用同仓库相对 reusable workflow，使 owner 创建的 PR 能实际审核和验收本次 workflow 修改，非 owner PR 不映射 Lane 密钥。

CodeRabbit 和 GitHub Copilot 不作为默认自动审核器；三 Lane 中央审核是默认 AI review。CodeRabbit 仓库配置同时关闭自动审核、跳过提示评论和状态检查；Copilot 自动审核需在 GitHub Copilot Code review 设置中保持关闭。

供应商、协议和 Secret 槽位绑定 Lane，不绑定模型 ID。同一个模型 ID 可以出现在不同 Lane，执行时仍使用各自 Lane 的地址和密钥。`fallbacks` 只能写同一个 Lane 内的其他模型（当前七份配置都为空）。跨供应商只走模型的 `cross_provider`（2026-10-18 用户取消了“禁止跨供应商兜底”，因为同一家供应商的额度用完或故障时，同家兜底救不回来）：本 Lane 供应商上的任何失败都会触发，只发给同一模型，只用另一条 Lane 的固定 Secret 槽位，不进入那条 Lane 自己的模型链，结果仍算本 Lane 的审核。

## Lane A 数据政策与专用出口

Muse Contributor 会允许供应商将提示词及回答用于训练，非 ZDR；仅在用户明确选择并在 Go 后台 opt-in 后启用。发送 `store:false` 不会撤销 Contributor 的训练许可。跨供应商兜底时同一 Contributor 模型经 Command Code 发送，同样非 ZDR（Command Code 对 Muse 的 `x-cmd-zdr: 1` 返回 422 `cmd_zdr_no_providers`；Hy3、GLM 5.3、Kimi、Haiku 支持 ZDR，当前未强制开启）。Lane C 的 GPT-6 Luna 会把 diff 与提示词发给 Command Code 与 Go，两家对它的数据保留、训练条款和 ZDR 支持尚未核实（2026-10-19），不能当作 ZDR 模型看待；需要时先查两家文档或用 `x-cmd-zdr: 1` 实测。地区与数据政策拒绝不会被当成批准：本供应商拒绝后改问另一供应商上的同一模型，另一供应商也拒绝时发布诊断。

Go 请求带 `NebulaLab-CI-Review/1.0` User-Agent 与每仓库/PR/Lane 稳定的 `x-opencode-session`。A/B 的固定 base 为 `https://opencode.ai/zen/go/v1`；C 使用 Command Code Provider API，Lane C 槽位的 base 为 `https://api.commandcode.ai/provider/v1`（Bearer 认证，不带 `x-opencode-session`，不走 Go 的代理规则，self-hosted 直连；2026-10-15 已从 szlab 出口验证可达）。跨供应商兜底的请求按目标供应商处理：A/B 改发 Command Code 时同样直连、不带 `x-opencode-session`，日志中模型名为 Command Code 的模型 ID；C 改发 Go 上的 `gpt-6-luna` 时带本 Lane 的 `x-opencode-session`；它走 Responses、不在直连名单内，在 self-hosted 上与 Muse 一样经已批准的模型代理（2026-10-19 从 szlab 实测：GPT-6 Luna 从中国出口直连 Go 返回 403 `unsupported_country_region_territory`）。`RUNNER_ENVIRONMENT=github-hosted` 时直接连接并忽略 ambient proxy。明确的 `self-hosted` 环境中，Chat Completions 模型 `kimi-k2.7-code`、`glm-5.3`、`hy3` 使用独立直连 Agent；2026-10-10 已从 ci-review 的中国出口验证三者均返回非空最终内容及 `finish_reason=stop`。Muse Spark 1.3/1.2 直连返回 `403 RegionError`，使用已批准的模型代理：自托管 runner 可通过 `NEBULA_REVIEW_PROXY_URL=http://192.168.122.1:17890` 选择 szlab 内网 Mihomo；未设置该变量时，继续读取原有 `https_proxy` / `HTTPS_PROXY`，兼容 VPS `177.201.224.95:13128`。显式空值或不在白名单内的地址会拒绝请求，不会回退到 VPS 或直连。该变量只影响需要代理的模型，不修改 GitHub 的 runner 全局代理，也不改变 Kimi/GLM/Hy3 的直连。内网入口只允许明确的 self-hosted 环境，固定端口、不接受 URL 凭据、路径、查询或片段。未验证模型、其他协议和未知运行环境仍保留原代理要求，代理缺失或地址不匹配时拒绝直连。Claude Haiku 5.5（Messages）尚未从 ci-review 出口验证直连，因此在 self-hosted 上与 Muse 一样走已批准代理；代理失效时 Go 请求在本地被拒绝、不会发出，A/B 随即改问 Command Code 上的同一模型（直连），C 的 Command Code 主请求也直连，两路 quorum 不受代理单点影响。SDK 的代理认证只发往代理，不会在请求失败后切换出口重试。日志仅输出模型和 `direct` / `approved-proxy` 路由，不输出代理凭据。两路有效审查的 quorum 不变；Muse 出口失效时，B/C 的有效审查仍可满足门槛。

VPS 的已有 Squid 只为 `opencode.ai` 配置 Mihomo parent 且 `never_direct`；GitHub 维持原路由。Mihomo 订阅更新、健康切换、故障不直连的服务器部署独立于本仓库，不保存节点、订阅或代理密码。

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

一个槽位可以放同一供应商的多把 key（不同账号、各自的额度），每行一把；空行和首尾空白会被忽略，GitHub 会对多行 Secret 的每一行分别打码。只有一行时行为与以前完全相同。多把 key 怎样分摊见“配置契约”的 `key_weights`。旧版 runner 会把多行当成一把坏 key，所以必须先让 caller 固定到支持多行的 ci-central 版本，再写入多行 Secret。

### Caller 迁移状态

原有六个仓库 caller 已切换到固定 Lane A/B/C 槽位；NebulaGraph License Service 使用相同接口接入，其 caller 与六个 Actions Secrets 在业务仓库中配置。reusable workflow 不再声明或读取任何旧供应商命名 Secret；缺少固定槽位凭据的 Lane 会发布一条配置诊断，其他 Lane 继续审核。

## Runner 选择

可选输入 `runner_tier` 决定这个 job 跑在哪个 runner 池：

| 值 | runs-on | 用途 |
|---|---|---|
| `hosted`（默认） | `ubuntu-latest` | GitHub 托管，计入 Actions 分钟额度 |
| `review` | `ai-pr-review` | 自建 runner（szlab 隔离 VM），执行分钟不计费 |
| `build` | `nebulalab-build` | 自建 runner，供需要 root/Docker 的重负载工作流使用 |

caller 只能选择档位，**不能传入任意 runner label**。这不是为了简洁：这个 job 会拿到 Lane A/B/C 的密钥，允许 caller 指定原始 label 就等于允许它把密钥路由到任意机器上。

未识别的值解析为 `ubuntu-latest`——回落到托管池永远是安全方向，而猜测一个 label 可能把密钥放到非预期的机器上。job 的第一步会显式拒绝非法值，因此配置错误仍然会响亮地失败，而不是悄悄跑在托管池上。

不传该输入的 caller 行为完全不变。

## 配置契约

每个仓库 JSON 包含：

- `review_policy`：系统 prompt、diff 预算、单次请求超时和单模型总预算。`max_attempts` 必须为 `1`：每个模型最多一次产生输出的请求，禁止同模型重试。
- `lanes[].resend_unserved`：可选布尔值，默认 `false`。开启后，同一模型的请求在**没有产生任何模型输出**时（上游容量 429/5xx，或 200 后排队到关流都没有一个 token）可换会话重发一次；见下方“未受理重发”。当前没有 Lane 开启：2026-10-18 起 C 也关闭，每条 Lane 只在本供应商请求一次、在另一供应商请求一次。
- `lanes[].id`：固定 `A`、`B` 或 `C`，也是 Secret 槽位。
- `lanes[].provider`：运维标签；不会用于选择 Secret。
- `lanes[].protocol`：`openai-chat-completions`、`openai-responses`、`anthropic-messages` 或 `google-generate-content`。模型可用自己的 `protocol` 覆盖 Lane 协议（例如 Messages Lane 里走 Chat Completions 的备用模型），仍使用该 Lane 的固定 Secret 槽位。
- `lanes[].advisory`：可选布尔值，默认 `false`。未配置 quorum 时，该 Lane 失败不单独阻塞；配置 `min_valid_lanes` 时所有有效 Lane 都计入数量，当前七个仓库均要求任意两路有效。至少保留一条非 advisory 的 Lane。
- `lanes[].request_timeout_ms` 与 `lanes[].model_budget_ms`：可选的 Lane 级预算覆盖；未配置时继承 `review_policy`，因此放大慢模型预算不会改变其他 Lane。
- 模型的 `request_timeout_ms`：可选单模型请求上限，优先于 Lane/仓库默认值，但仍受 Lane 的 `model_budget_ms` 限制。B 的 Haiku 显式设为 900000 ms（Lane 级上限与总预算为 1800000 ms）；C 的 Lane 级请求上限与 `model_budget_ms` 均为 900000 ms，GPT-6 Luna 继承；A 的 Lane 级上限与总预算为 600000 ms。跨供应商兜底获得同一模型完整的窗口。
- `primary` 与 `fallbacks`：主模型加最多一个同 Lane 备用模型（当前七份配置都不配备用模型）；配置第三个模型会被拒绝。每个模型先在本供应商请求一次，失败且配置了 `cross_provider` 时再到另一供应商请求一次，之后才轮到下一个模型。
- 模型的 `context_profile` 与 `max_output_tokens`：Qwen、DeepSeek、GLM 均使用完整上下文。
- `omit_max_tokens`：仅用于明确要求省略 OpenAI `max_tokens` 的兼容端点。2026-09-16 起没有任何活动 Lane 使用它，字段保留给将来需要该请求形状的兼容端点；`openai-responses` 或 `google-generate-content` 协议下配置该字段会失败关闭。
- `thinking_level` 只允许配置在实际协议为 `google-generate-content` 的模型上，`effort`（`low`/`medium`/`high`/`xhigh`/`max`）只允许配置在 `anthropic-messages` 模型上，`anthropic-messages` 模型不接受 `temperature`；违反时失败关闭。
- Gemini 经 Go 时由 SDK 客户端走 `streamGenerateContent?alt=sse`：Go 只在 `https://opencode.ai/inference/go/v1` 提供 Gemini，因此 Lane 的 `/zen/go/v1` base 会映射过去，并带 `x-opencode-session` 与该 Lane 的出口策略。直接接 Google API 的 Lane（provider 不是 `opencode-go`）保留原来的单次 `generateContent` 请求。
- 模型的 `reporting_calibration`（布尔）：在系统提示末尾追加“报告校准”，要求把有代码证据的可疑问题以 medium/low 置信度报告，而不是自行否决或放进 limitations。当前 Muse 1.3 与 GPT-6 Luna 开启（跨供应商兜底沿用同一设置；GPT-6 Luna 沿用 Hy3 时的设置，2026-10-19 实测即带校准）：上周生产中 Muse/Kimi/Hy3 有 76–87% 的有效审查报告 0 个问题；实测校准后 Muse 在 #1237/#1133/#1241 由 2/2/— 增至 5/4/3 条，Hy3 由 0/0/1 变为 1/2/1 条（逐条核对：1 条成立的边界情况、2 条误报；#1241 “批量导入未查看文件按内置默认解析”一条在 2026-10-16 复核时确认引擎会补出相同的默认参数，实际无影响），二者在干净改动上均无高置信度误报、难题仍 5/5。Haiku 不开启：它不校准已在大 PR 上报告 1–6 条，开启后 #1237 增至 8 条但干净改动出现 3 条（含 1 条高置信度误报）；effort xhigh/max 即使输出上限 120000 也会在大 PR 上把输出全部用于思考而无报告。
- Gemini 已知行为：Gemini 偶尔完全不思考（usage 不含 `thoughtsTokenCount`，约 15–30 秒返回）。目前只在 ci-central #63（diff 大量涉及模型思考内容的处理代码）上观察到：同一请求 6 次中 3 次不思考、3 次思考 1.2–3.1 万 tokens，固定或新 session 结果相同；同仓库 #61/#62 的 4 次与 NebulaLab PR 的二十多次均正常思考。评论脚注此时显示 `Thinking: 0 tokens`，便于在生产中统计频率。
- Claude 经 Go 的 `/messages`（Anthropic 协议）调用，使用官方 `@anthropic-ai/sdk`，以 `x-api-key` 认证；Lane base 必须以 `/v1` 结尾。请求固定开启 adaptive thinking，深度只由 `effort` 控制。
- Lane 可选 `first_pass`（与其他模型同样校验，不能配置 `cross_provider`，id 不得与主备重复）：PR 还没有首审时，它排在主模型前面先审，用同一 Lane 的供应商和密钥；成功后 Lane 评论写入 `ai-pr-review-first-pass:v1` 标记块，之后的提交只走主模型，并把这段首审原样折叠在评论底部（评论超过 GitHub 长度上限时保留标记、正文改为提示查看编辑历史）。首审失败时同一轮由主模型审核且不写标记，下一个提交会再试首审。
- Lane 可选 `key_weights`（2–4 个 1–100 的整数）：当该 Lane 的槽位有多把 key 时，按 PR 号对权重之和取余，依次落在各把 key 的区间里（例如 `[2, 1]`：余 0、1 用第 1 把，余 2 用第 2 把），因此同一 PR 的首审、后续提交和手动 `/review` 都用同一把 key；超出列表的 key 权重记 1，未配置时平均分。某把 key 因账号原因失败（额度/余额耗尽、401/403 认证失败、429 限流）时，同一模型的同一请求换下一把没试过的 key 再发一次，之后才走 `cross_provider`；本供应商自身的故障（5xx、529 过载、超时、断流、空正文、证据契约失败）换 key 也救不回来，直接走 `cross_provider`。同一轮里余额耗尽或被拒的 key 不再作为后续模型的起点；全部 key 都已耗尽或被拒时，后续模型仍按单 key 时的规则从原定的 key 发一次（立即返回）再走 `cross_provider`。换 key 只用于本 Lane 自己的槽位：`cross_provider` 改发另一条 Lane 的槽位时只用那个槽位按 PR 号选中的 key，不再换 key。评论脚注写成 `Lane B: <模型> · key 2/2`，换过 key 时加横幅说明，状态表显示“key 未能服务，同模型换同一 Secret 槽位的下一把 key 运行中”；日志和评论不出现 key 的任何片段。这是“不在本供应商重发”的唯一例外（用户 2026-10-23 批准）：换的是另一个账号，不是重试同一路由。当前只有 NebulaLab 的 Lane B 配置 `[2, 1]`（第 1 个账号 $200/月，第 2 个 $100/月）。
- `provider: anthropic` 的请求只允许在 `RUNNER_ENVIRONMENT=self-hosted` 且 `NEBULA_REVIEW_PROXY_URL=http://192.168.122.1:17890` 时发出：szlab Mihomo 对 `anthropic.com` 只路由到用户的台湾专用节点，没有其他出口。GitHub-hosted、VPS 代理或直连一律拒绝并发布诊断。
- 模型的 `cross_provider`（`{ "credential_lane": "C", "id": "<目标供应商的模型 ID>" }`；2026-10-18 取代只在额度耗尽时触发的 `quota_overflow`，旧字段会被拒绝）：该模型在本 Lane 供应商上没有产生可用审核时（任何原因：额度耗尽、超时、5xx、限流、认证、网络、出口被拒、空正文、不完整输出或证据契约失败），把同一请求（同一 prompt、协议、输出上限、effort 和报告校准）改发 `credential_lane` 那条 Lane 的供应商和固定 Secret 槽位一次，模型 ID 换成 `id`，并获得该模型完整的时间窗口。只发这一个请求，不进入目标 Lane 自己的模型链，因此两条 Lane 可以互为目标。目标必须是另一条已配置、供应商不同的 Lane；Google 协议不支持；只允许这两个字段；首审模型不能配置。目标槽位未配置时不跨供应商，照常发布诊断。评论脚注写成 `Lane A: <模型> via <供应商> <目标模型 ID> (<本 Lane 供应商> unavailable)` 并加横幅说明，状态表显示“本供应商未产生可用审核，同模型经另一供应商运行中”。当前七个仓库：A 的 Muse 1.3 Contributor → Command Code `meta/muse-spark-1.3-contributor`（Responses，Lane C 槽位）；B 的 Haiku 5.5 → Command Code `claude-haiku-5-5`（Messages，Lane C 槽位）；C 的 GPT-6 Luna → Go `gpt-6-luna`（Responses，Lane A 槽位）。Command Code 上的 Muse 与 Haiku 已在 2026-10-15 从 szlab 用生产请求形状验证。以下是 C 仍用 Hy3 时的记录：Go 的 `hy3` 在 2026-10-18 从 szlab 确认可识别（当时 Go 周额度已用尽，返回 `GoUsageLimitError`）。已知限制：2026-10-14 观察到 Go 上的 Hy3 约 300 秒会被上游关流，大 PR 在 Go 上可能无法完成。2026-10-19 NebulaLab #1296 再次出现：Command Code 的 Hy3 返回 429 `RATE_LIMITED` 后改问 Go，Go 上的 Hy3 正常受理（HTTP 200），但思考速度约 120 字符/秒（同日 #1291 约 370 字符/秒、207 秒完成），到约 302 秒仍在思考、没有正文即被干净关流；客户端窗口为 900 秒，不是本地截止。

`review-action` 在发送模型请求前校验配置。文件名、`repository` 字段和 `github.repository` 必须一致；未知仓库会失败关闭，不会落回某个默认模型。

reusable workflow 先解析并校验 40 位中央 ref：外部 caller 必须把 `uses` 中的同一个完整 SHA 重复传入唯一的非策略输入 `central_workflow_sha`；如果 GitHub 提供 `github.job_workflow_sha` 或 `github.job_workflow_ref`，则严格校验 workflow 路径、40 位 SHA 及二者一致性。当前 GitHub 外部 reusable job 实测不会暴露这两个字段，此时会发出 warning，并以受审 caller 的显式 SHA 检出 `review-action`/仓库 JSON、写入 v2 evidence。此 fallback 无法在 called workflow 内独立证明 `uses` 也使用相同 SHA，因此 caller 文件的 code review 是信任边界；三个业务仓必须同时修改 `uses` 与 `with.central_workflow_sha`，禁止使用分支或 tag。仅当 `github.repository` 严格等于 `TshyGO/ci-central` 且同仓相对 caller 无法提供上述 SHA 时，才使用本次事件的 `github.sha`。

## 精度、去重与节流保证

- reusable job 按仓库和 PR 号启用 `cancel-in-progress: true`：自动 PR 事件与手动 `/review` 共享同一并发组，新触发取消旧运行，不会并发更新同一组评论。
- 上下文收集前、模型调用前、发布评论前分别核对 PR head SHA。
- 每条 Lane 评论都包含 v2 机器证据：Lane、完整 40 位 head SHA、解析后的中央 workflow SHA 和 `valid`、`diagnostic` 或 `partial` 状态。
- 每条 Lane 评论在标题下方醒目标出审核 commit、更新时间和运行链接；新提交仍原地更新同一条稳定评论，不会因时间线位置不变而隐藏审核新鲜度。
- 自动触发复用“同一 head、同一 reusable workflow 版本、状态为 `valid`”的 Lane；PR 自身 diff 与该 Lane 上次有效审核相同、评论仍显示那次审核时也不调用模型（见“增量复审、重复审核跳过与额度诊断”）。缺失、诊断和不完整的 Lane，以及没有可信审核记录的旧版评论，会单独重跑；有可信记录且改动不大时只做增量复审。
- 显式 `/review` 一律对每条 Lane 做当前版本的完整审核：不受同 HEAD 去重和“diff 未变”跳过的限制，也不做增量复审。
- Lane 主模型在本供应商成功时绝不调用跨供应商兜底。
- 所有模型请求失败（包括超时、限流、认证、HTML 验证页、DNS/TLS、解析失败、空正文和不完整输出）都只把同一模型改发另一供应商一次（`cross_provider`）；槽位有多把 key 时，账号原因的失败先换另一把 key 发一次（见 `key_weights`）；仍失败且没有配置其他模型时，发布诊断或明确标记的不完整结果，不计为有效审核。未配置该 Lane 凭据时仍直接发布配置诊断，不发送请求。
- 不做退避重试，不做可选参数修复后重发，不跟随 HTTP 重定向。A/B/C 并行，每路一旦完整成功或主备均结束就立即校验 PR head/state 并发布稳定评论；不等待其他 Lane。最终 job 仍等待各路结束后执行原有 quorum/required 门禁，不因提早发布而提早放行。
- 当前每条 Lane 在本供应商与另一供应商各请求一次、逐路即时发布：A 的 Muse 每次 10 分钟，B 的 Haiku 与 C 的 GPT-6 Luna 每次各 15 分钟（`model_budget_ms` 是单次请求的上限，不是 Lane 的累计时长）；三路统一由 SDK 客户端流式接入。SDK 及连接层超时与模型预算匹配，但 DNS/TLS、网络或供应商错误仍可能提前失败。
- B 通过固定 Lane B 槽位调用 `claude-haiku-5-5`（Messages、effort high、输出上限 120000、diff 预算 120 万字符），失败一次立即经 Lane C 槽位改问 Command Code 上的 `claude-haiku-5-5`；C 通过固定 Lane C 槽位（Command Code）调用 `gpt-6-luna`（Responses、报告校准、输出上限 65536、diff 预算 26 万字符），失败一次立即经 Lane A 槽位改问 Go 上的 `gpt-6-luna`。GPT-6 Luna 的上下文为 1M tokens，暂沿用仓库默认、也是 2026-10-19 实测所用的 26 万字符 diff 预算，超出部分按完整 hunk 省略并在 coverage 中注明；Gemini 专用的“两轮深审”合约只随 `google-generate-content` 协议发送，GPT-6 Luna 不带。
- B/C 的选型（2026-10-14）：Go Plus 按模型分别计月额度（Haiku $60、Gemini 4 Argon $240 限时双倍），订阅固定，目标是把好模型的额度用满。旧组合在 NebulaLab 上 2 天内 Kimi 有 17 次 900 秒截止、Hy3 有 17 次在约 300 秒被上游关流（成功最长 299 秒），B 是 81 次运行里 66 次的最慢 Lane。新模型在 NebulaLab #1241/#1237/#1133（7–23 万输入 tokens）实测：Haiku 5.5 effort high 146–211 秒全部有效、发现 3/5/2 条；effort max 在三个大 PR 上把 65536 个输出 token 全部用于思考、无报告，因此固定 high。Gemini 4 Argon thinking high 87–215 秒全部有效、难题 4/5–5/5，但真实 PR 上报告的问题数为 0：思考摘要显示它追踪到了真实问题却判为不可操作。Gemini 系统提示在深审合约后追加“报告校准”（可疑但有代码证据的问题以 medium/low 置信度报告，不丢进 limitations）后，#1237/#1241 分别报告 4/1 条（思考约 3.4 万 tokens、269–346 秒、每次约 $0.75–0.93），干净改动仍 0 误报、难题 5/5。Gemini 单次约 $0.34–1.03，成本过高，2026-10-15 撤下。
- C 的选型（2026-10-15）：以质量为先、成本为门槛重测便宜与免费候选（同一组 #1237/#1241/#1133、合成难题与干净改动）。DeepSeek V4.1 Flash 在 6 次大 PR 中全部输出非 JSON；Qwen3.8 Flash 与 Step 5 Preview Free 大 PR 需 8–14 分钟；MiniMax M3 格式不稳且引用常不可校验（且只有显式发送 `thinking` 时才思考）；Omen Alpha 难题 1/5 且未在 Go 文档登记；Cat Jam Free 很快但真实 PR 几乎不报告、且不对中国地区开放；LongCat 2.5 Preview Free 13–15 分钟且频繁 429。校准后的 Hy3 115–156 秒完成全部大 PR、格式稳定，每次约 $0.02，因此作为 C 主模型，GLM 5.3 兜底。
- C 的备用（2026-10-16）：GLM 5.3 兜底在 Command Code 上 3 个大 PR 全部未完成，生产中 16 次仅 3 次正常结束，单价约 $1.40/$4.40 每百万 tokens。改为 GLM 5.3 Flash（约 $0.15/$0.50，GOAT 单独 $60 额度）：同一组 #1237/#1241/#1133 与合成难题、干净改动上，从 szlab 经 Command Code 实测 6–8 分钟完成全部大 PR（65–69 tok/s，每次先思考约 3 万 tokens）、合约有效，难题 4/5、干净改动 1 条低置信度；但它常把代码证据缩写成 `...` 或夹带注释，大 PR 上 7 条发现只有 1 条通过证据校验（其余列入“审查范围与限制”待人工核实，其中包括 #1237 已核实为真的 OSError→`INSUFFICIENT_STORAGE`）。同期 Hy3 为 97/42/272/176/181 秒、6 条发现全部通过校验，因此 Hy3 继续做主模型，GLM 5.3 Flash 只做备用。GLM 5.3 FlashX 更快（250–318 秒），但干净改动出现 2 条高置信度误报，未采用；Flash 加报告校准没有带来更多可校验的发现，且有 1 次在 476 秒无输出断流，因此不开启。
- C 的供应商（2026-10-15）：OpenCode Go 的额度是整个 workspace 共用一个池（5 小时/每周/每月），而不是按模型分别计；本周达到周上限后 A/B/C 全部返回 `GoUsageLimitError`。因此 C 整条迁到 Command Code GOAT 套餐（$10/月，含 Hy3、GLM 5.3、Kimi K2.7 Code、Muse Spark 1.3/1.2 Contributor、Claude Haiku 5.5 等模型额度；用量上限每 5 小时 $14、每 7 天 $35、每月 $70），模型与参数不变；Go 用尽时 C 仍能发布评审。早先记录的“Claude 与 Muse 在该套餐上返回 403”是在本地 PC 网络下测得，2026-10-15 从 szlab 重测四者均为 200，那条记录有误。随后 A/B 加入额度溢出：Go 返回额度耗尽时，同一模型经 Lane C 槽位改走 Command Code，Go 额度仍优先用满，两份订阅都用上，又不会因 Go 用尽而整周无审核。Go 用尽期间三路都消耗 GOAT 额度，7 天 $35 的上限可能先到；不够时升级 Command Code 套餐。
- 跨供应商兜底（2026-10-18）：Go 周额度用尽的同时 Command Code 的周额度也将用尽，同家兜底（Muse 1.2、Kimi、GLM 5.3 Flash）和只在额度耗尽时触发的溢出都救不回来。用户取消了“禁止跨供应商兜底”，并要求每条 Lane 只留一个兜底、不换模型：主模型失败就去另一家调同一模型。因此删去 Muse 1.2、Kimi、GLM 5.3 Flash 与 Lane C 的未受理重发，`quota_overflow` 改为任何失败都触发的 `cross_provider`；C 改问 Go 上的 Hy3，Lane C 的 `model_budget_ms` 回到 900000。
- C 改用 GPT-6 Luna（2026-10-19）：Command Code 的 GOAT 周额度于 10-19 用尽（返回 429 `RATE_LIMITED`，只有 message 写明 weekly usage limit 与重置时间），C 改问 Go 上的 Hy3 时仍常被上游关流（#1133 在 71 秒、#1296 在约 300 秒）。同日在 Go 上以本仓库 `dfe4da17` 的完整评审代码与提示词（含报告校准）重测同一组 #1237/#1241/#1133：GPT-6 Luna（只支持 Responses）3/3 有效、68–107 秒，三个 PR 合计发布 1 条发现，约 $0.10/$0.50 每百万 tokens；Hy3 2/3 有效（300、398 秒），发布 3/5 条且引用全部通过校验；Step 5 Preview 3/3 有效、137–263 秒，但 10 条发现中 8 条引用未通过校验，约 $1/$2.70；MiMo V2.6 Flash 1/3 有效，小 PR 也需约 437 秒；MiniMax M3.1 Flash Free 1/3 有效、630–900 秒，一次把 65536 个输出 token 用尽。用户决定 C 的定位是快速、稳定的第三路，深度发现由 A 的 Muse 与 B 的 Claude 承担，因此 C 改为 GPT-6 Luna，本家失败时经 Lane A 槽位改问 Go 上的同一模型。Command Code 上的 GPT-6 Luna 因当周额度用尽尚未实测；GPT-6 Luna 经 szlab 已批准代理出口能否受理，以合并后首个 exact-head Lane C 评论与日志验收。
- C 的选型（2026-10-06）：在同一套真实业务 PR（NebulaLab #1106、resume #235）与带隐藏缺陷的合成审核上实测 15 个 Go 模型。MiMo V2.6 Pro 在业务 PR 上需 24–28 分钟（22–42 tok/s），已不适合作为必跑 Lane；Hy3 在难度最高的合成题上与 MiMo V2.6 Pro、GLM 5.3 同样命中 5/5 隐藏缺陷且不误报干扰项，真实 PR 约 3–4 分钟、每次约 $0.015。Kimi K2.7 Code 同样快且能发现实质问题，但引用位置常需校验扣下，作 C 的同 Lane 备用。
- B 的选型（2026-10-06）：GLM 5.3 审核最严谨，但在业务 PR 上每次 6–15 分钟、约 $0.20–0.26；按每月约 850 次审核会单独吃掉约 $170，接近 Go Plus 月额度（约 $180 模型用量），而额度耗尽会同时阻断共用同一账户的 A/B/C。B 因此改为 Kimi K2.7 Code（真实 PR 4–6 分钟、约 $0.10–0.14，曾命中其他模型才发现的关键问题），GLM 5.3 只在 Kimi 失败时兜底；预计每月约 $130–135。Muse Spark 1.3 在同一套实测中难题 5/5、零误报、真实 PR 1–1.5 分钟，继续作为 A。
- 每个模型在每个供应商上最多一次产生输出的请求，单次窗口是截止上限（A 的 Muse 10 分钟，B 的 Haiku 与 C 的 GPT-6 Luna 15 分钟），提前失败立即改问另一供应商，无重试、退避或参数修复重发。唯一例外是“未受理重发”（当前没有 Lane 开启）：开启 `resend_unserved` 的 Lane，若请求在产生任何正文、推理或结束原因之前就被上游以 429/5xx 拒绝，或 200 后排队到关流都没有一个数据事件，则换一个 `x-opencode-session`（后缀 `-resend`，避免粘住同一上游）重发同一请求一次：429/5xx 按 `retry-after`（上限 120 秒）或 30 秒后重发，排队关流立即重发；重发只用该请求剩余的窗口（不足 60 秒则不重发），再失败才改问另一供应商。计划额度（`*UsageLimitError`、`insufficient_quota`）、认证、端点不可达、本地截止和已产生输出的失败一律不在原供应商重发。这类请求没有生成内容，重发不会产生重复审核或重复推理费用。主模型在本供应商成功绝不跨供应商；实际经另一供应商生成时评论明确标记。模型是否可用以 exact-head Lane 评论和日志验收，不能用短探针或 wrapper 绿色检查代替。
- Lane A 只用用户指定的 Muse Spark 1.3 Contributor：Go 上失败时改问 Command Code 上的同一模型，不再用 Muse Spark 1.2 Contributor 兜底（2026-10-18 起）。完整上下文、65536 输出上限，Responses 不添加额外思考或采样参数。
- reusable job 兜底 70 分钟，覆盖 B、C 最多 30 分钟（本供应商与另一供应商各 15 分钟，三路并行）及准备/发布。NebulaLab 的 Lane B 在 PR 首个提交上先跑 Sonnet 首审，首审失败后才由 Haiku 本家、对家各跑一次，最坏 45 分钟，仍在 70 分钟内。正常 `stop` 即结束，不强迫模型消耗全部预算；30 分钟是保护上限，不保证每次都能生成。
- 每个健康 Lane 只发布一条稳定标记评论；隐藏 reasoning 永不进入 PR 评论。
- 未配置、失败或输出不完整的 Lane 会保留诊断/部分结果；有效 Lane 数不足 quorum（或未配置 quorum 时缺少必需 Lane）才在发布其他健康 Lane 后明确失败。

### 增量复审、重复审核跳过与额度诊断（2026-10-19）

订阅额度固定（OpenCode Go 与 Command Code GOAT 各 $35/7 天），不加钱，唯一的办法是少花 token。10-19 统计 NebulaLab 近 7 天：真正调用到模型的运行（pr-agent.yml 超过 90 秒）有 263 次，分布在 84 个 PR 上，平均每个 PR 3.1 轮。其中 179 次（68%）是复审已审过的 PR，每轮都重发整个 PR，而本仓库自己的测量是首审时已能看到最终 diff 的 97%。最多的两个 PR 审了 22 轮和 14 轮；11 次复审的是已经审过的 head。复审还会重提已有结论的问题：#1296 Lane A 重提了作者已用证据驳回的 TLS P1，#1297 Lane B 重提了两条已修复的问题。Command Code 的周额度在 10-19 用尽，供应商返回 429 `{"code":"RATE_LIMITED","type":"rate_limit_error"}`，只有 message 写着 “You've reached your weekly usage limit ... resets at <时间>”，所以评论看起来像限流。为此做了三处改动。

**审核记录。** 每条 Lane 评论的第 3 行是运行器写的一行隐藏记录 `<!-- ai-pr-review-state:v1 {...} -->`（第 1、2 行仍是原来的 Lane 标记和 v2 evidence，两者格式不变）。记录内容：
- 上次有效审核的 head、workflow、目标分支、报告契约版本、实际服务的模型、审核方式（full/incremental），以及那一轮读取评论的时间；
- PR 自身 diff 的指纹：按 git patch-id 的方式，去掉 hunk 头（行号和函数名），增、删、上下文行原样保留，空白也保留；没有补丁的文件用 blob；
- 每个文件的指纹（最多 600 个文件），用来在合并 main 之后找出 PR 自身改动有变化的文件；
- 仍需复核的发现。发现带编号（A1、B2…），评论里的标题也显示编号，作者回复时可以直接引用。

只读取评论第 3 行，而且评论必须是 `github-actions[bot]` 写的。记录里 `<`、`>` 和行分隔符一律转义，模型写的文字关不掉这条 HTML 注释。读取时逐个字段校验格式和长度，任何一项不合格就当作没有记录，走完整审核。某一轮失败或输出不完整时，原样保留上一次有效审核的记录。记录超过 24 000 字符时依次舍弃：较长的文字、较早的已答复发现、每文件指纹、全部已答复发现、最低优先级的未决发现。记录最多保留 60 条未决发现。只要舍弃过未决发现，记录就标为不完整（`lossy`）：之后 PR 自身 diff 有变化时，这条 Lane 做完整审核，因为增量复审只复核记录里有的发现；diff 没变时仍可跳过，因为跳过只是原样沿用那条评论，不比上一轮少什么。

**不重复审核（改动 2）。** 同一 head、同一 workflow 的有效证据照旧直接复用。新增的规则：某条 Lane 的 PR 自身 diff 指纹与它上次有效审核相同、评论仍显示那次有效审核、并且不是手动 `/review` 时，不调用模型，直接复用那条评论，并计入 quorum。

- **覆盖的情况**：只合入 main、变基或同树重推、新提交没有改到 PR 自身代码。判断依据是补丁内容，不是 head SHA。
- **旧中央版本**：上次审核来自旧的中央版本也可以复用，前提是评论带着可信记录（格式 v1、报告契约版本相同、那次审核的模型仍在该 Lane 当前的配置里）。没有这条记录的旧评论照旧完整审核。
- **状态表**：写明复用的是哪个提交、哪个中央版本、原因是什么。例如“复用此前提交的有效证据，未请求模型（提交 xxxxxxx 的审核，中央版本 yyyyyyy（当前 zzzzzzz）；PR 自身改动未变，期间合并了其他分支，如 main）”。原因也可能是“提交历史被改写（变基或重推）”或“新提交没有改变 PR 自身的改动”。
- **不跳过的例外**：main 改到了 PR 改动旁边的上下文行时，指纹也会变，这时照常审核，因为相邻的改动可能改变 PR 代码的含义。
- **只看补丁**：跳过只比较 PR 自身的补丁。PR 描述、关联 Issue 或仓库提示词变了，不会单独触发重审；需要时评论 `/review`。

**增量复审（改动 1）。** 有可信记录且 PR 自身 diff 有变化时，只审自上次有效审核以来改动过的文件，并带上那一轮的结论。可信记录指：格式为 v1，报告契约版本相同，审核的模型仍在该 Lane 的模型链里（包括首审模型），目标分支没变。发给模型的材料：
- **自上次审核以来 PR 自身改动过的文件，每个都给完整的 PR 补丁**，和完整审核看到的一样，包括 PR 在更早的提交里删掉的 base 行。找出这些文件的办法：
  - 新提交是从上次 head 直接快进过来的（合并基点正是上次 head，其中没有合并提交，也没有被截断）时，用 `compare <上次 head>...<当前 head>`。文件标题里写明此后改了哪些行，用当前文本的行号，例如 “since the reviewed commit: added or rewritten lines 40-52; lines removed after line 60”。compare 只用来找文件、标行，不作为审核材料；证据的行号一律按 base 和当前 head。
  - 不满足时（期间合并过 main、变基过，或 compare 失败），compare 可能混进 main 的改动。这时改为按每文件指纹找出 PR 自身改动有变化的文件，不标行；只被 main 改过的文件不会发送。
  - 同一 head 的每文件指纹在各条 Lane 的记录里都一样，某条 Lane 的记录因篇幅舍掉了指纹时，借用其他 Lane 的。
- **每个改动文件的完整当前文本，一个不少。** 材料里逐个文件写明给了什么：完整 PR 补丁加完整文本；已删除的文件只有删除的行；二进制文件没有文本。也写明此后没有改动的文件本轮不提供：完整审核会再发一遍它们的 PR 补丁，增量复审不发。这是增量复审比完整审核少看的唯一部分；这些文件上一轮已经审过，那一轮的发现由记录带入本轮复核。
- **上一轮的发现（JSON），以及此后的回复。**
  - 回复只收 PR 作者和 OWNER/MEMBER/COLLABORATOR 发表的，包括普通评论、review 摘要和行内评论；bot（包括本工作流）的评论和其他人的评论一律排除。
  - “此后”从上一轮读取评论之前一分钟算起。同一秒或 runner 时钟偏差下发的回复宁可重复给，也不漏掉。
  - 每条回复最多 6 000 字符，合计最多 24 000 字符，超出时保留最新的回复。
- **PR 描述和关联 Issue**，与完整审核相同。

提示词对模型的要求：
- 逐条对照当前代码和回复复核上一轮的发现，在 `previous_findings` 里标出 fixed、still_present、answered 或 unclear；
- 回复给出了在当前代码上成立的证据才算 answered，只有说法、没有证据不算；
- 只能根据给出的材料判断：上一轮发现所指的代码不在材料里，或者材料不足以判断时，标 unclear 并说明缺什么，不能标 fixed；
- 改动可能影响未提供的文件（调用方、实现、测试、配置）时，在 limitations 里点名这些文件和风险，不能假定它们仍然适配；
- 作者已用证据答复的问题不再作为新发现提出，除非新代码推翻了那个答复（这时标 still_present 并说明原因）；
- 深入审查新改动。

复核结论的处理：只认已知编号；模型没给结论的未决发现继续保留，并在限制里注明；标 fixed 或 answered 却不给理由的，按 unclear 处理，发现继续保留。这些结论是模型的复核意见，不是已证实的事实，评论里照此措辞：“模型复核认为已修复”“模型复核认为仍存在”“模型复核认为作者的答复有证据支持，不再提出”“模型复核无法确认，继续保留”。仍存在和待复核的发现完整展示，并标出最初报告时的提交。新发现必须通过同样的证据校验。

完整审核（包括手动 `/review` 和各种回退）不复核上一轮的发现，评论里也不列出它们。但只要上一条记录可信，作者已答复的发现会原样带进新记录，下一次增量复审仍知道它们，不会因为中间做过一次完整审核就把作者驳回过的问题当成新问题。

**质量优先（Peter，2026-10-19）。** 对每个改动文件，增量复审看到的不比完整审核少：完整审核给的 PR 补丁照给，另加完整文本，从不截成片段；放不下就做完整审核。此后没有改动的文件不再发送（见上文）。第一版只给自上次审核以来的补丁加完整文本，看不到 PR 在更早提交里删掉的 base 行；推送前的独立审查指出后，改为给完整 PR 补丁。Peter 的理由是：现在用的模型都很便宜，额度的大头在 A 路，每月约 $100，够用，不值得为了省这一点降低质量。代价是省得少：按这个规则（改动文件给完整 PR 补丁和完整文本，不截断），回放估算输入 token 省 17.5%；2026-10-20 已确认这个结果可以接受，质量优先。回放里复审轮次的中位数：自上轮以来的补丁只有 1.2 万字符，改动文件的完整文本却有 12.9 万字符，比整个 PR 的 diff（11.4 万）还大（例如 `data_center_client.py` 就有 175 KB），所以很多复审会退回完整审核。

**回退到完整审核。** 以下情况走原来的完整审核：
- 手动 `/review`：一律对每条 Lane 做当前版本的完整审核，不复用、不跳过、不增量；
- 没有可信记录，包括本次改动之前的版本写的评论；
- 自上轮以来的补丁超过 PR 全部补丁的 50%（`large-change`）。阈值依据：复审轮次中这个比例的 90 分位是 51%；
- 有改动文件读不到完整文本（`text-unavailable`，例如文件超过 200 KB）；
- 补丁加完整文本超出该 Lane 任一模型的 diff 预算（`over-budget`，常见于预算 26 万字符的 Lane C）；
- 补丁加完整文本比完整审核的材料还多（`not-smaller`）；
- 合并 main 之后没有每文件指纹可用；
- 上一轮的记录没能装下全部未决发现（`record-incomplete`）；
- 目标分支变了；
- 首审还没完成：NebulaLab Lane B 的 Sonnet 首审仍是完整审核，首审完成后，Haiku 对之后的提交做增量复审。

**信任边界。** 作者回复只是给模型的材料：以 JSON 形式传入，提示词写明它们是待核实的说法，不是指令。回复内容不参与工作流的任何决策。

**额度诊断（改动 3）。** SDK 客户端在本地读供应商的报错，只输出三样东西：是否额度用尽（布尔值）、窗口（5 小时、周、月、日）、校验过的 UTC 重置时间。不输出 message、账号、请求内容或密钥。能识别的情况：
- Command Code 的 “weekly/5-hour usage limit ... resets at <ISO>”；
- Go 的 `*UsageLimitError`，重置时间取自 `retry-after`，窗口取自 `metadata.limitName`（也认 `5h`、`7d`、`rolling_5h` 这样的简写）。OpenAI SDK 的报错不带这个字段，所以 SDK 客户端会读一份有上限的报错正文副本，只取出这一个字段；
- `insufficient_quota`，以及 “exceeded your current quota”。

“usage limit”“quota exceeded” 这类泛用说法，只有同时出现套餐、计费、重置或窗口字样时才算额度用尽。报错里出现按分钟、按秒的字样（per minute、RPM、TPM 等）时算限流，除非供应商写明了这个上限的套餐窗口：Go 的 `limitName`，或紧挨在 “usage limit” 前面的 weekly、5-hour 这类词。`*UsageLimitError`、`insufficient_quota` 这类错误码本身就表示套餐额度。“resets in 5 hours” 这类话只说明多久后重置，不当作窗口。运行器读原文时不单凭 “usage limit” 判断额度，以 SDK 客户端的结论为准。读报错正文时连接中断，照样按 HTTP 状态码报告。

普通限流仍按 429 处理。额度用尽时：
- 评论第二行写“⛔ 额度用尽，不是限流：`command-code` 的周用量上限已用完，2026-10-22T08:56:41Z（北京时间 2026-10-22 16:56）重置”；
- Tried 列表写 `HTTP 429, command-code weekly usage limit exhausted, resets ...`；
- Action needed 写明这是套餐额度，不是限流；
- 两家都用尽时，按尝试顺序逐一列出每家的重置时间；同一家的额度挡住同一 Lane 的几个模型时只列一次；
- 状态表写“供应商额度用尽，审核未生成（command-code 周上限已用完，北京时间 … 重置）”；
- 同一模型经另一供应商审核成功时，横幅会写出本家没能审核的原因。

**回放估算（NebulaLab，2026-10-12 14:00Z 起 7 天）。** 用 GitHub 历史只读回放了 257 次运行（其中 254 次调用到模型）、78 个 PR、750 个 Lane 运行。实际 token 取自运行日志；审核材料取自当时的 PR diff、提交之间的 compare 和文件大小；决策直接调用本仓库的 `diffIdentity`、`packIncremental` 和 `chooseIncremental`。按上面的规则：
- **增量复审**：94 个 Lane 运行（12.5%），每个都带改动文件完整的 PR 补丁和完整文本。其余复审退回完整审核，原因主要是：材料比完整审核还大（224 次）、改动过半（46 次）、超出模型预算（37 次，其中 Lane C 32 次）、手动 `/review`（33 次）、读不到完整文本（16 次）；
- **跳过**：6 个 Lane 运行，其中 2 次运行完全不调用模型（占 0.8%）。同一 head 的重跑大多是手动 `/review`，按规定不跳过；18 次合入 main 里，只有 2 次没有改到 PR 自身代码；
- **输入 token**：省 17.5%（增量 17.3%，跳过 0.3%）；
- **输出 token**：主要是推理，按回放拟合，每次审核约 1–2 万 token，与输入大小几乎无关，估计只省约 2.5%；即使输出与输入成比例，上限也只有 6.4%；
- **按金额**：这一周共 4 557 万输入 token、1 399 万输出 token；假设输出单价是输入的 5 倍，约省 8%，上限约 11%；
- **审了最多轮的 PR 省得最多**：#1259（16 轮）输入省 40.4%，#1258（10 轮）省 32.5%；
- **对比方案**：
  - 第一版只给自上次审核以来的补丁加完整文本：161 个 Lane 运行做增量，输入省 20.9%。它看不到 PR 在更早提交里删掉的 base 行，所以改成了现在的做法；
  - 改动文件只按预算给片段（总量不超过完整审核的 50%）：395 个 Lane 运行做增量，输入省 42.5%。按 Peter 的决定，为了不降低审核质量，没有采用。

### Draft 冻结门禁

PR 在集中修复阶段保持 Draft。每次推送后，等待 Lane A/B/C、常规 CI 和 review threads 全部稳定在同一个最终 head SHA。同时满足以下条件后才标记 Ready：工作区 clean；成功刷新远端后，本地/远端为 0/0；三条 Lane 都有 `valid` 证据，证据由当前 workflow 生成，或者按下段规则复用；CI 全绿；unresolved threads 为 0，且没有待修改事项。

`ready_for_review` 事件保留，复用和重跑的规则如下：
- 如果该 head 已在 `synchronize` 中完成有效审核，中央工作流直接复用三条 Lane 的证据，不调用模型。
- PR 自身 diff 与某条 Lane 上次有效审核相同时，也复用那次审核，即使它来自旧的中央版本；状态表写明复用的提交、中央版本和原因。这种复用不满足“三条 Lane 都是当前 workflow 生成的证据”。可以接受的理由：AI 审核是建议性的；合并仍由 Peter 用管理员权限把关；否则每次升级 pin，所有开放 PR 都要整轮重审。需要当前版本的结论时，评论 `/review`：手动触发一律对每条 Lane 做当前版本的完整审核。
- 此前审核失败、部分完成、没有生成评论，或评论来自没有可信审核记录的旧 workflow 时，只重跑对应 Lane。Ready 后不再修改代码；如果意外发现问题，先转回 Draft，再集中修复。最终合并应冻结完整 head SHA，并使用 `gh pr merge --admin --match-head-commit <SHA>` 防止检查结束到合并之间 HEAD 被替换。

## 运维命令

```powershell
# 只探测，不写 Secret；Key 通过安全提示输入
pwsh ./scripts/probe-provider.ps1 -Lane B -Repository TshyGO/NebulaLab -ApiBase https://example.invalid/v1

# 向三个业务仓库写固定 Lane 槽位；支持 -WhatIf
pwsh ./scripts/set-lane-secret.ps1 -Lane B -ApiBase https://example.invalid/v1

# 离线验证
npm ci --ignore-scripts
npm run build
node ./test/review-config.test.mjs
node ./test/pr-review.test.mjs
node --test ./test/review-incremental.test.mjs ./test/review-contract.test.mjs
node --test ./test/sdk-client.test.mjs
git diff --check
```

`probe-provider.ps1` 会依据中央配置选择协议，对 OpenAI 兼容端点先读取 `/models` 再发极小 Chat Completions 请求；配置 `omit_max_tokens` 时按端点要求省略该字段。Responses 使用 `/responses` 并校验 completed 正文。这个本地运维探针使用 PowerShell 网络环境，不代表自托管 runner 的专用代理路径；生产验收必须用固定 SDK 在原 runner 上执行。Google Lane 发送 `generateContent` 请求并带上配置的 thinking level。Google probe 预留 512 completion tokens，避免高思考模式把过小预算全部耗在私有 reasoning 而没有最终 `OK`。脚本不输出 Key。

Gemini thinking 字段以 Google 官方 [`generateContent` API reference](https://ai.google.dev/api/generate-content#ThinkingConfig) 和 [Gemini thinking guide](https://ai.google.dev/gemini-api/docs/thinking) 为准；不要同时配置 legacy `thinkingBudget` 与 `thinkingLevel`。

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
    uses: TshyGO/ci-central/.github/workflows/pr-review.yml@<FULL_40_CHAR_CI_CENTRAL_SHA>
    permissions:
      contents: read
      issues: write
      pull-requests: write
    with:
      central_workflow_sha: <FULL_40_CHAR_CI_CENTRAL_SHA>
    secrets:
      PR_AGENT_LANE_A_KEY: ${{ secrets.PR_AGENT_LANE_A_KEY }}
      PR_AGENT_LANE_A_API_BASE: ${{ secrets.PR_AGENT_LANE_A_API_BASE }}
      PR_AGENT_LANE_B_KEY: ${{ secrets.PR_AGENT_LANE_B_KEY }}
      PR_AGENT_LANE_B_API_BASE: ${{ secrets.PR_AGENT_LANE_B_API_BASE }}
      PR_AGENT_LANE_C_KEY: ${{ secrets.PR_AGENT_LANE_C_KEY }}
      PR_AGENT_LANE_C_API_BASE: ${{ secrets.PR_AGENT_LANE_C_API_BASE }}
```


## 审核契约、上下文与当前提交状态

YAML 只负责固定权限、runner 档位、中央 SHA 校验和受信任启动入口。完整审核编排由 `review-action/src/review-runner.js` 构建为 `dist/review-runner.js`，生产不安装依赖，也不检出或执行业务 PR 代码。SDK 保持独立 `dist/sdk-client.js`：流终止诊断及 usage 改动可以独立合入，审核模块不复制它的实现。配置 resolver 与 runner 复用同一份校验器，避免规则漂移。

- `review-context.js`：按风险与完整 hunk 打包 patch，源码优先于生成产物，超预算或源端已截断的 hunk 整体省略；大幅删除的 workflow 可用固定 HEAD 的完整文本替代，并明确声明不提供 base/删除侧，避免旧内联代码挤掉新实现；manifest 记录每文件实际提供/总 hunk 数与不可用 patch。Issue 使用独立预算，默认总计 20000 字符、每条最多 6000 字符，仓库可用 `review_policy.issue_char_budget` / `issue_excerpt_chars` 调高（PR 描述同理用 `description_char_limit`，默认 4000）；超限保留头尾并明确标记摘录。patch 预算默认取 `review_policy.diff_char_budget`，单个模型可用 `diff_char_budget` 按其上下文窗口单独调高，每个预算单独打包，coverage 与校验都按该模型实际收到的材料计算。不可读取的 Issue 明确记录为材料缺口，不推断它的内容。
- `review-report.js`：共享 `review-contract-v1`，叠加已有仓库边界与 A/B/C 的附加关注点。每路仍共同检查正确性、安全与回归。PR 描述、Issue、代码注释都是待核实材料；本次请求没有浏览或执行工具，模型不能声称运行了测试或读了未提供的文件。旧的 Markdown 输出指令在组装时由统一 JSON 契约替代。
- 模型最终输出单个 JSON 对象：`summary`、`reviewed_files`、`findings`、`limitations`。每个实质发现必须给出 P0/P1/P2、文件、old/new 侧行号、触发、影响、同一已提供 hunk 的代码引用、修复方向及模型自报置信度。medium/low 明确标为待核实风险，不冒充确定缺陷；缺证据的猜测和人工验收缺口列为 limitations。覆盖声明只按实际已提供的文件统计，额外声明明确排除，合法代码证据可补足文件列表的小遗漏。无缺陷时 findings 为空；不为凑数量而报问题。
- 完整终止只证明生成完成；文件、同侧 hunk 与代码引用的实际位置通过契约校验后才计为 `valid`。唯一代码引用可修正同 hunk 内的模型误报行号，并记录原行号。单条发现的文件、行号或代码引用无法校验（含歧义位置）时，只扣下这一条：它不作为发现发布，只把优先级、标题和失败原因列入限制并标为待人工核实，其余已校验内容仍计为 `valid`；整份报告只在不是 JSON 对象或结构非法时拒绝。JSON 外包裹的说明文字或代码围栏会被忽略，只使用其中的对象。自由叙述按纯文本转义，代码引用保留原格式，不产生模型生成的图片或通知提及。这个校验不证明结论正确，不代替人工批准。格式或证据契约失败只改问一次另一供应商上的同一模型，不修参数重发；不完整响应继续保持 `partial`，不计入 quorum。所有变更都没有文本 patch（二进制、纯重命名或补丁不可用）时不发送模型请求、不发布 Lane 评论、不判失败，只在当前提交状态表中标明“无可审查的文本补丁”并输出 notice；这既不是审核失败，也不代表已审核。存在文本 patch 但一个完整 hunk 都放不进预算时，仍按缺少审核证据失败。
- `review-status.js`：一条独立、按当前完整 head/workflow/run 标记的状态汇总，显示主模型、备用运行、实际服务模型、有效发布数与发布失败。历史 Lane 评论在新结果到达前仍保留，汇总说明它们不代表新提交。每次异步写入前重新核对 PR head/state，写入串行；汇总写入失败不重试模型、不影响独立 Lane 门禁。被取消的运行可能留下最后观测状态，运行链接是最终状态依据。

模型、供应商、六个 Secret 槽位、主备各一次、B/C 的 30 分钟上限与任意两路 quorum 都保持原有配置。稳定 Lane 身份标记只在评论首行识别，代码引用里的相同字符串不会伪造另一条 Lane。

### 验证与发布巡检

`npm test` 同时覆盖受信任 workflow 桥接、源码和生产 runner 产物、SDK TLS/SSE、完整 hunk/Issue 摘录、结构化报告证据、状态发布与 stale-head 防护，以及审核记录、跳过、增量复审各条回退路径和额度诊断（`test/review-incremental.test.mjs` 与 `pr-review.test.mjs` 末尾）。`test/fixtures/review-evaluation.json` 提供小 PR、正确授权、删除授权、跨文件 pin 漂移、较大上下文、二进制与源端截断等合成场景。

`node scripts/evaluate-review-reports.mjs --reports <JSON文件>` 离线比较模型最终报告与场景位置：报告契约、漏掉的预期位置和额外位置。输入文件将 fixture ID 映射到模型最终 JSON 字符串。这个工具不调用模型；位置匹配也不代表语义正确，仍需人工判断，不能将确定性契约测试称为模型质量测量。

`node scripts/audit-review-callers.mjs --expected-sha <已选定的40位中央SHA>` 只读检查登记仓库的默认分支与开放 PR。PR head 与 pull_request 的 merge tree 分开显示：没有修改 caller 的旧分支可以从 main 继承新 pin，因此 head 的旧 SHA 仅为信息，不能据此断言当前 CI 使用旧版本。默认分支和 merge tree 的 pin/mapping 异常返回非零；不可读取的 merge ref 需结合实际 referenced_workflows 判断。巡检不读取或写入 Secret 值，不修改任何业务分支。发布仍先合中央，再按最终可信 SHA 更新 caller 的两处引用和必要测试常量。
