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

const centralConfig = JSON.parse(fs.readFileSync(path.join(here, '..', 'review-action', 'config', 'repositories', 'TshyGO__NebulaLab.json'), 'utf8'));
const patch = (filename, size) => ({ filename, status: 'modified', additions: 2, deletions: 1, patch: `@@\n${'+x\n'.repeat(size)}` });
const files = [patch('src/a.ts', 100), patch('tests/a.test.ts', 100)];
const pull = { number: 42, title: 'Test', state: 'open', user: { login: 'octocat' }, base: { ref: 'main' }, head: { ref: 'feature', sha: 'deadbeef' }, body: '' };
const context = { payload: { pull_request: { number: 42, head: { sha: 'deadbeef' } } }, repo: { owner: 'TshyGO', repo: 'NebulaLab' }, serverUrl: 'https://github.com', runId: 1 };
const env = {
  LANE_A_KEY: 'lane-a-key', LANE_A_API_BASE: 'https://lane-a.example.test/v1/',
  LANE_B_KEY: 'lane-b-key', LANE_B_API_BASE: 'https://lane-b.example.test/v1/',
  LANE_C_KEY: 'lane-c-key', LANE_C_API_BASE: 'https://lane-c.example.test/v1beta/',
  PR_REVIEW_CONFIG: JSON.stringify(centralConfig),
};
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });
const chatResult = (model, content, { reasoning = 'private thinking', finish = 'stop' } = {}) => JSON.stringify({
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

function laneForUrl(url) {
  if (url.startsWith('https://lane-a.')) return 'A';
  if (url.startsWith('https://lane-b.')) return 'B';
  if (url.startsWith('https://lane-c.')) return 'C';
  if (url.startsWith('https://generativelanguage.googleapis.com/')) return 'C';
  return '?';
}

async function scenario(route, overrides = {}, options = {}) {
  const posted = [], captured = [], logs = [];
  const comments = (options.comments || []).map((comment, index) => ({
    id: index + 1,
    user: { login: 'github-actions[bot]' },
    ...comment,
  }));
  const pulls = options.pulls || [pull];
  let pullGets = 0;
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pulls[Math.min(pullGets++, pulls.length - 1)] }), listFiles: 'files', listCommits: 'commits' },
      issues: {
        get: async () => { throw new Error('not found'); },
        listComments: 'comments',
        createComment: async ({ body }) => {
          if (options.rejectComment?.(body)) throw new Error('comment rejected');
          posted.push(body);
          const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body };
          comments.push(comment);
          return { data: comment };
        },
        updateComment: async ({ comment_id, body }) => {
          if (options.rejectComment?.(body)) throw new Error('comment rejected');
          const comment = comments.find(({ id }) => id === comment_id);
          if (!comment) throw new Error('comment not found');
          comment.body = body;
          posted.push(body);
          return { data: comment };
        },
        deleteComment: async ({ comment_id }) => {
          const index = comments.findIndex(({ id }) => id === comment_id);
          if (index >= 0) comments.splice(index, 1);
        },
      },
    },
    paginate: async (which) => which === 'files' ? files : which === 'comments' ? comments : [{ commit: { message: 'test' } }],
  };
  const fetch = async (url, request) => {
    const body = JSON.parse(request.body);
    const lane = laneForUrl(url);
    const match = /\/models\/([^/:]+):generateContent$/.exec(url);
    const model = match ? decodeURIComponent(match[1]) : body.model;
    const call = { lane, model, body, headers: request.headers, url };
    captured.push(call);
    return route(call);
  };
  let error;
  try {
    await runScript(github, options.context || context, { env: { ...env, ...overrides } }, fetch, (fn) => setTimeout(fn, 0), clearTimeout, { log: (...xs) => logs.push(xs.join(' ')) });
  } catch (caught) {
    error = caught;
  }
  return { posted, captured, comments, logs, error, pullGets };
}

