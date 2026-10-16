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
| A | OpenCode Go | OpenAI SDK / Responses SSE | Muse Spark 1.3 Contributor → 1.2 Contributor | 计入两路 quorum |
| B | Anthropic 官方 API（只经 szlab 台湾专用节点出口） | Anthropic SDK / Messages SSE | 每个 PR 的首次审核：Claude Sonnet 5.5（`first_pass`，effort high）；之后的提交：Claude Haiku 5.5（effort high）；无备用模型 | 计入两路 quorum |
| C | Command Code | OpenAI SDK / Chat Completions SSE | Hy3（`tencent/hy3-paid`，报告校准）→ GLM 5.3 Flash（`z-ai/glm-5.3-flash`） | advisory；有效时计入 quorum |

NebulaLab 的 Lane B 使用 Anthropic 官方 API（每月赠送额度）：首审由 Sonnet 5.5 完成，之后的提交由 Haiku 5.5 审核，首审结果折叠保留在同一条 Lane B 评论底部；2026-10-15 在 #1133/#1237/#1241 上实测，Sonnet 被核实的发现全部成立，Haiku 独有的发现（含两条 P1）全部是误报。首审时的 diff 中位数已是最终 diff 的 97%，因此每个 PR 只做一次首审。Anthropic 额度耗尽（402 `billing_error`，或 400 “credit balance is too low”）按套餐额度耗尽处理：首审不溢出，Haiku 经 Lane C 槽位改发 Command Code 上的同一模型一次。其余六个仓库的 Lane B 仍是 OpenCode Go 上的 Claude Haiku 5.5 → Kimi K2.7 Code。

Lane A/B 使用 OpenCode Go（整个 workspace 共用一个 5 小时/每周/每月额度池；NebulaLab 的 Lane B 除外），Lane C 使用 Command Code；额度以供应商实际返回为准，额度耗尽时返回 429 属于预期行为。Go 优先用满：Go 返回套餐额度耗尽（`GoUsageLimitError`）时，A/B 的每个模型把同一请求经 Lane C 的固定槽位改发 Command Code 上的同一模型一次（额度溢出，见“配置契约”的 `quota_overflow`），因此 Go 用尽时三路仍可发布；Command Code 用尽时 C 失效而 A/B 不受影响。失败的 Lane 仍然发布评论和诊断；七份配置均使用 `min_valid_lanes=2`，任何两路有效即可，包括 A+C 或 B+C。绿色检查不能证明每条 Lane 都成功。

### 统一 SDK 接入

A 使用官方 `openai` JavaScript SDK 的 Responses SSE；B 和 C 使用同一 SDK 的 Chat Completions SSE。每次请求创建独立 client 和 Undici dispatcher，明确 `maxRetries: 0`、禁止重定向、按当前模型预算配置响应头/正文超时；外层 AbortSignal 覆盖连接、接收和完整流迭代。没有全局 dispatcher、跨 Lane 连接共享或参数修复重发；跨 Lane 使用密钥只有额度溢出一种情况，即按配置使用 Lane C 的固定槽位。

连接阶段最多 30 秒且不超过模型总预算；IPv4/IPv6 地址探测间隔为 1 秒，避免跨区域连接被 Node 默认 250ms 探测窗口过早放弃。地址探测不重复发送审核请求，也不会增加模型的总时间预算。

SDK 负责 SSE 分帧、UTF-8 和 JSON 解码。适配层逐事件累计最终正文，只计数而不保存 `reasoning_content`、Responses reasoning item 等供应商私有思考；收到 choice 0 的 `finish_reason` 即确定审核结果，不等待 `[DONE]` 或 TCP EOF；Chat Completions 随后最多再读 1 秒 usage 尾帧，只用于 token 统计，尾帧缺失、超时、格式错误或错误事件都不改变已确定的结果。只有正文非空且 `finish_reason=stop` 才计入有效审核；断流、缺少结束原因、截断、错误事件均不能变成有效证据。Responses 仅将 `response.completed` 且状态 `completed` 的最终 `output_text` 归一为成功；incomplete、工具调用、refusal-only、错误和断流不算有效审核。

安全日志区分响应头时间、首个事件、首个正文、正文/思考字符数、结束原因和实际耗时；不记录请求正文、Key 或私有思考。原始响应限制为 32 MiB。B 使用 Claude Haiku 5.5 / Kimi K2.7 Code 主备（输出上限 120000 / 65536），C 使用 Hy3 / GLM 5.3 Flash 主备（输出上限均为 65536）。Haiku 固定 effort high，不添加 low/关闭思考参数；B 主备与 C 的 Hy3 时限各 15 分钟，C 的 GLM 5.3 Flash 备用 20 分钟。本地截止明确报 `REVIEW_DEADLINE`，不再把持续推理后的主动中止说成上游不可用。

