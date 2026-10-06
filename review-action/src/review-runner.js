'use strict';

const { validateConfig } = require('./index.js');
const { packDiff, collectIssues, enrichWorkflows } = require('./review-context.js');
const { PROMPT_VERSION, buildSystemPrompt, parseReview, renderReview } = require('./review-report.js');
const { createStatusPublisher } = require('./review-status.js');

// Runs only from the trusted central checkout. Runtime injection is used by contract tests.
async function runReview({ github, context, env = globalThis.process.env, fetch = globalThis.fetch,
  timers = globalThis, logger = globalThis.console, sdk }) {
  const process = { env };
  const console = logger;
  const { setTimeout, clearTimeout } = timers;
  const pullNumber = context.payload.pull_request?.number ?? context.payload.issue?.number;
  const { owner, repo } = context.repo;
  let reviewConfig;
  try {
    reviewConfig = JSON.parse(process.env.PR_REVIEW_CONFIG || '');
  } catch (error) {
    throw new Error(`Central PR review config is invalid JSON: ${error.message}`);
  }
  validateConfig(reviewConfig, `${owner}/${repo}`);
  const workflowSha = (process.env.PR_REVIEW_WORKFLOW_SHA || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(workflowSha)) {
    throw new Error('The resolved reusable workflow ref must provide the full 40-character ci-central commit SHA.');
  }
  const lanes = reviewConfig.lanes;
  const reviewPolicy = reviewConfig.review_policy;
  const laneCredentials = {
    A: {
      apiKey: process.env.LANE_A_KEY,
      baseUrl: (process.env.LANE_A_API_BASE || '').replace(/\/$/, ''),
    },
    B: {
      apiKey: process.env.LANE_B_KEY,
      baseUrl: (process.env.LANE_B_API_BASE || '').replace(/\/$/, ''),
    },
    C: {
      apiKey: process.env.LANE_C_KEY,
      baseUrl: (process.env.LANE_C_API_BASE || '').replace(/\/$/, ''),
    },
  };
  const { data: pull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  // A newer push may already have superseded this pull_request event before the
  // reusable job starts. Never spend model tokens reviewing a stale commit.
  const eventHeadSha = context.payload.pull_request?.head?.sha;
  const reviewHeadSha = pull.head.sha;
  if (eventHeadSha && eventHeadSha !== reviewHeadSha) {
    console.log(`Skip stale review before context collection: event=${eventHeadSha.slice(0, 7)} current=${reviewHeadSha.slice(0, 7)}.`);
    return;
  }

  // A bot comment is reusable only when its machine-readable evidence proves that
  // this exact Lane completed a valid review for both the current PR head and the
  // current reusable-workflow revision. Legacy, diagnostic, partial, edited, or
  // previous-workflow comments are deliberately not reusable.
  const existingComments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const evidencePattern = /<!-- ai-pr-review-evidence:v2 lane=([A-C]) head=([0-9a-f]{40}) workflow=([0-9a-f]{40}) status=(valid|diagnostic|partial) -->/i;
  const reusableLaneIds = new Set();
  for (const lane of lanes) {
    const stableMarker = `<!-- ai-pr-review-bot:lane-${lane.id} -->`;
    const laneComments = existingComments.filter((comment) =>
      comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(stableMarker + '\n'));
    // Duplicate stable comments are not a trustworthy freeze artifact. Force this
    // Lane to run so the normal publish path keeps the newest comment and removes
    // every older duplicate before evidence can be reused.
    if (laneComments.length !== 1) {
      if (laneComments.length > 1) {
        console.log(`Lane ${lane.id} has ${laneComments.length} stable comments; forcing a rerun to reconcile duplicates.`);
      }
      continue;
    }
    const evidence = evidencePattern.exec(laneComments[0].body || '');
    if (!evidence) continue;
    const [, laneId, headSha, evidenceWorkflowSha, status] = evidence;
    if (laneId.toUpperCase() === lane.id
        && headSha.toLowerCase() === reviewHeadSha.toLowerCase()
        && evidenceWorkflowSha.toLowerCase() === workflowSha
        && status.toLowerCase() === 'valid') {
      reusableLaneIds.add(lane.id);
    }
  }
  const isManualReview = context.eventName === 'issue_comment';
  const lanesToReview = isManualReview
    ? lanes
    : lanes.filter((lane) => !reusableLaneIds.has(lane.id));
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const statusPublisher = createStatusPublisher({ github, owner, repo, pullNumber, head: reviewHeadSha,
    workflow: workflowSha, runUrl, runId: context.runId, lanes, comments: existingComments,
    reusableLaneIds: isManualReview ? new Set() : reusableLaneIds, quorum: reviewPolicy.min_valid_lanes, logger: console });
  if (reusableLaneIds.size) {
    console.log(`Reusable valid review evidence for ${reviewHeadSha.slice(0, 7)}: ${[...reusableLaneIds].sort().map((lane) => `Lane ${lane}`).join(', ')}.`);
  }
  if (lanesToReview.length === 0) {
    const { data: dedupePull } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    if (dedupePull.head.sha !== reviewHeadSha || dedupePull.state !== 'open') {
      console.log(`Skip stale evidence reuse: reviewed=${reviewHeadSha.slice(0, 7)} current=${dedupePull.head.sha.slice(0, 7)} state=${dedupePull.state || 'unknown'}.`);
      return;
    }
    await statusPublisher.publish();
    console.log(`All configured Lanes already have valid review evidence for head ${reviewHeadSha} at workflow ${workflowSha}; skipping model requests.`);
    return;
  }
  if (isManualReview) {
    console.log('Manual /review bypasses same-HEAD evidence reuse and forces every configured Lane to run.');
  }

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const prCommits = await github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 });
  const issues = await collectIssues({ github, owner, repo, pull, commits: prCommits, logger: console });
  const issueContext = issues.text;
  const DIFF_BUDGET = Math.max(4000, Number(reviewPolicy.diff_char_budget) || 100000);
  const material = await enrichWorkflows({ github, owner, repo, head: reviewHeadSha, files, logger: console });
  const diffPack = packDiff(material, DIFF_BUDGET);
  const kimiK3Pack = packDiff(material, 1000);
  const fileList = files.map((file) => `${file.filename} (${file.status}, +${file.additions} -${file.deletions})`).join('\n');
  console.log(`Diff packed: ${diffPack.kept}/${files.length} files, ${diffPack.packedChars}/${DIFF_BUDGET} patch chars, ${diffPack.omitted} omitted; complete omitted hunks=${diffPack.omittedHunks}.`);
  const contextManifest = { prompt_version: PROMPT_VERSION, head: reviewHeadSha, files: diffPack.manifest,
    issues: issues.manifest, omitted_issue_references: issues.omitted_references };
  const system = reviewPolicy.system_prompt;
  const kimiK3System = `${system} Focus on high-confidence, high-impact findings supported by the supplied file inventory and patch sample.`;
  const googleDeepReviewContract = 'Perform two independent internal review passes before writing the final answer: first trace correctness, edge cases, error paths, and contract preservation; then challenge security, architecture boundaries, CI or configuration, and test adequacy. Treat the PR description and passing tests as claims to verify, not proof. Write findings first. Each actionable finding must include severity, exact file or diff-hunk evidence, impact, and a concrete fix. If no actionable finding remains, state the failure paths and invariants you checked plus residual risks. Concise means omit filler and praise, never analysis. Do not invent findings or expose hidden reasoning.';

  const buildUser = (diffText, options = {}) => [
    `Repository: ${owner}/${repo}`,
    `Pull Request: #${pull.number} ${pull.title}`,
    `Author: ${pull.user.login}`,
    `Base: ${pull.base.ref}`,
    `Head: ${pull.head.ref}`,
    '',
    'PR description:',
    (pull.body || '[No description]').slice(0, options.descriptionLimit ?? 4000),
    '',
    (options.issueText ?? issueContext)
      ? `Referenced issues (background — what & why):\n${options.issueText ?? issueContext}`
      : 'Referenced issues: none.',
    '',
    ...(options.fileList ? ['All changed file names:', options.fileList, ''] : []),
    'Coverage manifest (untrusted metadata; omitted material was not inspected):',
    JSON.stringify({ ...contextManifest, files: (options.pack || diffPack).manifest }),
    '',
    'Changed files and patches:',
    diffText || '[No diff available]',
  ].join('\n');
  const user = buildUser(diffPack.text);
  const kimiK3User = buildUser(kimiK3Pack.text, {
    pack: kimiK3Pack,
    descriptionLimit: 2000,
    issueText: issueContext.slice(0, 2000),
    fileList,
  });

  // Model ids are scoped to a lane, never globally. The same model id may be routed
  // through two providers without changing credentials or fallback ownership.
  if (reviewPolicy.max_attempts !== 1) {
    throw new Error('review_policy.max_attempts must be 1; model retries are disabled.');
  }
  // A healthy response with heavy reasoning has been observed beyond 300s. Repository
  // policy supplies defaults while a slow Lane can raise its own request and model
  // windows without changing the others. The model budget remains the hard wall-clock
  // cap for the single request, including reading its complete response body.
  const defaultRequestTimeoutMs = Number(reviewPolicy.request_timeout_ms) || 300000;
  const defaultModelBudgetMs = Number(reviewPolicy.model_budget_ms) || 360000;
  const { requestChatCompletion } = sdk || require('./sdk-client.js');

  // Some upstreams (e.g. MiniMax) inline their chain-of-thought into `content`
  // instead of `reasoning_content`. Never let that reach the PR comment.
  function stripThinking(text) {
    if (!text) return '';
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think>/gi, '')
      .trim();
  }

  function basePayload(model) {
    const throttled = model.context_profile === 'kimi-k3-throttled';
    const messages = [
      { role: 'system', content: buildSystemPrompt(throttled ? kimiK3System : system, model.review_lane_id) },
      { role: 'user', content: throttled ? kimiK3User : user },
    ];
    const payload = {
      model: model.id,
      messages,
      stream: true,
    };
    if (!model.omit_max_tokens) payload.max_tokens = model.max_output_tokens;
    if (Number.isFinite(model.temperature)) payload.temperature = model.temperature;
    return payload;
  }

  function googlePayload(model) {
    const throttled = model.context_profile === 'kimi-k3-throttled';
    const generationConfig = { maxOutputTokens: model.max_output_tokens };
    if (model.thinking_level) {
      generationConfig.thinkingConfig = {
        thinkingLevel: model.thinking_level.toUpperCase(),
      };
    }
    const googleSystem = buildSystemPrompt(`${throttled ? kimiK3System : system}\n\n${googleDeepReviewContract}`, model.review_lane_id);
    return {
      systemInstruction: { parts: [{ text: googleSystem }] },
      contents: [{ role: 'user', parts: [{ text: throttled ? kimiK3User : user }] }],
      generationConfig,
    };
  }

  function responsesPayload(model) {
    const chat = basePayload(model);
    return { model: model.id, input: chat.messages, max_output_tokens: model.max_output_tokens, store: false };
  }

  function classifyFailure(response, responseText, requestError) {
    const status = response?.status;
    const rawText = `${responseText || ''}\n${requestError || ''}`;
    const text = rawText.toLowerCase();
    const quotaExhausted = status === 429 && (
      text.includes('insufficient_quota')
      || /token[- ]?plan[^\n]*quota[^\n]*(exhausted|reached)/i.test(text)
      || /weekly[^\n]*quota[^\n]*(exhausted|reached)/i.test(text)
      || /quota[^\n]*reset at/i.test(text)
    );
    const authenticationFailed = status === 401 || (
      status === 403
      && /(invalid[_ -]?api[_ -]?key|authentication|unauthori[sz]ed)/i.test(text)
    );
    const gatewayBlocked = /^\s*(<!doctype html|<html\b)/i.test(responseText || '')
      || (!response?.ok && text.includes('验证失败'));
    const endpointUnavailable = !response && (
      /fetch failed|enotfound|eai_again|getaddrinfo|econnrefused|certificate|\btls\b/i.test(text)
    );

    if (quotaExhausted) return { kind: 'quota-exhausted' };
    if (authenticationFailed) return { kind: 'authentication-failed' };
    if (gatewayBlocked) return { kind: 'gateway-blocked' };
    if (endpointUnavailable) return { kind: 'endpoint-unavailable' };
    return { kind: 'model-or-upstream-failure' };
  }

  // Exactly one request per model. No retry, backoff, optional-field
  // repair, or redirect can silently send the same review again.
  async function callModel(lane, model) {
    const requestTimeoutMs = model.request_timeout_ms ?? lane.request_timeout_ms ?? defaultRequestTimeoutMs;
    const modelBudgetMs = Number(lane.model_budget_ms) || defaultModelBudgetMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, modelBudgetMs));
    const startedAt = Date.now();
    let response;
    let responseText = '';
    let requestError = '';
    let errorCode = '';
    try {
      const credentials = laneCredentials[lane.id];
      let proxyUrl;
      if (lane.provider === 'opencode-go' && process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
        proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || undefined;
        let proxy;
        try { proxy = new URL(proxyUrl); } catch { /* Reject without exposing credentials. */ }
        if (!proxy || proxy.protocol !== 'http:' || proxy.hostname !== '177.201.224.95' || proxy.port !== '13128'
            || proxy.search || proxy.hash || !['', '/'].includes(proxy.pathname)) {
          throw new Error(`Lane ${lane.id} requires the approved VPS proxy unless explicitly GitHub-hosted; refusing direct fallback.`);
        }
      }
      const isGoogle = lane.protocol === 'google-generate-content';
      response = isGoogle ? await fetch(`${credentials.baseUrl}/models/${encodeURIComponent(model.id)}:generateContent`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': credentials.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'GitHubActions-AI-PR-Review',
        },
        body: JSON.stringify(googlePayload({ ...model, review_lane_id: lane.id })),
      }) : await requestChatCompletion({
        apiKey: credentials.apiKey,
        baseURL: credentials.baseUrl,
        protocol: lane.protocol,
        proxyUrl,
        sessionId: lane.provider === 'opencode-go'
          ? `${owner}-${repo}-pr-${pullNumber}-lane-${lane.id}` : undefined,
        payload: lane.protocol === 'openai-responses' ? responsesPayload({ ...model, review_lane_id: lane.id }) : basePayload({ ...model, review_lane_id: lane.id }),
        signal: controller.signal,
        timeoutMs: Math.min(requestTimeoutMs, modelBudgetMs),
        onProgress: (progress) => console.log(`[Lane ${lane.id}/${model.id}] sdk=${JSON.stringify(progress)}`),
      });
      responseText = await response.text();
    } catch (error) {
      if (Number.isInteger(error?.status)) {
        response = { status: error.status, ok: false };
        responseText = JSON.stringify({ error: { code: error.providerCode, type: error.providerType } });
      }
      const code = error?.cause?.code || error?.code;
      errorCode = typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(code) ? code : '';
      requestError = error?.name === 'AbortError'
        ? 'Local review deadline reached before a complete final response; this is not proof of an upstream outage.'
        : (error?.message || String(error));
    } finally {
      clearTimeout(timeout);
    }
    const failure = classifyFailure(response, responseText, requestError);
    const usable = response?.ok && !requestError && failure.kind !== 'gateway-blocked';
    console.log(`[Lane ${lane.id}/${model.id}] attempt 1/1 elapsed_ms=${Date.now() - startedAt} status=${response?.status ?? 'request failed'} error_code=${errorCode || 'none'}`);
    if (!usable) {
      console.log(`[Lane ${lane.id}/${model.id}] provider=${lane.provider} protocol=${lane.protocol} failed: ${(responseText || requestError || '').slice(0, 1000)}`);
    }
    return { response, responseText, requestError, attempts: 1, failureKind: usable ? '' : failure.kind };
  }

  function validateAndRender(text, model, complete) {
    const supplied = model.context_profile === 'kimi-k3-throttled' ? kimiK3Pack : diffPack;
    if (!complete) return text;
    const report = parseReview(text, supplied);
    return renderReview(report, { ...supplied, issues: issues.manifest });
  }
  function extractReview(lane, model, responseText) {
    const payload = JSON.parse(responseText);
    if (lane.protocol === 'google-generate-content') {
      const candidate = payload?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const content = stripThinking(parts
        .filter((part) => part?.thought !== true)
        .map((part) => part?.text || '')
        .join('\n'));
      const finishReason = candidate?.finishReason;
      const normalizedFinishReason = typeof finishReason === 'string' ? finishReason.toLowerCase() : '';
      const usage = payload?.usageMetadata || {};
      const explicitThoughtTokens = Number(usage.thoughtsTokenCount);
      const derivedThoughtTokens = Number(usage.totalTokenCount)
        - Number(usage.promptTokenCount)
        - Number(usage.candidatesTokenCount);
      const hasExplicitThoughtTokens = Number.isFinite(explicitThoughtTokens);
      const hasDerivedThoughtTokens = Number.isFinite(derivedThoughtTokens) && derivedThoughtTokens >= 0;
      const reasoningLength = hasExplicitThoughtTokens
        ? explicitThoughtTokens
        : (hasDerivedThoughtTokens ? derivedThoughtTokens : 0);
      const reasoningUnit = hasExplicitThoughtTokens || hasDerivedThoughtTokens ? 'tokens' : null;
      console.log(`[Lane ${lane.id}/${model.id}] api=generateContent finish_reason=${finishReason} contentLen=${content.length} thoughtTokens=${reasoningUnit ? reasoningLength : 'not-reported'} usage=${JSON.stringify(usage)}`);
      let review = content;
      if (review && normalizedFinishReason && normalizedFinishReason !== 'stop') {
        review += '\n\n> ⚠️ 模型输出未完整结束，这条 review 可能不完整。';
      }
      const complete = normalizedFinishReason === 'stop';
      return { review: review ? validateAndRender(review, model, complete) : '', reasoningLength, reasoningUnit, complete };
    }
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const finishReason = choice?.finish_reason;
    const normalizedFinishReason = typeof finishReason === 'string' ? finishReason.toLowerCase() : '';
    const reasoning = message?.reasoning_content || '';
    const reasoningLength = Number.isFinite(payload?.reasoning_chars) ? payload.reasoning_chars : reasoning.length;
    const content = stripThinking(message?.content);
    // Never publish provider reasoning as a review. An empty final response makes
    // the caller continue to its configured fallback instead.
    let review = content;
    console.log(`[Lane ${lane.id}/${model.id}] api=chat/completions upstream=${payload?.model} finish_reason=${finishReason} contentLen=${message?.content?.length || 0} reasoningLen=${reasoningLength} usage=${JSON.stringify(payload?.usage)}`);
    if (review && normalizedFinishReason === 'length') {
      review += '\n\n> ⚠️ 模型输出达到 max_tokens 上限，这条 review 可能不完整。';
    }
    const complete = !normalizedFinishReason || normalizedFinishReason === 'stop';
    return { review: review ? validateAndRender(review, model, complete) : '', reasoningLength,
      reasoningUnit: reasoningLength ? 'chars' : null, complete };
  }

  // Primary once, then the same-lane fallback once on failure; never retry either.
  async function requestReview(lane) {
    const primary = lane.primary;
    const chain = [primary, ...lane.fallbacks];
    const credentials = laneCredentials[lane.id];
    if (!diffPack.coverage.some(file => file.patch_available && file.supplied_hunks)) {
      return { lane, primary, servedBy: null, reasoningLength: 0, degraded: false, status: 'diagnostic',
        review: '> AI review was not generated.\n\nNo complete inspectable text patch was supplied. No model request was sent; binary, unavailable or omitted patches cannot establish review evidence.' };
    }
    if (!credentials?.apiKey || !credentials?.baseUrl) {
      console.log(`[Lane ${lane.id}] fixed credential slots are not available; skipping model requests for this lane.`);
      return {
        lane,
        primary,
        servedBy: null,
        reasoningLength: 0,
        degraded: false,
        status: 'diagnostic',
        review: [
          '> AI review was not generated.',
          '',
          `Lane ${lane.id} is not provisioned.`,
          '',
          `Action needed: set PR_AGENT_LANE_${lane.id}_KEY and PR_AGENT_LANE_${lane.id}_API_BASE in the caller repository.`,
        ].join('\n'),
      };
    }
    const tried = [];
    let lastResponse;
    let lastResponseText = '';
    let lastRequestError = '';
    let lastFailureKind = '';
    let bestPartial = null;

    for (const model of chain) {
      if (model !== primary) await statusPublisher.update(lane.id, 'fallback', model.id);
      const { response, responseText, requestError, attempts, failureKind } = await callModel(lane, model);
      lastResponse = response;
      lastResponseText = responseText;
      lastRequestError = requestError;
      lastFailureKind = failureKind;
      if (response?.ok && !requestError && failureKind !== 'gateway-blocked') {
        try {
          const { review, reasoningLength, reasoningUnit, complete } = extractReview(lane, model, responseText);
          if (review && complete) {
            return {
              lane,
              primary,
              servedBy: model,
              review,
              reasoningLength,
              reasoningUnit,
              degraded: model !== primary,
              status: 'valid',
            };
          }
          if (review) {
            bestPartial ??= {
              lane,
              primary,
              servedBy: model,
              review,
              reasoningLength,
              reasoningUnit,
              degraded: model !== primary,
              status: 'partial',
            };
            console.log(`[Lane ${lane.id}/${model.id}] response was incomplete; trying the next model in the lane.`);
          } else {
            console.log(`[Lane ${lane.id}/${model.id}] response parsed but contained no review text.`);
          }
        } catch (error) {
          lastFailureKind = 'report-invalid';
          console.log(`[Lane ${lane.id}/${model.id}] report rejected: ${error?.message?.startsWith('Review contract:') ? error.message : 'invalid report envelope'}`);
        }
      }
      tried.push(`${model.id} -> ${lastFailureKind === 'report-invalid' ? 'evidence contract rejected' : `HTTP ${response?.status ?? 'request failed'}`} (${attempts ?? 0} attempt(s))`);
      if (model !== chain[chain.length - 1]) {
        console.log(`[Lane ${lane.id}/${primary.id}] falling back to the next model in the lane.`);
      }
    }

    if (bestPartial) return bestPartial;

    const failText = lastFailureKind === 'report-invalid'
      ? 'The model returned a response, but its report did not satisfy the evidence contract.'
      : (lastResponseText || lastRequestError || '').trim();
    const gatewayBlocked = lastFailureKind === 'gateway-blocked';
    const upstreamExhausted = failText.includes('failover_exhausted');
    const status = lastResponse?.status ?? 'request failed';
    const isServerSide = typeof status === 'number' && status >= 500;
    const stoppedSummary = `Review attempts did not produce a usable response. Tried: ${tried.join('; ')}.`;
    const fence = '```';
    const snippet = failText.replace(/`/g, "'").slice(0, 600);
    const review = [
      '> AI review was not generated.',
      '',
      gatewayBlocked
        ? 'GitHub Actions reached the configured API endpoint, but the gateway returned an HTML verification page instead of JSON.'
        : stoppedSummary,
      '',
      snippet
        ? `<details><summary>Upstream response (truncated)</summary>\n\n${fence}\n${snippet}\n${fence}\n</details>`
        : '',
      '',
      gatewayBlocked
        ? 'Action needed: use an API base URL that GitHub-hosted runners can reach without browser verification, or run this workflow on a self-hosted runner.'
        : lastFailureKind === 'quota-exhausted'
          ? 'Action needed: the shared Token Plan quota is exhausted. Wait for its reset or replenish it; retrying another model on the same plan cannot recover the review.'
          : lastFailureKind === 'authentication-failed'
            ? `Action needed: repair Lane ${lane.id} credentials or authentication configuration.`
            : lastFailureKind === 'endpoint-unavailable'
              ? `Action needed: Lane ${lane.id} endpoint remained unreachable after one attempt per configured model. Models sharing that Lane cannot bypass its network failure.`
        : upstreamExhausted
          ? `Action needed: \`failover_exhausted\` means Lane ${lane.id} ran out of healthy upstreams. Inspect its central repository config and provider health; do not add a cross-lane fallback.`
          : isServerSide
            ? 'Action needed: a 5xx originates from the model gateway/account, not from GitHub access. Check the upstream response above — most often quota/balance exhausted, an invalid or expired key, a wrong model name, or a provider-side outage.'
            : 'Action needed: inspect the upstream response above to identify the request or auth problem.',
    ].join('\n');

    return { lane, primary, servedBy: null, review, reasoningLength: 0, degraded: false, status: 'diagnostic' };
  }

  // Context collection can take long enough for another push to land. Re-read the
  // head immediately before dispatch so neither full-context reviewer spends tokens
  // on a commit that is no longer current.
  await statusPublisher.publish();
  const { data: latestPull } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  if (latestPull.head.sha !== reviewHeadSha || (latestPull.state && latestPull.state !== 'open')) {
    console.log(`Skip stale review before model dispatch: prepared=${reviewHeadSha.slice(0, 7)} current=${latestPull.head.sha.slice(0, 7)} state=${latestPull.state || 'unknown'}.`);
    return;
  }

  const reviewedHeadShortSha = reviewHeadSha.slice(0, 7);
  let posted = 0;
  let staleReview = false;
  const validLaneIds = new Set(isManualReview ? [] : reusableLaneIds);
  async function reviewAndPublish(lane) {
    const primary = lane.primary;
    const result = await requestReview(lane);
    // Each lane validates freshness immediately before its own publication.
    // A slow lane must never delay an already-completed review.
    const { data: publishPull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    if (publishPull.head.sha !== reviewHeadSha || publishPull.state !== 'open') {
      staleReview = true;
      console.log(`Skip stale review before comment publishing: reviewed=${reviewHeadSha.slice(0, 7)} current=${publishPull.head.sha.slice(0, 7)} state=${publishPull.state || 'unknown'}.`);
      return;
    }
    const reviewedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const { servedBy, review, reasoningLength, reasoningUnit, degraded, status } = result;
    const modelLine = degraded
      ? `Lane ${lane.id}: ${primary.id} unavailable -> served by ${servedBy.id}`
      : `Lane ${lane.id}: ${servedBy?.id ?? primary.id}`;
    const banner = degraded
      ? [`> ℹ️ Lane ${lane.id} 的 \`${primary.label}\` 未产生可用审核，本条 review 由同通道备用模型 \`${servedBy.label}\` 生成。`, '']
      : [];
    const body = [
      `<!-- ai-pr-review-bot:lane-${lane.id} -->`,
      `<!-- ai-pr-review-evidence:v2 lane=${lane.id} head=${reviewHeadSha} workflow=${workflowSha} status=${status} -->`,
      `## AI PR Review · Lane ${lane.id} · ${servedBy?.label ?? primary.label}`,
      '',
      `> 审核提交：\`${reviewedHeadShortSha}\` · 更新时间：\`${reviewedAt}\` · 此评论会随 PR 新提交原地更新 · [Run](${runUrl})`,
      '',
      ...banner,
      review,
      '',
      `<sub>${modelLine} · Thinking: ${reasoningUnit ? `${reasoningLength} ${reasoningUnit}` : 'not reported'} · Commit: ${reviewedHeadShortSha} · [Run](${runUrl})</sub>`,
    ].join('\n');
    try {
      const marker = `<!-- ai-pr-review-bot:lane-${lane.id} -->`;
      const priorLaneComments = existingComments.filter((comment) =>
        comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(marker + '\n'));
      const currentComment = priorLaneComments.at(-1);
      let publishedComment;
      if (currentComment) {
        ({ data: publishedComment } = await github.rest.issues.updateComment({
          owner,
          repo,
          comment_id: currentComment.id,
          body,
        }));
      } else {
        ({ data: publishedComment } = await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body,
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
      if (status === 'valid') validLaneIds.add(lane.id);
      await statusPublisher.update(lane.id, status === 'valid' ? 'complete' : status === 'partial' ? 'partial' : 'failed', servedBy?.id);
      console.log(`${currentComment ? 'Updated' : 'Created'} AI PR Review comment ${publishedComment.id} for Lane ${lane.id} with status=${status}.`);
    } catch (error) {
      // One failed comment must not swallow the others.
      console.log(`Failed to post comment for Lane ${lane.id}.`);
      await statusPublisher.update(lane.id, 'publication_failed', servedBy?.id);
    }
  }
  const settled = await Promise.allSettled(lanesToReview.map(reviewAndPublish));
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'rejected') {
      console.log(`[Lane ${lanesToReview[i].id}] review pipeline threw.`);
      await statusPublisher.update(lanesToReview[i].id, 'failed');
    }
  }
  if (staleReview) return;
  if (posted === 0) {
    throw new Error('No AI PR Review comment could be posted for any configured model.');
  }
  // An advisory lane still publishes its comment and its diagnostics, but a
  // best-effort upstream (a free quota that runs dry, say) must not turn the whole
  // review red - that trains reviewers to ignore a permanently failing check.
  const failedAdvisoryLaneIds = lanes
    .filter((lane) => lane.advisory)
    .map((lane) => lane.id)
    .filter((laneId) => !validLaneIds.has(laneId));
  if (failedAdvisoryLaneIds.length) {
    console.log(`Advisory lane(s) without valid evidence, not gating this run: ${failedAdvisoryLaneIds.map((laneId) => `Lane ${laneId}`).join(', ')}.`);
  }
  // Two ways to decide whether enough review landed.
  //
  // `min_valid_lanes` counts how many independent reviews arrived, without
  // caring which lanes produced them. Lanes exist to be redundant, and naming
  // specific ones as required spends that redundancy: with two required lanes
  // the review is available only when both providers are, so the run is red
  // whenever either one is out of quota - a state that lasts until the quota
  // resets, not a blip. Measured over six consecutive NebulaLab failures, four
  // were one lane short while two others had published a full review.
  //
  // Counting does not lower the bar. A repository that required Lane A and
  // Lane B needed two reviews before and needs two now; the gate simply stops
  // insisting on which two. With three lanes, reaching two also guarantees at
  // least one of the two heavyweight lanes, because the third cannot make a
  // quorum on its own.
  //
  // Without the field, the original rule stands: every non-advisory lane must
  // have valid evidence. Repositories that have not opted in are unaffected.
  const minValidLanes = reviewPolicy.min_valid_lanes;
  if (minValidLanes !== undefined) {
    const validLanes = lanes.filter((lane) => validLaneIds.has(lane.id));
    console.log(`Quorum gate: ${validLanes.length}/${lanes.length} lane(s) published valid evidence, ${minValidLanes} required.`);
    if (validLanes.length < minValidLanes) {
      const missing = lanes
        .map((lane) => lane.id)
        .filter((laneId) => !validLaneIds.has(laneId));
      throw new Error(`Only ${validLanes.length} of ${lanes.length} lanes produced valid review evidence at head ${reviewHeadSha}; ${minValidLanes} required. Without evidence: ${missing.map((laneId) => `Lane ${laneId}`).join(', ')}.`);
    }
  } else {
    const invalidLaneIds = lanes
      .filter((lane) => !lane.advisory)
      .map((lane) => lane.id)
      .filter((laneId) => !validLaneIds.has(laneId));
    if (invalidLaneIds.length) {
      throw new Error(`Required review evidence is not valid for ${invalidLaneIds.map((laneId) => `Lane ${laneId}`).join(', ')} at head ${reviewHeadSha}.`);
    }
  }
}

module.exports = { runReview };