const checks = [];
const check = (name, condition) => { checks.push(Boolean(condition)); console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`); };
const healthy = ({ model, lane }) => reply(200, lane === 'C' ? geminiResult(`# review ${model}`, { thought: 'PRIVATE GEMINI THOUGHT' }) : chatResult(model, `# review ${model}`));

check('workflow has no model, provider, fallback, prompt, or budget inputs', !workflowText.includes('inputs:'));
check('workflow resolves repository config and exposes only fixed lane slots', workflowText.includes('uses: ./.ci-central/review-action')
  && ['A', 'B', 'C'].every((lane) => workflowText.includes(`PR_AGENT_LANE_${lane}_KEY`) && workflowText.includes(`PR_AGENT_LANE_${lane}_API_BASE`)));
check('config resolver is checked out at the reusable workflow commit', workflowText.includes('ref: ${{ github.job_workflow_sha }}')
  && !workflowText.includes('github.workflow_ref')
  && !workflowText.includes('TshyGO/ci-central/review-action@main'));
check('legacy provider slots are marked as a temporary migration bridge', workflowText.includes('Temporary migration bridge. Remove after every caller maps the fixed Lane slots.'));
check('reusable job centrally cancels superseded reviews', workflowText.includes('cancel-in-progress: true'));

let r = await scenario(healthy);
check('healthy path calls exactly the three configured lane primaries', r.captured.map(({ lane, model }) => `${lane}:${model}`).sort().join(',') === 'A:qwen3.8-max,B:glm-5.2,C:gemini-3.7-flash');
check('healthy path never calls a fallback', !r.captured.some(({ model }) => ['kimi-k3', 'deepseek-v4-pro-202606'].includes(model)));
check('each healthy lane publishes exactly one stable lane comment', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.posted.filter((body) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
const duplicateComments = [
  { id: 10, body: '<!-- ai-pr-review-bot:lane-A -->\nold diagnostic' },
  { id: 11, body: '<!-- ai-pr-review-bot:lane-A -->\nnewer diagnostic' },
  { id: 12, body: '<!-- ai-pr-review-bot:lane-B -->\nold review' },
];
r = await scenario(healthy, {}, { comments: duplicateComments });
check('reruns update one stable comment per lane and remove prior duplicates', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.comments.filter(({ body }) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
check('reasoning and Gemini thought parts never reach comments', !r.posted.some((body) => body.includes('private thinking') || body.includes('PRIVATE GEMINI THOUGHT')));
check('full-context primaries preserve input and output budgets', r.captured.filter(({ lane }) => lane !== 'C').every(({ body }) => body.messages[1].content.includes('Changed files and patches:') && body.max_tokens === 16384)
  && r.captured.find(({ lane }) => lane === 'C')?.body.generationConfig.maxOutputTokens === 16384);
check('protocol and credentials come from lanes', r.captured.find(({ lane }) => lane === 'A')?.url.endsWith('/chat/completions')
  && r.captured.find(({ lane }) => lane === 'A')?.headers.authorization === 'Bearer lane-a-key'
  && r.captured.find(({ lane }) => lane === 'B')?.headers.authorization === 'Bearer lane-b-key'
  && r.captured.find(({ lane }) => lane === 'C')?.headers['x-goog-api-key'] === 'lane-c-key');

r = await scenario(healthy, {
  LANE_A_KEY: '', LANE_A_API_BASE: '', LANE_C_KEY: '', LANE_C_API_BASE: '',
  LEGACY_OPENAI_KEY: 'legacy-a-key', LEGACY_OPENAI_API_BASE: 'https://lane-a.example.test/v1',
  LEGACY_GOOGLE_AI_KEY: 'legacy-c-key',
});
check('temporary legacy bridge keeps existing Alibaba and Google callers operational',
  r.captured.find(({ lane }) => lane === 'A')?.headers.authorization === 'Bearer legacy-a-key'
    && r.captured.find(({ lane }) => lane === 'C')?.headers['x-goog-api-key'] === 'legacy-c-key');

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane A uses Kimi only after Qwen exhausts retries', r.captured.filter(({ model }) => model === 'qwen3.8-max').length === 3 && r.captured.filter(({ model }) => model === 'kimi-k3').length === 1);
const kimi = r.captured.find(({ model }) => model === 'kimi-k3')?.body;
check('Kimi fallback uses validated throttling contract', kimi?.max_tokens === 8192 && !('temperature' in kimi) && kimi.messages[1].content.includes('All changed file names:'));
check('Kimi still yields one Lane A comment', r.posted.filter((body) => body.includes('ai-pr-review-bot:lane-A')).length === 1 && r.posted.some((body) => body.includes('qwen3.8-max unavailable -> served by kimi-k3')));

r = await scenario((call) => call.model === 'glm-5.2' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane B falls back only to DeepSeek', r.captured.filter(({ model }) => model === 'glm-5.2').length === 3
  && r.captured.filter(({ model }) => model === 'deepseek-v4-pro-202606').length === 1
  && !r.captured.some(({ lane, model }) => lane !== 'B' && model === 'deepseek-v4-pro-202606'));

r = await scenario((call) => call.lane === 'A' ? reply(429, '{"error":{"code":"insufficient_quota","message":"weekly quota exhausted"}}') : healthy(call));
check('quota failure short-circuits only its provider lane', r.captured.filter(({ lane }) => lane === 'A').length === 1
  && !r.captured.some(({ model }) => model === 'kimi-k3') && r.captured.some(({ lane }) => lane === 'B') && r.captured.some(({ lane }) => lane === 'C'));
check('failed lane publishes one diagnostic beside healthy lane reviews', r.posted.length === 3 && r.posted.some((body) => body.includes('shared Token Plan quota is exhausted')));

r = await scenario((call) => { if (call.lane === 'A') throw new Error('fetch failed'); return healthy(call); });
check('DNS or TLS style failures retry primary but do not resend context to fallback', r.captured.filter(({ lane }) => lane === 'A').length === 3
  && !r.captured.some(({ model }) => model === 'kimi-k3') && r.logs.some((line) => line.includes('endpoint-unavailable') && line.includes('Lane A')));

r = await scenario((call) => call.model === 'qwen3.8-max' && 'temperature' in call.body
  ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'temperature\'"}}') : healthy(call));
const repairedQwen = r.captured.filter(({ model }) => model === 'qwen3.8-max').map(({ body }) => body);
check('optional-field rejection repairs the request inside the same lane', repairedQwen.length === 2 && !('temperature' in repairedQwen[1]));

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(200, chatResult(call.model, '')) : healthy(call));
check('empty final content advances to fallback without publishing reasoning', r.captured.some(({ model }) => model === 'kimi-k3') && !r.posted.some((body) => body.includes('private thinking')));

const sameModelConfig = structuredClone(centralConfig);
sameModelConfig.lanes[1].primary = { ...sameModelConfig.lanes[1].primary, id: 'qwen3.8-max', label: 'Qwen via Lane B' };
sameModelConfig.lanes[1].fallbacks = [];
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(sameModelConfig) });
check('identical model ids on different providers remain lane-scoped', r.captured.filter(({ model }) => model === 'qwen3.8-max').length === 2
  && r.captured.some(({ lane, model, headers }) => lane === 'A' && model === 'qwen3.8-max' && headers.authorization === 'Bearer lane-a-key')
  && r.captured.some(({ lane, model, headers }) => lane === 'B' && model === 'qwen3.8-max' && headers.authorization === 'Bearer lane-b-key'));

const protocolConfig = structuredClone(centralConfig);
protocolConfig.lanes[1].primary = { ...protocolConfig.lanes[1].primary, id: 'gemini-3.7-flash', label: 'Gemini via OpenAI protocol' };
protocolConfig.lanes[1].fallbacks = [];
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(protocolConfig) });
check('protocol is bound to lane rather than inferred from model id', r.captured.some(({ lane, model, url }) => lane === 'B' && model === 'gemini-3.7-flash' && url.endsWith('/chat/completions')));