SDK 对干净 EOF、`[DONE]` 和传输层 `AbortError` 都会静默结束迭代，因此适配层在原始正文层记录终止方式。流没有结束原因时仍报 `REVIEW_INCOMPLETE_STREAM`。失败评论只附 `code`、`http`、`end`、`last_event` 类型、`idle_before_end_ms` 和本地词汇内的 `body_error`；`finished` 日志记录全部脱敏证据：`incomplete_end`（`clean_close` 正常关流、`idle_close` 静默 60 秒以上后关流、`done_without_finish` 有 `[DONE]` 无结束原因、`transport_error` 被 SDK 吞掉的传输错误；未观察到正文结束时为 `unknown`）、`body_end`/`body_error`、`done_marker`、`frame_boundary`（是否停在完整 SSE 帧之后，零字节时为 null）、`max_gap_ms`、`idle_before_end_ms`、`last_event`（Chat Completions 为 `reasoning`、`content`、`no_choice:<键名>` 等，只含键名；Responses 为事件 type）以及 usage token 数。TCP 断开或重置不属于这一类，仍报 `UND_ERR_SOCKET`/`ECONNRESET`。每个失败还带 `unserved`：请求在产生任何正文、推理或结束原因之前就失败时为 true，供“未受理重发”判断；`done_marker` 按数据块逐段扫描，`[DONE]` 之后再跟多少数据都不会漏判。

依赖版本和 lockfile 在中央仓库管理；`npm run build` 打包 SDK 到 `review-action/dist/sdk-client.js`，真实审核只执行固定中央 SHA 的产物，不运行 npm、不下载依赖。CI 重建并比较产物，同时测试源码和产物的真实 TLS/SSE 行为。`SDK_LONG_HEADER_TEST=1` 可额外运行 310 秒响应头回归，验证请求不会被旧的 300 秒底层限制截断。

真实审核由固定 SHA 的 `actions/github-script` v8 执行，其 `action.yml` 声明 `using: node24`，不依赖 runner 的 shell Node 版本；添加 `setup-node` 也不会改变 JavaScript Action 自身运行时。配置解析 Action 独立使用 Node 20，不加载 SDK。没有活动 Lane 使用 Google 协议，保留的 legacy Google 分支不在这次迁移范围内。

配置由 `github.repository` 自动选择：

```text
review-action/config/repositories/
├─ TshyGO__ci-central.json
├─ TshyGO__NebulaLab.json
├─ TshyGO__NebulaLab-Docs.json
├─ TshyGO__NebulaLab-Plugins.json
├─ TshyGO__resume-form-assistant-plugin.json
├─ TshyGO__AI-Thesis-Polisher.json
└─ TshyGO__NebulaGraph-License-Service.json
```

七个仓库都使用相同的三 Lane 拓扑；唯一差别是 NebulaLab 的 Lane B 在 Anthropic 上并带首审模型。`ci-central` 的 policy 更侧重 reusable workflow、Action 供应链、Secret 边界和失败可见性；其余仓库按各自代码与文档风险调整 prompt。业务仓 caller 固定到已审核的 ci-central commit；`ci-central` 自身使用同仓库相对 reusable workflow，使 owner 创建的 PR 能实际审核和验收本次 workflow 修改，非 owner PR 不映射 Lane 密钥。

CodeRabbit 和 GitHub Copilot 不作为默认自动审核器；三 Lane 中央审核是默认 AI review。CodeRabbit 仓库配置同时关闭自动审核、跳过提示评论和状态检查；Copilot 自动审核需在 GitHub Copilot Code review 设置中保持关闭。

供应商、协议和 Secret 槽位绑定 Lane，不绑定模型 ID。同一个模型 ID 可以出现在不同 Lane，执行时仍使用各自 Lane 的地址和密钥。fallback 只能写在同一个 Lane 的 `fallbacks` 内，结构上不存在跨供应商 fallback。唯一的跨供应商路径是额度溢出（2026-10-15 经用户批准）：只在本 Lane 供应商返回套餐额度耗尽时触发，只发给同一模型，只用另一条 Lane 的固定 Secret 槽位，结果仍算本 Lane 的审核；超时、5xx、容量 429、认证和网络失败一律不跨供应商。

