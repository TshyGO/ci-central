"use strict";

// review-action/src/review-runner.js
async function runReview({
  github,
  context,
  env = globalThis.process.env,
  fetch = globalThis.fetch,
  timers = globalThis,
  logger = globalThis.console,
  sdk
}) {
  const process = { env };
  const console = logger;
  const { setTimeout, clearTimeout } = timers;
  const pullNumber = context.payload.pull_request?.number ?? context.payload.issue?.number;
  const { owner, repo } = context.repo;
  let reviewConfig;
  try {
    reviewConfig = JSON.parse(process.env.PR_REVIEW_CONFIG || "");
  } catch (error) {
    throw new Error(`Central PR review config is invalid JSON: ${error.message}`);
  }
  if (reviewConfig.repository !== `${owner}/${repo}` || !Array.isArray(reviewConfig.lanes) || reviewConfig.lanes.length === 0) {
    throw new Error(`Central PR review config does not match ${owner}/${repo}.`);
  }
  const workflowSha = (process.env.PR_REVIEW_WORKFLOW_SHA || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(workflowSha)) {
    throw new Error("The resolved reusable workflow ref must provide the full 40-character ci-central commit SHA.");
  }
  const lanes = reviewConfig.lanes;
  if (lanes.every((lane) => lane.advisory === true)) {
    throw new Error("At least one lane must be required; every configured lane is advisory.");
  }
  const reviewPolicy = reviewConfig.review_policy || {};
  if (reviewPolicy.min_valid_lanes !== void 0) {
    const minimum = reviewPolicy.min_valid_lanes;
    if (!Number.isInteger(minimum) || minimum < 1 || minimum > lanes.length) {
      throw new Error(`review_policy.min_valid_lanes must be an integer between 1 and the ${lanes.length} configured lane(s).`);
    }
  }
  if (typeof reviewPolicy.system_prompt !== "string" || !reviewPolicy.system_prompt.trim()) {
    throw new Error("Central PR review config is missing review_policy.system_prompt.");
  }
  const laneCredentials = {
    A: {
      apiKey: process.env.LANE_A_KEY,
      baseUrl: (process.env.LANE_A_API_BASE || "").replace(/\/$/, "")
    },
    B: {
      apiKey: process.env.LANE_B_KEY,
      baseUrl: (process.env.LANE_B_API_BASE || "").replace(/\/$/, "")
    },
    C: {
      apiKey: process.env.LANE_C_KEY,
      baseUrl: (process.env.LANE_C_API_BASE || "").replace(/\/$/, "")
    }
  };
  for (const lane of lanes) {
    if (!["openai-chat-completions", "openai-responses", "google-generate-content"].includes(lane.protocol)) {
      throw new Error(`Lane ${lane.id} protocol is not supported.`);
    }
    if (!Array.isArray(lane.fallbacks)) {
      throw new Error(`Lane ${lane.id} fallbacks must be an array.`);
    }
    if (lane.advisory !== void 0 && typeof lane.advisory !== "boolean") {
      throw new Error(`Lane ${lane.id} advisory must be a boolean.`);
    }
    if (lane.fallbacks.length > 1) throw new Error(`Lane ${lane.id} supports at most one fallback.`);
    const chain = [lane.primary, ...lane.fallbacks];
    if (!lane.primary || chain.some((model) => !model?.id || !model?.label)) {
      throw new Error(`Lane ${lane.id} has an invalid primary or fallback model.`);
    }
    if (new Set(chain.map((model) => model.id)).size !== chain.length) {
      throw new Error(`Lane ${lane.id} contains a duplicate primary/fallback model id.`);
    }
    for (const field of ["request_timeout_ms", "model_budget_ms"]) {
      if (lane[field] !== void 0 && (!Number.isInteger(lane[field]) || lane[field] < 1)) {
        throw new Error(`Lane ${lane.id} ${field} must be a positive integer when configured.`);
      }
    }
    if (lane.request_timeout_ms !== void 0 && lane.model_budget_ms !== void 0 && lane.model_budget_ms < lane.request_timeout_ms) {
      throw new Error(`Lane ${lane.id} model_budget_ms must be greater than or equal to request_timeout_ms.`);
    }
    for (const model of chain) {
      if (model.request_timeout_ms !== void 0 && (!Number.isInteger(model.request_timeout_ms) || model.request_timeout_ms < 1)) {
        throw new Error(`Lane ${lane.id}/${model.id} request_timeout_ms must be a positive integer when configured.`);
      }
      if (model.omit_max_tokens !== void 0 && typeof model.omit_max_tokens !== "boolean") {
        throw new Error(`Lane ${lane.id}/${model.id} omit_max_tokens must be a boolean.`);
      }
      if (model.omit_max_tokens && lane.protocol !== "openai-chat-completions") {
        throw new Error(`Lane ${lane.id}/${model.id} omit_max_tokens is only supported by openai-chat-completions.`);
      }
      if (model.thinking_level === void 0) continue;
      if (lane.protocol !== "google-generate-content") {
        throw new Error(`Lane ${lane.id}/${model.id} thinking_level is only supported by google-generate-content.`);
      }
      if (!["minimal", "low", "medium", "high"].includes(model.thinking_level)) {
        throw new Error(`Lane ${lane.id}/${model.id} thinking_level is not supported.`);
      }
    }
  }
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  const eventHeadSha = context.payload.pull_request?.head?.sha;
  const reviewHeadSha = pull.head.sha;
  if (eventHeadSha && eventHeadSha !== reviewHeadSha) {
    console.log(`Skip stale review before context collection: event=${eventHeadSha.slice(0, 7)} current=${reviewHeadSha.slice(0, 7)}.`);
    return;
  }
  const existingComments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100
  });
  const evidencePattern = /<!-- ai-pr-review-evidence:v2 lane=([A-C]) head=([0-9a-f]{40}) workflow=([0-9a-f]{40}) status=(valid|diagnostic|partial) -->/i;
  const reusableLaneIds = /* @__PURE__ */ new Set();
  for (const lane of lanes) {
    const stableMarker = `<!-- ai-pr-review-bot:lane-${lane.id} -->`;
    const laneComments = existingComments.filter((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(stableMarker));
    if (laneComments.length !== 1) {
      if (laneComments.length > 1) {
        console.log(`Lane ${lane.id} has ${laneComments.length} stable comments; forcing a rerun to reconcile duplicates.`);
      }
      continue;
    }
    const evidence = evidencePattern.exec(laneComments[0].body || "");
    if (!evidence) continue;
    const [, laneId, headSha, evidenceWorkflowSha, status] = evidence;
    if (laneId.toUpperCase() === lane.id && headSha.toLowerCase() === reviewHeadSha.toLowerCase() && evidenceWorkflowSha.toLowerCase() === workflowSha && status.toLowerCase() === "valid") {
      reusableLaneIds.add(lane.id);
    }
  }
  const isManualReview = context.eventName === "issue_comment";
  const lanesToReview = isManualReview ? lanes : lanes.filter((lane) => !reusableLaneIds.has(lane.id));
  if (reusableLaneIds.size) {
    console.log(`Reusable valid review evidence for ${reviewHeadSha.slice(0, 7)}: ${[...reusableLaneIds].sort().map((lane) => `Lane ${lane}`).join(", ")}.`);
  }
  if (lanesToReview.length === 0) {
    const { data: dedupePull } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber
    });
    if (dedupePull.head.sha !== reviewHeadSha || dedupePull.state !== "open") {
      console.log(`Skip stale evidence reuse: reviewed=${reviewHeadSha.slice(0, 7)} current=${dedupePull.head.sha.slice(0, 7)} state=${dedupePull.state || "unknown"}.`);
      return;
    }
    console.log(`All configured Lanes already have valid review evidence for head ${reviewHeadSha} at workflow ${workflowSha}; skipping model requests.`);
    return;
  }
  if (isManualReview) {
    console.log("Manual /review bypasses same-HEAD evidence reuse and forces every configured Lane to run.");
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
  const issueRefPattern = /#(\d+)/g;
  const issueSources = [pull.title || "", pull.body || ""];
  const prCommits = await github.paginate(github.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });
  for (const c of prCommits) issueSources.push(c.commit?.message || "");
  const issueNumbers = [...new Set(
    issueSources.flatMap((t) => [...t.matchAll(issueRefPattern)].map((m) => Number(m[1])))
  )].slice(0, 10);
  let issueContext = "";
  for (const num of issueNumbers) {
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: num });
      if (issue.pull_request) continue;
      issueContext += `
### Issue #${num}: ${issue.title}
${(issue.body || "").slice(0, 2e3)}
`;
    } catch (error) {
      console.log(`Skip referenced issue #${num}: ${error.message}`);
    }
  }
  const DIFF_BUDGET = Math.max(4e3, Number(reviewPolicy.diff_char_budget) || 1e5);
  const SEPARATOR = "\n\n---\n\n";
  const TRUNCATION_NOTE = "\n[... patch truncated to fit the diff budget ...]";
  const isTestFile = (name) => /(^|\/)(tests?|__tests__|__mocks__)\//.test(name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|\/)test_[^/]+\.py$/.test(name) || /_test\.(go|py|rs)$/.test(name);
  const orderedFiles = [...files].sort(
    (a, b) => Number(isTestFile(a.filename)) - Number(isTestFile(b.filename))
  );
  function packDiff(budget) {
    const keptBlocks = [];
    const omittedFiles = [];
    let usedChars = 0;
    for (const file of orderedFiles) {
      const patch = file.patch || "[binary or patch unavailable]";
      const block = [
        `File: ${file.filename}`,
        `Status: ${file.status}; +${file.additions} -${file.deletions}`,
        patch
      ].join("\n");
      const separatorCost = keptBlocks.length ? SEPARATOR.length : 0;
      const remaining = budget - usedChars - separatorCost;
      if (block.length <= remaining) {
        keptBlocks.push(block);
        usedChars += block.length + separatorCost;
      } else if (remaining > TRUNCATION_NOTE.length + 400) {
        keptBlocks.push(block.slice(0, remaining - TRUNCATION_NOTE.length) + TRUNCATION_NOTE);
        usedChars = budget;
      } else {
        omittedFiles.push(file.filename);
      }
    }
    let text = keptBlocks.join(SEPARATOR);
    const packedChars = text.length;
    if (omittedFiles.length) {
      const shown = omittedFiles.slice(0, 20).join(", ");
      const names = shown.length > 400 ? `${shown.slice(0, 400)}\u2026` : shown;
      const more = omittedFiles.length > 20 ? ` (+${omittedFiles.length - 20} more)` : "";
      text += `

[${omittedFiles.length} file(s) omitted to fit the ${budget}-character patch budget: ${names}${more}]`;
    }
    return { text, kept: keptBlocks.length, packedChars, omitted: omittedFiles.length };
  }
  const diffPack = packDiff(DIFF_BUDGET);
  console.log(`Diff packed: ${diffPack.kept}/${files.length} files, ${diffPack.packedChars}/${DIFF_BUDGET} patch chars, ${diffPack.omitted} omitted.`);
  const kimiK3Pack = packDiff(1e3);
  const fileList = files.map((file) => `${file.filename} (${file.status}, +${file.additions} -${file.deletions})`).join("\n");
  const system = reviewPolicy.system_prompt;
  const kimiK3System = `${system} Focus on high-confidence, high-impact findings supported by the supplied file inventory and patch sample.`;
  const googleDeepReviewContract = "Perform two independent internal review passes before writing the final answer: first trace correctness, edge cases, error paths, and contract preservation; then challenge security, architecture boundaries, CI or configuration, and test adequacy. Treat the PR description and passing tests as claims to verify, not proof. Write findings first. Each actionable finding must include severity, exact file or diff-hunk evidence, impact, and a concrete fix. If no actionable finding remains, state the failure paths and invariants you checked plus residual risks. Concise means omit filler and praise, never analysis. Do not invent findings or expose hidden reasoning.";
  const buildUser = (diffText, options = {}) => [
    `Repository: ${owner}/${repo}`,
    `Pull Request: #${pull.number} ${pull.title}`,
    `Author: ${pull.user.login}`,
    `Base: ${pull.base.ref}`,
    `Head: ${pull.head.ref}`,
    "",
    "PR description:",
    (pull.body || "[No description]").slice(0, options.descriptionLimit ?? 4e3),
    "",
    options.issueText ?? issueContext ? `Referenced issues (background \u2014 what & why):
${options.issueText ?? issueContext}` : "Referenced issues: none.",
    "",
    ...options.fileList ? ["All changed file names:", options.fileList, ""] : [],
    "Changed files and patches:",
    diffText || "[No diff available]"
  ].join("\n");
  const user = buildUser(diffPack.text);
  const kimiK3User = buildUser(kimiK3Pack.text, {
    descriptionLimit: 2e3,
    issueText: issueContext.slice(0, 2e3),
    fileList
  });
  if (reviewPolicy.max_attempts !== 1) {
    throw new Error("review_policy.max_attempts must be 1; model retries are disabled.");
  }
  const defaultRequestTimeoutMs = Number(reviewPolicy.request_timeout_ms) || 3e5;
  const defaultModelBudgetMs = Number(reviewPolicy.model_budget_ms) || 36e4;
  const { requestChatCompletion } = sdk || require("./sdk-client.js");
  function stripThinking(text) {
    if (!text) return "";
    return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
  }
  function basePayload(model) {
    const throttled = model.context_profile === "kimi-k3-throttled";
    const messages = [
      { role: "system", content: throttled ? kimiK3System : system },
      { role: "user", content: throttled ? kimiK3User : user }
    ];
    const payload = {
      model: model.id,
      messages,
      stream: true
    };
    if (!model.omit_max_tokens) payload.max_tokens = model.max_output_tokens;
    if (Number.isFinite(model.temperature)) payload.temperature = model.temperature;
    return payload;
  }
  function googlePayload(model) {
    const throttled = model.context_profile === "kimi-k3-throttled";
    const generationConfig = { maxOutputTokens: model.max_output_tokens };
    if (model.thinking_level) {
      generationConfig.thinkingConfig = {
        thinkingLevel: model.thinking_level.toUpperCase()
      };
    }
    const googleSystem = `${throttled ? kimiK3System : system}

${googleDeepReviewContract}`;
    return {
      systemInstruction: { parts: [{ text: googleSystem }] },
      contents: [{ role: "user", parts: [{ text: throttled ? kimiK3User : user }] }],
      generationConfig
    };
  }
  function responsesPayload(model) {
    const chat = basePayload(model);
    return { model: model.id, input: chat.messages, max_output_tokens: model.max_output_tokens, store: false };
  }
  function classifyFailure(response, responseText, requestError) {
    const status = response?.status;
    const rawText = `${responseText || ""}
${requestError || ""}`;
    const text = rawText.toLowerCase();
    const quotaExhausted = status === 429 && (text.includes("insufficient_quota") || /token[- ]?plan[^\n]*quota[^\n]*(exhausted|reached)/i.test(text) || /weekly[^\n]*quota[^\n]*(exhausted|reached)/i.test(text) || /quota[^\n]*reset at/i.test(text));
    const authenticationFailed = status === 401 || status === 403 && /(invalid[_ -]?api[_ -]?key|authentication|unauthori[sz]ed)/i.test(text);
    const gatewayBlocked = /^\s*(<!doctype html|<html\b)/i.test(responseText || "") || !response?.ok && text.includes("\u9A8C\u8BC1\u5931\u8D25");
    const endpointUnavailable = !response && /fetch failed|enotfound|eai_again|getaddrinfo|econnrefused|certificate|\btls\b/i.test(text);
    if (quotaExhausted) return { kind: "quota-exhausted" };
    if (authenticationFailed) return { kind: "authentication-failed" };
    if (gatewayBlocked) return { kind: "gateway-blocked" };
    if (endpointUnavailable) return { kind: "endpoint-unavailable" };
    return { kind: "model-or-upstream-failure" };
  }
  async function callModel(lane, model) {
    const requestTimeoutMs = model.request_timeout_ms ?? lane.request_timeout_ms ?? defaultRequestTimeoutMs;
    const modelBudgetMs = Number(lane.model_budget_ms) || defaultModelBudgetMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, modelBudgetMs));
    const startedAt = Date.now();
    let response;
    let responseText = "";
    let requestError = "";
    let errorCode = "";
    try {
      const credentials = laneCredentials[lane.id];
      let proxyUrl;
      if (lane.provider === "opencode-go" && process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
        proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || void 0;
        let proxy;
        try {
          proxy = new URL(proxyUrl);
        } catch {
        }
        if (!proxy || proxy.protocol !== "http:" || proxy.hostname !== "177.201.224.95" || proxy.port !== "13128" || proxy.search || proxy.hash || !["", "/"].includes(proxy.pathname)) {
          throw new Error("Lane A requires the approved VPS proxy unless explicitly GitHub-hosted; refusing direct fallback.");
        }
      }
      const isGoogle = lane.protocol === "google-generate-content";
      response = isGoogle ? await fetch(`${credentials.baseUrl}/models/${encodeURIComponent(model.id)}:generateContent`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "x-goog-api-key": credentials.apiKey,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "GitHubActions-AI-PR-Review"
        },
        body: JSON.stringify(googlePayload(model))
      }) : await requestChatCompletion({
        apiKey: credentials.apiKey,
        baseURL: credentials.baseUrl,
        protocol: lane.protocol,
        proxyUrl,
        sessionId: lane.provider === "opencode-go" ? `${owner}-${repo}-pr-${pullNumber}-lane-${lane.id}` : void 0,
        payload: lane.protocol === "openai-responses" ? responsesPayload(model) : basePayload(model),
        signal: controller.signal,
        timeoutMs: Math.min(requestTimeoutMs, modelBudgetMs),
        onProgress: (progress) => console.log(`[Lane ${lane.id}/${model.id}] sdk=${JSON.stringify(progress)}`)
      });
      responseText = await response.text();
    } catch (error) {
      if (Number.isInteger(error?.status)) {
        response = { status: error.status, ok: false };
        responseText = JSON.stringify({ error: { code: error.providerCode, type: error.providerType } });
      }
      const code = error?.cause?.code || error?.code;
      errorCode = typeof code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(code) ? code : "";
      requestError = error?.name === "AbortError" ? "Local review deadline reached before a complete final response; this is not proof of an upstream outage." : error?.message || String(error);
    } finally {
      clearTimeout(timeout);
    }
    const failure = classifyFailure(response, responseText, requestError);
    const usable = response?.ok && !requestError && failure.kind !== "gateway-blocked";
    console.log(`[Lane ${lane.id}/${model.id}] attempt 1/1 elapsed_ms=${Date.now() - startedAt} status=${response?.status ?? "request failed"} error_code=${errorCode || "none"}`);
    if (!usable) {
      console.log(`[Lane ${lane.id}/${model.id}] provider=${lane.provider} protocol=${lane.protocol} failed: ${(responseText || requestError || "").slice(0, 1e3)}`);
    }
    return { response, responseText, requestError, attempts: 1, failureKind: usable ? "" : failure.kind };
  }
  function extractReview(lane, model, responseText) {
    const payload = JSON.parse(responseText);
    if (lane.protocol === "google-generate-content") {
      const candidate = payload?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const content2 = stripThinking(parts.filter((part) => part?.thought !== true).map((part) => part?.text || "").join("\n"));
      const finishReason2 = candidate?.finishReason;
      const normalizedFinishReason2 = typeof finishReason2 === "string" ? finishReason2.toLowerCase() : "";
      const usage = payload?.usageMetadata || {};
      const explicitThoughtTokens = Number(usage.thoughtsTokenCount);
      const derivedThoughtTokens = Number(usage.totalTokenCount) - Number(usage.promptTokenCount) - Number(usage.candidatesTokenCount);
      const hasExplicitThoughtTokens = Number.isFinite(explicitThoughtTokens);
      const hasDerivedThoughtTokens = Number.isFinite(derivedThoughtTokens) && derivedThoughtTokens >= 0;
      const reasoningLength2 = hasExplicitThoughtTokens ? explicitThoughtTokens : hasDerivedThoughtTokens ? derivedThoughtTokens : 0;
      const reasoningUnit = hasExplicitThoughtTokens || hasDerivedThoughtTokens ? "tokens" : null;
      console.log(`[Lane ${lane.id}/${model.id}] api=generateContent finish_reason=${finishReason2} contentLen=${content2.length} thoughtTokens=${reasoningUnit ? reasoningLength2 : "not-reported"} usage=${JSON.stringify(usage)}`);
      let review2 = content2;
      if (review2 && normalizedFinishReason2 && normalizedFinishReason2 !== "stop") {
        review2 += "\n\n> \u26A0\uFE0F \u6A21\u578B\u8F93\u51FA\u672A\u5B8C\u6574\u7ED3\u675F\uFF0C\u8FD9\u6761 review \u53EF\u80FD\u4E0D\u5B8C\u6574\u3002";
      }
      return { review: review2, reasoningLength: reasoningLength2, reasoningUnit, complete: !normalizedFinishReason2 || normalizedFinishReason2 === "stop" };
    }
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason;
    const normalizedFinishReason = typeof finishReason === "string" ? finishReason.toLowerCase() : "";
    const reasoning = message?.reasoning_content || "";
    const reasoningLength = Number.isFinite(payload?.reasoning_chars) ? payload.reasoning_chars : reasoning.length;
    const content = stripThinking(message?.content);
    let review = content;
    console.log(`[Lane ${lane.id}/${model.id}] api=chat/completions upstream=${payload?.model} finish_reason=${finishReason} contentLen=${message?.content?.length || 0} reasoningLen=${reasoningLength} usage=${JSON.stringify(payload?.usage)}`);
    if (review && normalizedFinishReason === "length") {
      review += "\n\n> \u26A0\uFE0F \u6A21\u578B\u8F93\u51FA\u8FBE\u5230 max_tokens \u4E0A\u9650\uFF0C\u8FD9\u6761 review \u53EF\u80FD\u4E0D\u5B8C\u6574\u3002";
    }
    return { review, reasoningLength, reasoningUnit: reasoningLength ? "chars" : null, complete: !normalizedFinishReason || normalizedFinishReason === "stop" };
  }
  async function requestReview(lane) {
    const primary = lane.primary;
    const chain = [primary, ...lane.fallbacks];
    const credentials = laneCredentials[lane.id];
    if (!credentials?.apiKey || !credentials?.baseUrl) {
      console.log(`[Lane ${lane.id}] fixed credential slots are not available; skipping model requests for this lane.`);
      return {
        lane,
        primary,
        servedBy: null,
        reasoningLength: 0,
        degraded: false,
        status: "diagnostic",
        review: [
          "> AI review was not generated.",
          "",
          `Lane ${lane.id} is not provisioned.`,
          "",
          `Action needed: set PR_AGENT_LANE_${lane.id}_KEY and PR_AGENT_LANE_${lane.id}_API_BASE in the caller repository.`
        ].join("\n")
      };
    }
    const tried = [];
    let lastResponse;
    let lastResponseText = "";
    let lastRequestError = "";
    let lastFailureKind = "";
    let bestPartial = null;
    for (const model of chain) {
      const { response, responseText, requestError, attempts, failureKind } = await callModel(lane, model);
      lastResponse = response;
      lastResponseText = responseText;
      lastRequestError = requestError;
      lastFailureKind = failureKind;
      if (response?.ok && !requestError && failureKind !== "gateway-blocked") {
        try {
          const { review: review2, reasoningLength, reasoningUnit, complete } = extractReview(lane, model, responseText);
          if (review2 && complete) {
            return {
              lane,
              primary,
              servedBy: model,
              review: review2,
              reasoningLength,
              reasoningUnit,
              degraded: model !== primary,
              status: "valid"
            };
          }
          if (review2) {
            bestPartial ??= {
              lane,
              primary,
              servedBy: model,
              review: review2,
              reasoningLength,
              reasoningUnit,
              degraded: model !== primary,
              status: "partial"
            };
            console.log(`[Lane ${lane.id}/${model.id}] response was incomplete; trying the next model in the lane.`);
          } else {
            console.log(`[Lane ${lane.id}/${model.id}] response parsed but contained no review text.`);
          }
        } catch (error) {
          console.log(`[Lane ${lane.id}/${model.id}] parse error: ${error?.message || error}`);
        }
      }
      tried.push(`${model.id} -> HTTP ${response?.status ?? "request failed"} (${attempts ?? 0} attempt(s))`);
      if (model !== chain[chain.length - 1]) {
        console.log(`[Lane ${lane.id}/${primary.id}] falling back to the next model in the lane.`);
      }
    }
    if (bestPartial) return bestPartial;
    const failText = (lastResponseText || lastRequestError || "").trim();
    const gatewayBlocked = lastFailureKind === "gateway-blocked";
    const upstreamExhausted = failText.includes("failover_exhausted");
    const status = lastResponse?.status ?? "request failed";
    const isServerSide = typeof status === "number" && status >= 500;
    const stoppedSummary = `Review attempts did not produce a usable response. Tried: ${tried.join("; ")}.`;
    const fence = "```";
    const snippet = failText.replace(/`/g, "'").slice(0, 600);
    const review = [
      "> AI review was not generated.",
      "",
      gatewayBlocked ? "GitHub Actions reached the configured API endpoint, but the gateway returned an HTML verification page instead of JSON." : stoppedSummary,
      "",
      snippet ? `<details><summary>Upstream response (truncated)</summary>

${fence}
${snippet}
${fence}
</details>` : "",
      "",
      gatewayBlocked ? "Action needed: use an API base URL that GitHub-hosted runners can reach without browser verification, or run this workflow on a self-hosted runner." : lastFailureKind === "quota-exhausted" ? "Action needed: the shared Token Plan quota is exhausted. Wait for its reset or replenish it; retrying another model on the same plan cannot recover the review." : lastFailureKind === "authentication-failed" ? `Action needed: repair Lane ${lane.id} credentials or authentication configuration.` : lastFailureKind === "endpoint-unavailable" ? `Action needed: Lane ${lane.id} endpoint remained unreachable after one attempt per configured model. Models sharing that Lane cannot bypass its network failure.` : upstreamExhausted ? `Action needed: \`failover_exhausted\` means Lane ${lane.id} ran out of healthy upstreams. Inspect its central repository config and provider health; do not add a cross-lane fallback.` : isServerSide ? "Action needed: a 5xx originates from the model gateway/account, not from GitHub access. Check the upstream response above \u2014 most often quota/balance exhausted, an invalid or expired key, a wrong model name, or a provider-side outage." : "Action needed: inspect the upstream response above to identify the request or auth problem."
    ].join("\n");
    return { lane, primary, servedBy: null, review, reasoningLength: 0, degraded: false, status: "diagnostic" };
  }
  const { data: latestPull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  if (latestPull.head.sha !== reviewHeadSha || latestPull.state && latestPull.state !== "open") {
    console.log(`Skip stale review before model dispatch: prepared=${reviewHeadSha.slice(0, 7)} current=${latestPull.head.sha.slice(0, 7)} state=${latestPull.state || "unknown"}.`);
    return;
  }
  const reviewedHeadShortSha = reviewHeadSha.slice(0, 7);
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  let posted = 0;
  let staleReview = false;
  const validLaneIds = new Set(isManualReview ? [] : reusableLaneIds);
  async function reviewAndPublish(lane) {
    const primary = lane.primary;
    const result = await requestReview(lane);
    const { data: publishPull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (publishPull.head.sha !== reviewHeadSha || publishPull.state !== "open") {
      staleReview = true;
      console.log(`Skip stale review before comment publishing: reviewed=${reviewHeadSha.slice(0, 7)} current=${publishPull.head.sha.slice(0, 7)} state=${publishPull.state || "unknown"}.`);
      return;
    }
    const reviewedAt = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const { servedBy, review, reasoningLength, reasoningUnit, degraded, status } = result;
    const modelLine = degraded ? `Lane ${lane.id}: ${primary.id} unavailable -> served by ${servedBy.id}` : `Lane ${lane.id}: ${servedBy?.id ?? primary.id}`;
    const banner = degraded ? [`> \u2139\uFE0F Lane ${lane.id} \u7684 \`${primary.label}\` \u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u672C\u6761 review \u7531\u540C\u901A\u9053\u5907\u7528\u6A21\u578B \`${servedBy.label}\` \u751F\u6210\u3002`, ""] : [];
    const body = [
      `<!-- ai-pr-review-bot:lane-${lane.id} -->`,
      `<!-- ai-pr-review-evidence:v2 lane=${lane.id} head=${reviewHeadSha} workflow=${workflowSha} status=${status} -->`,
      `## AI PR Review \xB7 Lane ${lane.id} \xB7 ${primary.label}`,
      "",
      `> \u5BA1\u6838\u63D0\u4EA4\uFF1A\`${reviewedHeadShortSha}\` \xB7 \u66F4\u65B0\u65F6\u95F4\uFF1A\`${reviewedAt}\` \xB7 \u6B64\u8BC4\u8BBA\u4F1A\u968F PR \u65B0\u63D0\u4EA4\u539F\u5730\u66F4\u65B0 \xB7 [Run](${runUrl})`,
      "",
      ...banner,
      review,
      "",
      `<sub>${modelLine} \xB7 Thinking: ${reasoningUnit ? `${reasoningLength} ${reasoningUnit}` : "not reported"} \xB7 Commit: ${reviewedHeadShortSha} \xB7 [Run](${runUrl})</sub>`
    ].join("\n");
    try {
      const marker = `<!-- ai-pr-review-bot:lane-${lane.id} -->`;
      const priorLaneComments = existingComments.filter((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker));
      const currentComment = priorLaneComments.at(-1);
      let publishedComment;
      if (currentComment) {
        ({ data: publishedComment } = await github.rest.issues.updateComment({
          owner,
          repo,
          comment_id: currentComment.id,
          body
        }));
      } else {
        ({ data: publishedComment } = await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body
        }));
      }
      for (const duplicate of priorLaneComments.slice(0, -1)) {
        try {
          await github.rest.issues.deleteComment({ owner, repo, comment_id: duplicate.id });
        } catch (cleanupError) {
          console.log(`Failed to remove duplicate Lane ${lane.id} comment ${duplicate.id}: ${cleanupError?.message || cleanupError}`);
        }
      }
      posted++;
      if (status === "valid") validLaneIds.add(lane.id);
      console.log(`${currentComment ? "Updated" : "Created"} AI PR Review comment ${publishedComment.id} for Lane ${lane.id} with status=${status}.`);
    } catch (error) {
      console.log(`Failed to post comment for Lane ${lane.id}: ${error?.message || error}`);
    }
  }
  const settled = await Promise.allSettled(lanesToReview.map(reviewAndPublish));
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === "rejected") {
      console.log(`[Lane ${lanesToReview[i].id}] review pipeline threw: ${settled[i].reason?.message || settled[i].reason}`);
    }
  }
  if (staleReview) return;
  if (posted === 0) {
    throw new Error("No AI PR Review comment could be posted for any configured model.");
  }
  const failedAdvisoryLaneIds = lanes.filter((lane) => lane.advisory).map((lane) => lane.id).filter((laneId) => !validLaneIds.has(laneId));
  if (failedAdvisoryLaneIds.length) {
    console.log(`Advisory lane(s) without valid evidence, not gating this run: ${failedAdvisoryLaneIds.map((laneId) => `Lane ${laneId}`).join(", ")}.`);
  }
  const minValidLanes = reviewPolicy.min_valid_lanes;
  if (minValidLanes !== void 0) {
    const validLanes = lanes.filter((lane) => validLaneIds.has(lane.id));
    console.log(`Quorum gate: ${validLanes.length}/${lanes.length} lane(s) published valid evidence, ${minValidLanes} required.`);
    if (validLanes.length < minValidLanes) {
      const missing = lanes.map((lane) => lane.id).filter((laneId) => !validLaneIds.has(laneId));
      throw new Error(`Only ${validLanes.length} of ${lanes.length} lanes produced valid review evidence at head ${reviewHeadSha}; ${minValidLanes} required. Without evidence: ${missing.map((laneId) => `Lane ${laneId}`).join(", ")}.`);
    }
  } else {
    const invalidLaneIds = lanes.filter((lane) => !lane.advisory).map((lane) => lane.id).filter((laneId) => !validLaneIds.has(laneId));
    if (invalidLaneIds.length) {
      throw new Error(`Required review evidence is not valid for ${invalidLaneIds.map((laneId) => `Lane ${laneId}`).join(", ")} at head ${reviewHeadSha}.`);
    }
  }
}
module.exports = { runReview };