const throttledGoogleConfig = structuredClone(centralConfig);
throttledGoogleConfig.lanes[2].primary = { ...throttledGoogleConfig.lanes[2].primary, context_profile: 'kimi-k3-throttled', max_output_tokens: 8192 };
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(throttledGoogleConfig) });
const throttledGoogle = r.captured.find(({ lane }) => lane === 'C')?.body;
check('Google protocol honors the configured throttled context profile', throttledGoogle?.generationConfig.maxOutputTokens === 8192
  && throttledGoogle.systemInstruction.parts[0].text.includes('high-confidence')
  && throttledGoogle.contents[0].parts[0].text.includes('All changed file names:'));

const missingPromptConfig = structuredClone(centralConfig);
delete missingPromptConfig.review_policy.system_prompt;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingPromptConfig) });
check('workflow defense rejects a missing system prompt before model calls', /system_prompt/.test(r.error?.message || '') && r.captured.length === 0);

const missingFallbacksConfig = structuredClone(centralConfig);
delete missingFallbacksConfig.lanes[0].fallbacks;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingFallbacksConfig) });
check('workflow defense rejects a missing fallback array before model calls', /fallbacks must be an array/.test(r.error?.message || '') && r.captured.length === 0);

r = await scenario(healthy, { LANE_B_KEY: '' });
check('an unprovisioned lane emits one diagnostic without blocking healthy lanes', r.error === undefined
  && r.captured.length === 2
  && !r.captured.some(({ lane }) => lane === 'B')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('PR_AGENT_LANE_B_KEY')));

r = await scenario(healthy, {
  LANE_A_KEY: '', LANE_A_API_BASE: '', LANE_B_KEY: '', LANE_B_API_BASE: '', LANE_C_KEY: '', LANE_C_API_BASE: '',
  LEGACY_OPENAI_KEY: '', LEGACY_OPENAI_API_BASE: '', LEGACY_TENCENT_KEY: '', LEGACY_TENCENT_API_BASE: '', LEGACY_GOOGLE_AI_KEY: '',
});
check('diagnostic-only execution fails the job after preserving lane diagnostics', /no model review was generated/.test(r.error?.message || '')
  && r.captured.length === 0 && r.posted.length === 3);

const newerPull = { ...pull, head: { ...pull.head, sha: 'cafebabe' } };
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [newerPull] });
check('superseded event makes zero model calls before context collection', r.captured.length === 0 && r.logs.some((line) => line.includes('before context collection')));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [pull, newerPull] });
check('head change during collection makes zero model calls', r.captured.length === 0 && r.logs.some((line) => line.includes('before model dispatch')));
r = await scenario(healthy, {}, { pulls: [pull, pull, newerPull] });
check('head change during model execution publishes no stale comments', r.captured.length === 3 && r.posted.length === 0 && r.logs.some((line) => line.includes('before comment publishing')));

r = await scenario(healthy, {}, { rejectComment: (body) => body.includes('lane-A') });
check('one comment failure does not swallow healthy independent lanes', r.posted.length === 2 && r.posted.some((body) => body.includes('lane-B')) && r.posted.some((body) => body.includes('lane-C')));

if (checks.some((value) => !value)) process.exitCode = 1;