## Lane A 数据政策与专用出口

Muse Contributor 会允许供应商将提示词及回答用于训练，非 ZDR；仅在用户明确选择并在 Go 后台 opt-in 后启用。发送 `store:false` 不会撤销 Contributor 的训练许可。额度溢出时同一 Contributor 模型经 Command Code 发送，同样非 ZDR（Command Code 对 Muse 的 `x-cmd-zdr: 1` 返回 422 `cmd_zdr_no_providers`；Hy3、GLM 5.3、Kimi、Haiku 支持 ZDR，当前未强制开启）。地区与数据政策拒绝保持诊断，不降级为批准。

Go 请求带 `NebulaLab-CI-Review/1.0` User-Agent 与每仓库/PR/Lane 稳定的 `x-opencode-session`。A/B 的固定 base 为 `https://opencode.ai/zen/go/v1`；C 使用 Command Code Provider API，Lane C 槽位的 base 为 `https://api.commandcode.ai/provider/v1`（Bearer 认证，不带 `x-opencode-session`，不走 Go 的代理规则，self-hosted 直连；2026-10-15 已从 szlab 出口验证可达）。A/B 的额度溢出请求按目标供应商处理：同样直连 Command Code、不带 `x-opencode-session`，日志中模型名为 Command Code 的模型 ID。`RUNNER_ENVIRONMENT=github-hosted` 时直接连接并忽略 ambient proxy。明确的 `self-hosted` 环境中，Chat Completions 模型 `kimi-k2.7-code`、`glm-5.3`、`hy3` 使用独立直连 Agent；2026-10-10 已从 ci-review 的中国出口验证三者均返回非空最终内容及 `finish_reason=stop`。Muse Spark 1.3/1.2 直连返回 `403 RegionError`，使用已批准的模型代理：自托管 runner 可通过 `NEBULA_REVIEW_PROXY_URL=http://192.168.122.1:17890` 选择 szlab 内网 Mihomo；未设置该变量时，继续读取原有 `https_proxy` / `HTTPS_PROXY`，兼容 VPS `177.201.224.95:13128`。显式空值或不在白名单内的地址会拒绝请求，不会回退到 VPS 或直连。该变量只影响需要代理的模型，不修改 GitHub 的 runner 全局代理，也不改变 Kimi/GLM/Hy3 的直连。内网入口只允许明确的 self-hosted 环境，固定端口、不接受 URL 凭据、路径、查询或片段。未验证模型、其他协议和未知运行环境仍保留原代理要求，代理缺失或地址不匹配时拒绝直连。Claude Haiku 5.5（Messages）尚未从 ci-review 出口验证直连，因此在 self-hosted 上与 Muse 一样走已批准代理；它的 Kimi 备用按 Chat Completions 协议直连，C 的 Command Code Hy3/GLM 5.3 也直连，代理失效时 B 会立刻切到直连备用，两路 quorum 不受代理单点影响。SDK 的代理认证只发往代理，不会在请求失败后切换出口重试。日志仅输出模型和 `direct` / `approved-proxy` 路由，不输出代理凭据。两路有效审查的 quorum 不变；Muse 出口失效时，B/C 的有效审查仍可满足门槛。

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
- `lanes[].resend_unserved`：可选布尔值，默认 `false`。开启后，同一模型的请求在**没有产生任何模型输出**时（上游容量 429/5xx，或 200 后排队到关流都没有一个 token）可换会话重发一次；见下方“未受理重发”。当前只有 Lane C 开启。
- `lanes[].id`：固定 `A`、`B` 或 `C`，也是 Secret 槽位。
- `lanes[].provider`：运维标签；不会用于选择 Secret。
- `lanes[].protocol`：`openai-chat-completions`、`openai-responses`、`anthropic-messages` 或 `google-generate-content`。模型可用自己的 `protocol` 覆盖 Lane 协议（例如 B 的 Kimi 备用走 Chat Completions），仍使用该 Lane 的固定 Secret 槽位。
- `lanes[].advisory`：可选布尔值，默认 `false`。未配置 quorum 时，该 Lane 失败不单独阻塞；配置 `min_valid_lanes` 时所有有效 Lane 都计入数量，当前七个仓库均要求任意两路有效。至少保留一条非 advisory 的 Lane。
- `lanes[].request_timeout_ms` 与 `lanes[].model_budget_ms`：可选的 Lane 级预算覆盖；未配置时继承 `review_policy`，因此放大慢模型预算不会改变其他 Lane。
- 模型的 `request_timeout_ms`：可选单模型请求上限，优先于 Lane/仓库默认值，但仍受 Lane 的 `model_budget_ms` 限制。B 的 Haiku 主模型与 Kimi 备用均显式设为 900000 ms（Lane 级上限与总预算为 1800000 ms）；C 的 Lane 级请求上限为 900000 ms、`model_budget_ms` 为 1200000 ms，Hy3 继承 900000 ms，GLM 5.3 Flash 备用显式设为 1200000 ms；A 的 Lane 级上限与总预算为 600000 ms。
- `primary` 与 `fallbacks`：主模型加最多一个同 Lane 备用模型。主模型一次、失败切备用一次，备用失败即结束；配置第三个模型会被拒绝。
- 模型的 `context_profile` 与 `max_output_tokens`：Qwen、DeepSeek、GLM 均使用完整上下文。
- `omit_max_tokens`：仅用于明确要求省略 OpenAI `max_tokens` 的兼容端点。2026-09-16 起没有任何活动 Lane 使用它，字段保留给将来需要该请求形状的兼容端点；`openai-responses` 或 `google-generate-content` 协议下配置该字段会失败关闭。
- `thinking_level` 只允许配置在实际协议为 `google-generate-content` 的模型上，`effort`（`low`/`medium`/`high`/`xhigh`/`max`）只允许配置在 `anthropic-messages` 模型上，`anthropic-messages` 模型不接受 `temperature`；违反时失败关闭。
- Gemini 经 Go 时由 SDK 客户端走 `streamGenerateContent?alt=sse`：Go 只在 `https://opencode.ai/inference/go/v1` 提供 Gemini，因此 Lane 的 `/zen/go/v1` base 会映射过去，并带 `x-opencode-session` 与该 Lane 的出口策略。直接接 Google API 的 Lane（provider 不是 `opencode-go`）保留原来的单次 `generateContent` 请求。
- 模型的 `reporting_calibration`（布尔）：在系统提示末尾追加“报告校准”，要求把有代码证据的可疑问题以 medium/low 置信度报告，而不是自行否决或放进 limitations。当前 Muse 1.3/1.2 与 Hy3 开启：上周生产中 Muse/Kimi/Hy3 有 76–87% 的有效审查报告 0 个问题；实测校准后 Muse 在 #1237/#1133/#1241 由 2/2/— 增至 5/4/3 条，Hy3 由 0/0/1 变为 1/2/1 条（逐条核对：1 条成立的边界情况、2 条误报；#1241 “批量导入未查看文件按内置默认解析”一条在 2026-10-16 复核时确认引擎会补出相同的默认参数，实际无影响），二者在干净改动上均无高置信度误报、难题仍 5/5。Haiku 不开启：它不校准已在大 PR 上报告 1–6 条，开启后 #1237 增至 8 条但干净改动出现 3 条（含 1 条高置信度误报）；effort xhigh/max 即使输出上限 120000 也会在大 PR 上把输出全部用于思考而无报告。
- Gemini 已知行为：Gemini 偶尔完全不思考（usage 不含 `thoughtsTokenCount`，约 15–30 秒返回）。目前只在 ci-central #63（diff 大量涉及模型思考内容的处理代码）上观察到：同一请求 6 次中 3 次不思考、3 次思考 1.2–3.1 万 tokens，固定或新 session 结果相同；同仓库 #61/#62 的 4 次与 NebulaLab PR 的二十多次均正常思考。评论脚注此时显示 `Thinking: 0 tokens`，便于在生产中统计频率。
- Claude 经 Go 的 `/messages`（Anthropic 协议）调用，使用官方 `@anthropic-ai/sdk`，以 `x-api-key` 认证；Lane base 必须以 `/v1` 结尾。请求固定开启 adaptive thinking，深度只由 `effort` 控制。
- Lane 可选 `first_pass`（与其他模型同样校验，不能配置 `quota_overflow`，id 不得与主备重复）：PR 还没有首审时，它排在主模型前面先审，用同一 Lane 的供应商和密钥；成功后 Lane 评论写入 `ai-pr-review-first-pass:v1` 标记块，之后的提交只走主模型，并把这段首审原样折叠在评论底部（评论超过 GitHub 长度上限时保留标记、正文改为提示查看编辑历史）。首审失败时同一轮由主模型审核且不写标记，下一个提交会再试首审。
- `provider: anthropic` 的请求只允许在 `RUNNER_ENVIRONMENT=self-hosted` 且 `NEBULA_REVIEW_PROXY_URL=http://192.168.122.1:17890` 时发出：szlab Mihomo 对 `anthropic.com` 只路由到用户的台湾专用节点，没有其他出口。GitHub-hosted、VPS 代理或直连一律拒绝并发布诊断。
- 模型的 `quota_overflow`（`{ "credential_lane": "C", "id": "<目标供应商的模型 ID>" }`）：本 Lane 供应商返回套餐额度耗尽（`quota-exhausted`，如 Go 的 `GoUsageLimitError`、`insufficient_quota`）时，把同一请求（同一 prompt、协议、输出上限和 effort）改发 `credential_lane` 那条 Lane 的供应商和固定 Secret 槽位一次，模型 ID 换成 `id`，时限为该模型窗口扣除已用时间（含未受理重发及其等待）后的剩余部分，剩余不足 60 秒时不溢出、直接进入 fallback；溢出失败后照常进入本 Lane 的 fallback，fallback 遇到额度耗尽时同样溢出一次。目标必须是另一条已配置、供应商不同、自身没有溢出的 Lane；Google 协议不支持；只允许这两个字段。目标槽位未配置时不溢出，照常发布额度诊断。评论脚注写成 `Lane A: <模型> via <供应商> <目标模型 ID> (<本 Lane 供应商> quota exhausted)` 并加横幅说明，状态表显示“供应商额度已用尽，同模型经溢出供应商运行中”。当前七个仓库的 A/B 全部配置溢出到 Lane C（Command Code）：Muse 1.3/1.2 Contributor → `meta/muse-spark-1.3-contributor` / `meta/muse-spark-1.2-contributor`（Responses），Haiku 5.5 → `claude-haiku-5-5`（Messages），Kimi K2.7 Code → `moonshotai/Kimi-K2.7-Code`（Chat Completions）；2026-10-15 已从 szlab 用生产请求形状（流式、`store:false`、`x-api-key`、adaptive thinking + effort high）验证四者均正常完成。

