#!/usr/bin/env node
// Executes the real inline workflow script against mocked GitHub and HTTP APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-review.yml'), 'utf8').split('\n');
const workflowText = raw.join('\n');
const start = raw.findIndex((line) => line.trim() === 'script: |');
if (start < 0) throw new Error('script block not found');
const lines = [];
for (let i = start + 1; i < raw.length; i++) {
  if (raw[i].trim() !== '' && !raw[i].startsWith(' '.repeat(12))) break;
  lines.push(raw[i].slice(12));
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = new AsyncFunction('github', 'context', 'process', 'fetch', 'setTimeout', 'clearTimeout', 'console', lines.join('\n'));

const patch = (filename, size) => ({ filename, status: 'modified', additions: 2, deletions: 1, patch: `@@\n${'+x\n'.repeat(size)}` });
const files = [patch('src/a.ts', 100), patch('tests/a.test.ts', 100)];
const pull = { number: 42, title: 'Test', state: 'open', user: { login: 'octocat' }, base: { ref: 'main' }, head: { ref: 'feature', sha: 'deadbeef' }, body: '' };
const context = { payload: { pull_request: { number: 42, head: { sha: 'deadbeef' } } }, repo: { owner: 'TshyGO', repo: 'Example' }, serverUrl: 'https://github.com', runId: 1 };
const env = {
  OPENAI_API_KEY: 'test-key', OPENAI_API_BASE: 'https://example.test/v1/', GOOGLE_AI_API_KEY: 'google-test-key',
  TENCENT_API_KEY: 'tencent-test-key', TENCENT_API_BASE: 'https://tencent.example.test/plan/v3/',
  PR_REVIEW_MODELS: 'glm-5.2,gemini-3.7-flash',
  PR_REVIEW_MODEL_LABELS: '{"glm-5.2":"GLM-5.2","qwen3.8-max":"Qwen3.8-Max","gemini-3.7-flash":"Gemini-3.7-Flash"}',
  PR_REVIEW_FALLBACKS: '{"glm-5.2":["qwen3.8-max"]}',
  PR_REVIEW_MODEL_PROVIDERS: '{"glm-5.2":"alibaba","qwen3.8-max":"alibaba","gemini-3.7-flash":"google"}',
  PR_REVIEW_DIFF_BUDGET: '100000',
};
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });
const result = (model, content, { reasoning = 'private thinking', finish = 'stop' } = {}) => JSON.stringify({
  model: `provider/${model}`,
  choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning } }],
  usage: { prompt_tokens: 1 },
});
const geminiResult = (content, { finish = 'STOP', thought = '' } = {}) => JSON.stringify({
  candidates: [{ finishReason: finish, content: { parts: [
    ...(thought ? [{ thought: true, text: thought }] : []),
    { text: content },
  ] } }],
  usageMetadata: { promptTokenCount: 1 },
});

async function scenario(route, overrides = {}, options = {}) {
  const posted = [], captured = [], urls = [], logs = [];
  const pulls = options.pulls || [pull];
  let pullGets = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: pulls[Math.min(pullGets++, pulls.length - 1)] }),
        listFiles: 'files',
        listCommits: 'commits',
      },
      issues: { get: async () => { throw new Error('not found'); }, createComment: async ({ body }) => { posted.push(body); return { data: {} }; } },
    },
    paginate: async (which) => which === 'files' ? files : [{ commit: { message: 'test' } }],
  };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const model = url.includes('generativelanguage.googleapis.com') ? 'gemini-3.7-flash' : body.model;
    captured.push({ model, body, headers: options.headers }); urls.push(url);
    return route(model, body);
  };
  let error;
  try { await runScript(github, options.context || context, { env: { ...env, ...overrides } }, fetch, (fn) => setTimeout(fn, 0), clearTimeout, { log: (...xs) => logs.push(xs.join(' ')) }); }
  catch (e) { error = e; }
  return { posted, captured, urls, logs, error, pullGets };
}

const checks = [];
const check = (name, condition) => { checks.push(condition); console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`); };

check(
  'workflow defaults contain one Alibaba primary, one fallback, and independent Gemini',
  workflowText.includes('default: "glm-5.2,gemini-3.7-flash"')
    && workflowText.includes('default: \'{"glm-5.2":["qwen3.8-max"]}\'')
    && !workflowText.includes('deepseek-v4-pro'),
);
check('reusable job centrally cancels superseded automatic reviews', workflowText.includes('group: centralized-ai-pr-review-${{ github.repository }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.issue.number }}')
  && workflowText.includes('cancel-in-progress: true'));

let r = await scenario((model) => reply(200, model === 'gemini-3.7-flash' ? geminiResult(`# review ${model}`, { thought: 'PRIVATE GEMINI THOUGHT' }) : result(model, `# review ${model}`)));
check('healthy default calls GLM and independent Gemini', r.captured.map((x) => x.model).sort().join(',') === 'gemini-3.7-flash,glm-5.2');
check('Model Studio models use standard chat completions', r.urls.filter((url) => !url.includes('generativelanguage.googleapis.com')).every((url) => url.endsWith('/chat/completions')));
const studioBodies = r.captured.filter((x) => x.model !== 'gemini-3.7-flash').map((x) => x.body);
check('Model Studio payload contract is uniform', studioBodies.every((body) => body.messages?.length === 2 && body.stream === false && body.max_tokens === 16384 && body.temperature === 0.2));
check('healthy default posts one Alibaba comment and one Gemini comment', r.posted.length === 2
  && r.posted.filter((body) => body.includes('<!-- ai-pr-review-bot:glm-5.2 -->')).length === 1
  && r.posted.filter((body) => body.includes('<!-- ai-pr-review-bot:gemini-3.7-flash -->')).length === 1);
check('reasoning never reaches a PR comment', !r.posted.some((body) => body.includes('private thinking')));
check('Gemini thought parts never reach a PR comment', !r.posted.some((body) => body.includes('PRIVATE GEMINI THOUGHT')));
check('healthy default uses GLM and Gemini labels', r.posted.some((body) => body.includes('GLM-5.2')) && r.posted.some((body) => body.includes('Gemini-3.7-Flash')));
check('full review context and output budgets remain unchanged', studioBodies.every((body) => body.messages[1].content.includes('Changed files and patches:'))
  && workflowText.includes('default: 100000')
  && workflowText.includes('maxOutputTokens: 16384'));
check('prompt asks reasoning models to preserve a final review', studioBodies.every((body) => body.messages[0].content.includes('reserve enough output budget for the final Markdown review')));

r = await scenario((model) => model === 'glm-5.2'
  ? reply(503, '{"error":"unavailable"}')
  : reply(200, model === 'gemini-3.7-flash' ? geminiResult(`# review ${model}`) : result(model, `# review ${model}`)));
check('transient primary failure retries three times', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 3);
check('Qwen is used only after GLM fails', r.captured.filter((entry) => entry.model === 'qwen3.8-max').length === 1 && !r.captured.some((entry) => entry.model === 'deepseek-v4-pro'));
check('fallback review is marked as degraded', r.posted.some((body) => body.includes('glm-5.2 unavailable -> served by qwen3.8-max')));
check('Alibaba fallback still posts one lane comment beside Gemini', r.posted.length === 2
  && r.posted.filter((body) => body.includes('<!-- ai-pr-review-bot:glm-5.2 -->')).length === 1
  && r.posted.filter((body) => body.includes('<!-- ai-pr-review-bot:gemini-3.7-flash -->')).length === 1);

r = await scenario((model) => ['glm-5.2', 'qwen3.8-max'].includes(model)
  ? reply(503, '{"error":"unavailable"}')
  : reply(200, model === 'gemini-3.7-flash' ? geminiResult(`# review ${model}`) : result(model, `# review ${model}`)));
check('a model-specific outage still exhausts GLM and Qwen before diagnosing the lane', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 3
  && r.captured.filter((entry) => entry.model === 'qwen3.8-max').length === 3);
check('failed Alibaba lane does not replace independent Gemini', r.posted.length === 2
  && r.posted.some((body) => body.includes('AI review was not generated'))
  && r.posted.some((body) => body.includes('<!-- ai-pr-review-bot:gemini-3.7-flash -->')));

r = await scenario((model) => model === 'glm-5.2'
  ? reply(429, '{"error":{"code":"insufficient_quota","message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 08-18 15:16:00 UTC."}}')
  : reply(200, geminiResult('# Gemini review')));
check('plan-wide quota exhaustion is attempted only once', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 1);
check('plan-wide quota exhaustion skips same-plan Qwen fallback', !r.captured.some((entry) => entry.model === 'qwen3.8-max')
  && r.logs.some((line) => line.includes('quota-exhausted') && line.includes('skipping same-provider fallback')));
check('quota failure still preserves independent Gemini review', r.posted.length === 2
  && r.posted.some((body) => body.includes('# Gemini review'))
  && r.posted.some((body) => body.includes('shared Token Plan quota is exhausted')));

r = await scenario((model) => {
  if (model === 'glm-5.2') throw new Error('fetch failed');
  return reply(200, geminiResult('# Gemini review'));
});
check('shared endpoint fetch failure retries GLM but does not duplicate context to Qwen', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 3
  && !r.captured.some((entry) => entry.model === 'qwen3.8-max'));
check('shared endpoint failure is explained in the diagnostic', r.posted.some((body) => body.includes('endpoint remained unreachable')));

r = await scenario((model) => model === 'glm-5.2'
  ? reply(200, '<!DOCTYPE html><html><body>verification required</body></html>')
  : reply(200, geminiResult('# Gemini review')));
check('HTML verification response stops the shared lane even when HTTP status is 200', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 1
  && !r.captured.some((entry) => entry.model === 'qwen3.8-max')
  && r.posted.some((body) => body.includes('HTML verification page')));

r = await scenario((model) => model === 'glm-5.2'
  ? reply(429, '{"error":{"code":"rate_limit_exceeded","message":"short model rate limit"}}')
  : reply(200, model === 'gemini-3.7-flash' ? geminiResult('# Gemini review') : result(model, '# Qwen review')));
check('ordinary model rate limit still retries and falls back for review availability', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 3
  && r.captured.filter((entry) => entry.model === 'qwen3.8-max').length === 1
  && r.posted.some((body) => body.includes('# Qwen review')));

r = await scenario((model, body) => model === 'glm-5.2'
  ? reply(503, '{"error":"unavailable"}')
  : model === 'qwen3.8-max' && 'temperature' in body
    ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'temperature\'"}}')
    : reply(200, model === 'gemini-3.7-flash' ? geminiResult('# review') : result(model, '# review')));