`review-action` 在发送模型请求前校验配置。文件名、`repository` 字段和 `github.repository` 必须一致；未知仓库会失败关闭，不会落回某个默认模型。

reusable workflow 先解析并校验 40 位中央 ref：外部 caller 必须把 `uses` 中的同一个完整 SHA 重复传入唯一的非策略输入 `central_workflow_sha`；如果 GitHub 提供 `github.job_workflow_sha` 或 `github.job_workflow_ref`，则严格校验 workflow 路径、40 位 SHA 及二者一致性。当前 GitHub 外部 reusable job 实测不会暴露这两个字段，此时会发出 warning，并以受审 caller 的显式 SHA 检出 `review-action`/仓库 JSON、写入 v2 evidence。此 fallback 无法在 called workflow 内独立证明 `uses` 也使用相同 SHA，因此 caller 文件的 code review 是信任边界；三个业务仓必须同时修改 `uses` 与 `with.central_workflow_sha`，禁止使用分支或 tag。仅当 `github.repository` 严格等于 `TshyGO/ci-central` 且同仓相对 caller 无法提供上述 SHA 时，才使用本次事件的 `github.sha`。

## 精度、去重与节流保证

- reusable job 按仓库和 PR 号启用 `cancel-in-progress: true`：自动 PR 事件与手动 `/review` 共享同一并发组，新触发取消旧运行，不会并发更新同一组评论。
- 上下文收集前、模型调用前、发布评论前分别核对 PR head SHA。
- 每条 Lane 评论都包含 v2 机器证据：Lane、完整 40 位 head SHA、解析后的中央 workflow SHA 和 `valid`、`diagnostic` 或 `partial` 状态。
- 每条 Lane 评论在标题下方醒目标出审核 commit、更新时间和运行链接；新提交仍原地更新同一条稳定评论，不会因时间线位置不变而隐藏审核新鲜度。
- 自动触发只复用“同一 head、同一 reusable workflow 版本、状态为 `valid`”的 Lane；缺失、旧版、诊断和不完整 Lane 会单独重跑。
- 显式 `/review` 保持强制重跑语义，不受同 HEAD 去重限制。
- Lane 主模型成功时绝不调用 fallback。
- 所有模型请求失败（包括超时、限流、认证、HTML 验证页、DNS/TLS、解析失败、空正文和不完整输出）都只进入同 Lane 备用一次；唯一例外是配置了 `quota_overflow` 的模型遇到套餐额度耗尽，先把同一请求溢出到同一模型一次，再进入备用；备用失败后发布诊断或明确标记的不完整结果，不计为有效审核。未配置该 Lane 凭据时仍直接发布配置诊断，不发送请求。
- 不做退避重试，不做可选参数修复后重发，不跟随 HTTP 重定向。A/B/C 并行，每路一旦完整成功或主备均结束就立即校验 PR head/state 并发布稳定评论；不等待其他 Lane。最终 job 仍等待各路结束后执行原有 quorum/required 门禁，不因提早发布而提早放行。
- 当前保留主备各一次、逐路即时发布，B 主备与 C 的 Hy3 各 15 分钟、C 的 GLM 5.3 Flash 备用 20 分钟（`model_budget_ms` 是单个模型的上限，不是 Lane 的累计时长）；三路统一由 SDK 客户端流式接入。SDK 及连接层超时与模型预算匹配，但 DNS/TLS、网络或供应商错误仍可能提前失败。
- B 通过固定 Lane B 槽位调用 `claude-haiku-5-5`（Messages、effort high、输出上限 120000、diff 预算 120 万字符），失败一次立即切同 Lane 的 `kimi-k2.7-code`（Chat Completions、输出上限 65536）；C 通过固定 Lane C 槽位（Command Code）调用 `tencent/hy3-paid`（报告校准、输出上限 65536、diff 预算 26 万字符），失败一次立即切同 Lane、同供应商的 `z-ai/glm-5.3-flash`（不设温度、输出上限 65536、diff 预算 120 万字符、20 分钟窗口；Lane C 的 `model_budget_ms` 为 1200000 以容纳它）。Hy3 的输入上限为 192K tokens，因此沿用仓库默认的 26 万字符 diff 预算，超出部分按完整 hunk 省略并在 coverage 中注明；Gemini 专用的“两轮深审”合约只随 `google-generate-content` 协议发送，Hy3/GLM Flash 不带。
- B/C 的选型（2026-10-14）：Go Plus 按模型分别计月额度（Haiku $60、Gemini 4 Argon $240 限时双倍），订阅固定，目标是把好模型的额度用满。旧组合在 NebulaLab 上 2 天内 Kimi 有 17 次 900 秒截止、Hy3 有 17 次在约 300 秒被上游关流（成功最长 299 秒），B 是 81 次运行里 66 次的最慢 Lane。新模型在 NebulaLab #1241/#1237/#1133（7–23 万输入 tokens）实测：Haiku 5.5 effort high 146–211 秒全部有效、发现 3/5/2 条；effort max 在三个大 PR 上把 65536 个输出 token 全部用于思考、无报告，因此固定 high。Gemini 4 Argon thinking high 87–215 秒全部有效、难题 4/5–5/5，但真实 PR 上报告的问题数为 0：思考摘要显示它追踪到了真实问题却判为不可操作。Gemini 系统提示在深审合约后追加“报告校准”（可疑但有代码证据的问题以 medium/low 置信度报告，不丢进 limitations）后，#1237/#1241 分别报告 4/1 条（思考约 3.4 万 tokens、269–346 秒、每次约 $0.75–0.93），干净改动仍 0 误报、难题 5/5。Gemini 单次约 $0.34–1.03，成本过高，2026-10-15 撤下。
- C 的选型（2026-10-15）：以质量为先、成本为门槛重测便宜与免费候选（同一组 #1237/#1241/#1133、合成难题与干净改动）。DeepSeek V4.1 Flash 在 6 次大 PR 中全部输出非 JSON；Qwen3.8 Flash 与 Step 5 Preview Free 大 PR 需 8–14 分钟；MiniMax M3 格式不稳且引用常不可校验（且只有显式发送 `thinking` 时才思考）；Omen Alpha 难题 1/5 且未在 Go 文档登记；Cat Jam Free 很快但真实 PR 几乎不报告、且不对中国地区开放；LongCat 2.5 Preview Free 13–15 分钟且频繁 429。校准后的 Hy3 115–156 秒完成全部大 PR、格式稳定，每次约 $0.02，因此作为 C 主模型，GLM 5.3 兜底。
- C 的备用（2026-10-16）：GLM 5.3 兜底在 Command Code 上 3 个大 PR 全部未完成，生产中 16 次仅 3 次正常结束，单价约 $1.40/$4.40 每百万 tokens。改为 GLM 5.3 Flash（约 $0.15/$0.50，GOAT 单独 $60 额度）：同一组 #1237/#1241/#1133 与合成难题、干净改动上，从 szlab 经 Command Code 实测 6–8 分钟完成全部大 PR（65–69 tok/s，每次先思考约 3 万 tokens）、合约有效，难题 4/5、干净改动 1 条低置信度；但它常把代码证据缩写成 `...` 或夹带注释，大 PR 上 7 条发现只有 1 条通过证据校验（其余列入“审查范围与限制”待人工核实，其中包括 #1237 已核实为真的 OSError→`INSUFFICIENT_STORAGE`）。同期 Hy3 为 97/42/272/176/181 秒、6 条发现全部通过校验，因此 Hy3 继续做主模型，GLM 5.3 Flash 只做备用。GLM 5.3 FlashX 更快（250–318 秒），但干净改动出现 2 条高置信度误报，未采用；Flash 加报告校准没有带来更多可校验的发现，且有 1 次在 476 秒无输出断流，因此不开启。
- C 的供应商（2026-10-15）：OpenCode Go 的额度是整个 workspace 共用一个池（5 小时/每周/每月），而不是按模型分别计；本周达到周上限后 A/B/C 全部返回 `GoUsageLimitError`。因此 C 整条迁到 Command Code GOAT 套餐（$10/月，含 Hy3、GLM 5.3、Kimi K2.7 Code、Muse Spark 1.3/1.2 Contributor、Claude Haiku 5.5 等模型额度；用量上限每 5 小时 $14、每 7 天 $35、每月 $70），模型与参数不变；Go 用尽时 C 仍能发布评审。早先记录的“Claude 与 Muse 在该套餐上返回 403”是在本地 PC 网络下测得，2026-10-15 从 szlab 重测四者均为 200，那条记录有误。随后 A/B 加入额度溢出：Go 返回额度耗尽时，同一模型经 Lane C 槽位改走 Command Code，Go 额度仍优先用满，两份订阅都用上，又不会因 Go 用尽而整周无审核。Go 用尽期间三路都消耗 GOAT 额度，7 天 $35 的上限可能先到；不够时升级 Command Code 套餐。
- C 的选型（2026-10-06）：在同一套真实业务 PR（NebulaLab #1106、resume #235）与带隐藏缺陷的合成审核上实测 15 个 Go 模型。MiMo V2.6 Pro 在业务 PR 上需 24–28 分钟（22–42 tok/s），已不适合作为必跑 Lane；Hy3 在难度最高的合成题上与 MiMo V2.6 Pro、GLM 5.3 同样命中 5/5 隐藏缺陷且不误报干扰项，真实 PR 约 3–4 分钟、每次约 $0.015。Kimi K2.7 Code 同样快且能发现实质问题，但引用位置常需校验扣下，作 C 的同 Lane 备用。
- B 的选型（2026-10-06）：GLM 5.3 审核最严谨，但在业务 PR 上每次 6–15 分钟、约 $0.20–0.26；按每月约 850 次审核会单独吃掉约 $170，接近 Go Plus 月额度（约 $180 模型用量），而额度耗尽会同时阻断共用同一账户的 A/B/C。B 因此改为 Kimi K2.7 Code（真实 PR 4–6 分钟、约 $0.10–0.14，曾命中其他模型才发现的关键问题），GLM 5.3 只在 Kimi 失败时兜底；预计每月约 $130–135。Muse Spark 1.3 在同一套实测中难题 5/5、零误报、真实 PR 1–1.5 分钟，继续作为 A。
- 每个模型最多一次产生输出的请求，Lane 的单模型窗口是截止上限（B 主备与 C 的 Hy3 各 15 分钟，C 的 GLM 5.3 Flash 备用 20 分钟），提前失败立即切备用，无重试、退避或参数修复重发。唯一例外是“未受理重发”：开启 `resend_unserved` 的 Lane，若请求在产生任何正文、推理或结束原因之前就被上游以 429/5xx 拒绝，或 200 后排队到关流都没有一个数据事件，则换一个 `x-opencode-session`（后缀 `-resend`，避免粘住同一上游）重发同一模型一次：429/5xx 按 `retry-after`（上限 120 秒）或 30 秒后重发，排队关流立即重发；重发只用该模型剩余的窗口（不足 60 秒则直接切备用），再失败才切备用。Go 计划额度（`*UsageLimitError`、`insufficient_quota`）、认证、端点不可达、本地截止和已产生输出的失败一律不重发；其中套餐额度耗尽只按 `quota_overflow` 改发另一供应商上的同一模型一次，不在原供应商重发。这类请求没有生成内容，重发不会产生重复审核或重复推理费用。主模型成功绝不调用备用；实际使用备用时评论明确标记，不能当成主模型成功。模型是否可用以 exact-head Lane 评论和日志验收，不能用短探针或 wrapper 绿色检查代替。
- Muse Spark 1.2 Contributor 仅作为 Lane A 的同供应商备用；主模型固定为用户指定的 Muse Spark 1.3 Contributor。完整上下文、16384 输出上限，Responses 不添加额外思考或采样参数。
- reusable job 兜底 70 分钟，覆盖 B 主备最多 30 分钟、C 主备最多 45 分钟（三路并行）及准备/发布。正常 `stop` 即结束，不强迫模型消耗全部预算；30 分钟是保护上限，不保证每次都能生成。
- 每个健康 Lane 只发布一条稳定标记评论；隐藏 reasoning 永不进入 PR 评论。
- 未配置、失败或输出不完整的 Lane 会保留诊断/部分结果；有效 Lane 数不足 quorum（或未配置 quorum 时缺少必需 Lane）才在发布其他健康 Lane 后明确失败。

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
npm ci --ignore-scripts
npm run build
node ./test/review-config.test.mjs
node ./test/pr-review.test.mjs
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
- 完整终止只证明生成完成；文件、同侧 hunk 与代码引用的实际位置通过契约校验后才计为 `valid`。唯一代码引用可修正同 hunk 内的模型误报行号，并记录原行号。单条发现的文件、行号或代码引用无法校验（含歧义位置）时，只扣下这一条：它不作为发现发布，只把优先级、标题和失败原因列入限制并标为待人工核实，其余已校验内容仍计为 `valid`；整份报告只在不是 JSON 对象或结构非法时拒绝。JSON 外包裹的说明文字或代码围栏会被忽略，只使用其中的对象。自由叙述按纯文本转义，代码引用保留原格式，不产生模型生成的图片或通知提及。这个校验不证明结论正确，不代替人工批准。格式或证据契约失败只切一次同 Lane 备用，不修参数重发；不完整响应继续保持 `partial`，不计入 quorum。所有变更都没有文本 patch（二进制、纯重命名或补丁不可用）时不发送模型请求、不发布 Lane 评论、不判失败，只在当前提交状态表中标明“无可审查的文本补丁”并输出 notice；这既不是审核失败，也不代表已审核。存在文本 patch 但一个完整 hunk 都放不进预算时，仍按缺少审核证据失败。
- `review-status.js`：一条独立、按当前完整 head/workflow/run 标记的状态汇总，显示主模型、备用运行、实际服务模型、有效发布数与发布失败。历史 Lane 评论在新结果到达前仍保留，汇总说明它们不代表新提交。每次异步写入前重新核对 PR head/state，写入串行；汇总写入失败不重试模型、不影响独立 Lane 门禁。被取消的运行可能留下最后观测状态，运行链接是最终状态依据。