const qwenAttempts = r.captured.filter((entry) => entry.model === 'qwen3.8-max').map((entry) => entry.body);
check('optional-field rejection retries without the field', qwenAttempts.length === 2 && !('temperature' in qwenAttempts[1]));

r = await scenario((model) => reply(200, model === 'gemini-3.7-flash'
  ? geminiResult('# review')
  : result(model, model === 'glm-5.2' ? '' : '# review')));
check('empty final content does not publish reasoning', !r.posted.some((body) => body.includes('private thinking')));
check('empty primary content moves forward to Qwen', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 1
  && r.captured.filter((entry) => entry.model === 'qwen3.8-max').length === 1
  && r.posted.some((body) => body.includes('glm-5.2 unavailable -> served by qwen3.8-max')));

const newerPull = { ...pull, head: { ...pull.head, sha: 'cafebabe' } };
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [newerPull] });
check('event already superseded before startup makes zero model calls', r.captured.length === 0 && r.pullGets === 1
  && r.logs.some((line) => line.includes('Skip stale review before context collection')));

r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [pull, newerPull] });
check('head changed during context collection makes zero model calls', r.captured.length === 0 && r.pullGets === 2
  && r.logs.some((line) => line.includes('Skip stale review before model dispatch')));

r = await scenario((model) => reply(200, model === 'gemini-3.7-flash' ? geminiResult('# review') : result(model, '# review')), {}, { pulls: [pull, pull, newerPull] });
check('head changed during model execution publishes no stale comments', r.captured.length === 2 && r.posted.length === 0 && r.pullGets === 3
  && r.logs.some((line) => line.includes('Skip stale review before comment publishing')));

const manualContext = { ...context, payload: { issue: { number: 42 } }, sha: 'defaultbranch' };
r = await scenario((model) => reply(200, model === 'gemini-3.7-flash' ? geminiResult('# review') : result(model, '# review')), {}, { context: manualContext });
check('manual review comments report the PR head instead of the default branch SHA', r.posted.length === 2
  && r.posted.every((body) => body.includes('Commit: deadbee')));

r = await scenario((model) => reply(200, result(model, '# review')), {
  PR_REVIEW_MODELS: 'glm-5.2,qwen3.8-max',
});
check('a configured primary cannot also be a fallback', /cannot run in parallel and also serve as a fallback/.test(r.error?.message || '') && r.captured.length === 0);

r = await scenario((model) => reply(200, result(model, '# review')), {
  PR_REVIEW_MODELS: 'qwen3.8-max',
});
check('an unused fallback chain does not block an explicit primary override', r.error === undefined
  && r.captured.length === 1 && r.captured[0].model === 'qwen3.8-max' && r.posted.length === 1);

r = await scenario((model) => reply(200, geminiResult('', { finish: 'MAX_TOKENS' })), {
  PR_REVIEW_MODELS: 'gemini-3.7-flash', PR_REVIEW_FALLBACKS: '{}',
});
check('Gemini empty output posts a diagnostic rather than leaking hidden data', r.posted.some((body) => body.includes('gemini-3.7-flash') && body.includes('AI review was not generated')) && !r.posted.some((body) => body.includes('private thinking')));

r = await scenario((model) => reply(200, geminiResult('# partial', { finish: 'MAX_TOKENS' })), {
  PR_REVIEW_MODELS: 'gemini-3.7-flash', PR_REVIEW_FALLBACKS: '{}',
});
check('Gemini non-STOP output is marked incomplete', r.posted.some((body) => body.includes('# partial') && body.includes('模型输出未完整结束')));