模型、供应商、六个 Secret 槽位、主备各一次、B/C 的 30 分钟上限与任意两路 quorum 都保持原有配置。稳定 Lane 身份标记只在评论首行识别，代码引用里的相同字符串不会伪造另一条 Lane。

### 验证与发布巡检

`npm test` 同时覆盖受信任 workflow 桥接、源码和生产 runner 产物、SDK TLS/SSE、完整 hunk/Issue 摘录、结构化报告证据、状态发布与 stale-head 防护。`test/fixtures/review-evaluation.json` 提供小 PR、正确授权、删除授权、跨文件 pin 漂移、较大上下文、二进制与源端截断等合成场景。

`node scripts/evaluate-review-reports.mjs --reports <JSON文件>` 离线比较模型最终报告与场景位置：报告契约、漏掉的预期位置和额外位置。输入文件将 fixture ID 映射到模型最终 JSON 字符串。这个工具不调用模型；位置匹配也不代表语义正确，仍需人工判断，不能将确定性契约测试称为模型质量测量。

`node scripts/audit-review-callers.mjs --expected-sha <已选定的40位中央SHA>` 只读检查登记仓库的默认分支与开放 PR。PR head 与 pull_request 的 merge tree 分开显示：没有修改 caller 的旧分支可以从 main 继承新 pin，因此 head 的旧 SHA 仅为信息，不能据此断言当前 CI 使用旧版本。默认分支和 merge tree 的 pin/mapping 异常返回非零；不可读取的 merge ref 需结合实际 referenced_workflows 判断。巡检不读取或写入 Secret 值，不修改任何业务分支。发布仍先合中央，再按最终可信 SHA 更新 caller 的两处引用和必要测试常量。