r = await scenario((model) => reply(200, geminiResult('# review')), {
  PR_REVIEW_MODELS: 'gemini-3.7-flash', PR_REVIEW_FALLBACKS: '{}', GOOGLE_AI_API_KEY: '',
});
check('Gemini requires its separate secret', /PR_AGENT_GOOGLE_AI_KEY is required/.test(r.error?.message || ''));

r = await scenario((model) => reply(200, geminiResult('# Gemini-only review')), {
  PR_REVIEW_MODELS: 'gemini-3.7-flash', PR_REVIEW_FALLBACKS: '{}', OPENAI_API_KEY: '', OPENAI_API_BASE: '',
});
check('Gemini-only configuration does not require Model Studio credentials', r.error === undefined && r.posted.length === 1 && r.posted[0].includes('# Gemini-only review'));
const geminiCall = r.captured.find((x) => x.model === 'gemini-3.7-flash');
check('explicit Gemini uses generateContent and its native payload', geminiCall && r.urls.find((url) => url.includes('generativelanguage.googleapis.com')).endsWith('/models/gemini-3.7-flash:generateContent') && geminiCall.body.systemInstruction?.parts?.length === 1 && geminiCall.body.contents?.[0]?.parts?.length === 1 && geminiCall.body.generationConfig?.maxOutputTokens === 16384 && !('temperature' in geminiCall.body.generationConfig) && geminiCall.headers['x-goog-api-key'] === 'google-test-key');

const providerOverrides = {
  PR_REVIEW_MODELS: 'qwen3.8-max,glm-5.2',
  PR_REVIEW_MODEL_LABELS: '{"qwen3.8-max":"Qwen3.8-Max","kimi-k3":"Kimi-K3","glm-5.2":"GLM-5.2","deepseek/deepseek-v4-pro":"DeepSeek-V4-Pro"}',
  PR_REVIEW_FALLBACKS: '{"qwen3.8-max":["kimi-k3"],"glm-5.2":["deepseek/deepseek-v4-pro"]}',
  PR_REVIEW_MODEL_PROVIDERS: '{"qwen3.8-max":"alibaba","kimi-k3":"alibaba","glm-5.2":"tencent","deepseek/deepseek-v4-pro":"tencent"}',
};
r = await scenario((model) => reply(200, result(model, `# review ${model}`)), providerOverrides);
check('independent Alibaba and Tencent primaries use their own endpoints and credentials',
  r.captured.length === 2
    && r.urls.includes('https://example.test/v1/chat/completions')
    && r.urls.includes('https://tencent.example.test/plan/v3/chat/completions')
    && r.captured.find((x) => x.model === 'qwen3.8-max')?.headers.authorization === 'Bearer test-key'
    && r.captured.find((x) => x.model === 'glm-5.2')?.headers.authorization === 'Bearer tencent-test-key');

r = await scenario((model) => ['qwen3.8-max', 'glm-5.2'].includes(model)
  ? reply(503, '{"error":"unavailable"}')
  : reply(200, result(model, `# review ${model}`)), providerOverrides);
check('each provider falls back only inside its own lane',
  r.captured.some((x) => x.model === 'kimi-k3')
    && r.captured.some((x) => x.model === 'deepseek/deepseek-v4-pro')
    && r.posted.some((body) => body.includes('qwen3.8-max unavailable -> served by kimi-k3'))
    && r.posted.some((body) => body.includes('glm-5.2 unavailable -> served by deepseek/deepseek-v4-pro')));
const kimiRequest = r.captured.find((x) => x.model === 'kimi-k3')?.body;
check('Kimi K3 fallback uses its bounded prompt and fixed sampling contract',
  kimiRequest?.max_tokens === 8192
    && !('temperature' in kimiRequest)
    && kimiRequest.messages?.[1]?.content.includes('All changed file names:'));

r = await scenario((model) => reply(200, result(model, '# review')), {
  ...providerOverrides,
  PR_REVIEW_FALLBACKS: '{"qwen3.8-max":["deepseek/deepseek-v4-pro"]}',
});
check('cross-provider fallback configuration is rejected before model calls',
  /crosses providers/.test(r.error?.message || '') && r.captured.length === 0);

r = await scenario((model) => reply(200, result(model, '# review')), {
  ...providerOverrides,
  TENCENT_API_KEY: '',
});
check('Tencent lanes require their dedicated caller secret',
  /PR_AGENT_TENCENT_KEY/.test(r.error?.message || '') && r.captured.length === 0);

if (checks.some((x) => !x)) process.exitCode = 1;
