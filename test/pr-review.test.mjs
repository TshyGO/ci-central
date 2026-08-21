#!/usr/bin/env node
// Executes the real inline workflow script against mocked GitHub and HTTP APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-review.yml'), 'utf8').split('\n');
const workflowText = raw.join('\n');
const callerText = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-agent.yml'), 'utf8');
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
const headSha = 'deadbeef'.repeat(5);
const workflowSha = 'feedface'.repeat(5);
const pull = { number: 42, title: 'Test', state: 'open', user: { login: 'octocat' }, base: { ref: 'main' }, head: { ref: 'feature', sha: headSha }, body: '' };
const context = { eventName: 'pull_request', payload: { pull_request: { number: 42, head: { sha: headSha } } }, repo: { owner: 'TshyGO', repo: 'NebulaLab' }, serverUrl: 'https://github.com', runId: 1 };
const env = {
  LANE_A_KEY: 'lane-a-key', LANE_A_API_BASE: 'https://lane-a.example.test/v1/',
  LANE_B_KEY: 'lane-b-key', LANE_B_API_BASE: 'https://lane-b.example.test/v1/',
  LANE_C_KEY: 'lane-c-key', LANE_C_API_BASE: 'https://lane-c.example.test/v1beta/',
  PR_REVIEW_CONFIG: JSON.stringify(centralConfig),
  PR_REVIEW_WORKFLOW_SHA: workflowSha,
};
const evidenceComment = (lane, { head = headSha, workflow = workflowSha, status = 'valid' } = {}) => ({
  body: [
    `<!-- ai-pr-review-bot:lane-${lane} -->`,
    `<!-- ai-pr-review-evidence:v2 lane=${lane} head=${head} workflow=${workflow} status=${status} -->`,
    `review ${lane}`,
  ].join('\n'),
});
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });
const chatResult = (model, content, { reasoning = 'private thinking', finish = 'stop' } = {}) => JSON.stringify({
  model: `provider/${model}`,
  choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning } }],
  usage: { prompt_tokens: 1 },
});
const geminiResult = (content, { finish = 'STOP', thought = '', usageMetadata } = {}) => JSON.stringify({
  candidates: [{ finishReason: finish, content: { parts: [
    ...(thought ? [{ thought: true, text: thought }] : []),
    { text: content },
  ] } }],
  usageMetadata: usageMetadata || {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    thoughtsTokenCount: 512,
    totalTokenCount: 632,
  },
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
check('config resolver uses a validated trusted workflow SHA', workflowText.includes('- name: Resolve matching central ref')
  && workflowText.includes('JOB_WORKFLOW_SHA: ${{ github.job_workflow_sha }}')
  && workflowText.includes('REPOSITORY: ${{ github.repository }}')
  && workflowText.includes('"$REPOSITORY" == "TshyGO/ci-central"')
  && workflowText.includes('ref: ${{ steps.central-ref.outputs.sha }}')
  && workflowText.includes('PR_REVIEW_WORKFLOW_SHA: ${{ steps.central-ref.outputs.sha }}')
  && workflowText.includes('trusted 40-character ci-central workflow SHA')
  && !workflowText.includes('github.workflow_ref')
  && !workflowText.includes('TshyGO/ci-central/review-action@main'));
check('reusable workflow accepts only fixed Lane secret slots',
  !['PR_AGENT_OPENAI_KEY', 'PR_AGENT_OPENAI_API_BASE', 'PR_AGENT_TENCENT_KEY', 'PR_AGENT_TENCENT_API_BASE', 'PR_AGENT_GOOGLE_AI_KEY', 'LEGACY_']
    .some((name) => workflowText.includes(name)));
check('central repository self-caller exercises the workflow from its own PR revision', callerText.includes('uses: ./.github/workflows/pr-review.yml')
  && !callerText.includes('TshyGO/ci-central/.github/workflows/pr-review.yml@main')
  && ['A', 'B', 'C'].every((lane) => callerText.includes(`PR_AGENT_LANE_${lane}_KEY`) && callerText.includes(`PR_AGENT_LANE_${lane}_API_BASE`))
  && callerText.includes('group: ai-pr-review-${{ github.event.pull_request.number || github.event.issue.number }}')
  && callerText.includes('cancel-in-progress: true')
  && callerText.includes("github.event.pull_request.author_association == 'OWNER'")
  && !/qwen|glm|gemini|kimi|deepseek|alibaba|tencent|google/i.test(callerText));
check('reusable job uses one latest-wins group for automatic and manual triggers', workflowText.includes('group: centralized-ai-pr-review-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}')
  && workflowText.includes('cancel-in-progress: true')
  && workflowText.includes('timeout-minutes: 30'));

let r = await scenario(healthy);
check('healthy path calls exactly the three configured lane primaries', r.captured.map(({ lane, model }) => `${lane}:${model}`).sort().join(',') === 'A:qwen3.8-max,B:glm-5.2,C:gemini-3.7-flash');
check('healthy path never calls a fallback', !r.captured.some(({ model }) => ['qwen3.7-max', 'deepseek-v4-pro-202606'].includes(model)));
const healthyLaneA = r.captured.find(({ lane }) => lane === 'A')?.body;
const healthyLaneB = r.captured.find(({ lane }) => lane === 'B')?.body;
const healthyLaneC = r.captured.find(({ lane }) => lane === 'C')?.body;
check('only Google Lane C receives the deep-review prompt contract',
  healthyLaneA?.messages[0].content === centralConfig.review_policy.system_prompt
  && healthyLaneB?.messages[0].content === centralConfig.review_policy.system_prompt
  && healthyLaneC?.systemInstruction.parts[0].text.includes('two independent internal review passes')
  && !healthyLaneA?.messages[0].content.includes('two independent internal review passes')
  && !healthyLaneB?.messages[0].content.includes('two independent internal review passes'));
check('Google Lane C explicitly requests maximum Gemini thinking depth',
  healthyLaneC?.generationConfig.thinkingConfig?.thinkingLevel === 'HIGH');
check('each healthy lane publishes exactly one stable lane comment', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.posted.filter((body) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
check('healthy comments carry reusable v2 evidence for the full head and workflow SHAs', ['A', 'B', 'C'].every((lane) =>
  r.posted.some((body) => body.includes(`<!-- ai-pr-review-evidence:v2 lane=${lane} head=${headSha} workflow=${workflowSha} status=valid -->`))));

const validEvidence = ['A', 'B', 'C'].map((lane) => evidenceComment(lane));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { comments: validEvidence });
check('automatic rerun reuses all valid same-head evidence without model calls', r.error === undefined
  && r.captured.length === 0 && r.posted.length === 0 && r.pullGets === 2
  && r.logs.some((line) => line.includes('skipping model requests')));

r = await scenario(healthy, {}, { comments: [
  evidenceComment('A'),
  evidenceComment('B', { status: 'diagnostic' }),
  evidenceComment('C', { status: 'partial' }),
] });
check('automatic rerun calls only missing or invalid Lanes', r.error === undefined
  && r.captured.map(({ lane }) => lane).sort().join(',') === 'B,C'
  && r.posted.length === 2);

r = await scenario(healthy, {}, { comments: [
  evidenceComment('A'),
  evidenceComment('A', { status: 'diagnostic' }),
  evidenceComment('B'),
  evidenceComment('C'),
] });
check('duplicate stable comments force only that Lane to rerun and reconcile history', r.error === undefined
  && r.captured.map(({ lane }) => lane).join(',') === 'A'
  && r.posted.length === 1
  && r.comments.filter(({ body }) => body.includes('ai-pr-review-bot:lane-A')).length === 1
  && r.logs.some((line) => line.includes('forcing a rerun to reconcile duplicates')));

r = await scenario(healthy, {}, { comments: ['A', 'B', 'C'].map((lane) => evidenceComment(lane, { workflow: '0'.repeat(40) })) });
check('evidence from an older reusable workflow revision is not reused', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);

const otherHeadSha = '01234567'.repeat(5);
const otherHeadPull = { ...pull, head: { ...pull.head, sha: otherHeadSha } };
const otherHeadContext = { ...context, payload: { pull_request: { number: 42, head: { sha: otherHeadSha } } } };
r = await scenario(healthy, {}, { comments: validEvidence, pulls: [otherHeadPull], context: otherHeadContext });
check('valid evidence from an older PR head is not reused', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);

const manualContext = { ...context, eventName: 'issue_comment', payload: { issue: { number: 42 }, comment: { body: '/review' } } };
r = await scenario(healthy, {}, { comments: validEvidence, context: manualContext });
check('manual /review bypasses same-head reuse and forces every Lane', r.error === undefined && r.captured.length === 3 && r.posted.length === 3
  && r.logs.some((line) => line.includes('forces every configured Lane')));

r = await scenario(healthy, {}, { comments: validEvidence.map((comment) => ({ ...comment, user: { login: 'octocat' } })) });
check('non-bot comments cannot spoof reusable review evidence', r.error === undefined && r.captured.length === 3 && r.posted.length === 3);

r = await scenario(healthy, { PR_REVIEW_WORKFLOW_SHA: '' });
check('workflow defense requires a full reusable-workflow SHA before model calls', /40-character/.test(r.error?.message || '') && r.captured.length === 0);
const duplicateComments = [
  { id: 10, body: '<!-- ai-pr-review-bot:lane-A -->\nold diagnostic' },
  { id: 11, body: '<!-- ai-pr-review-bot:lane-A -->\nnewer diagnostic' },
  { id: 12, body: '<!-- ai-pr-review-bot:lane-B -->\nold review' },
];
r = await scenario(healthy, {}, { comments: duplicateComments });
check('reruns update one stable comment per lane and remove prior duplicates', r.posted.length === 3
  && ['A', 'B', 'C'].every((lane) => r.comments.filter(({ body }) => body.includes(`<!-- ai-pr-review-bot:lane-${lane} -->`)).length === 1));
check('reasoning and Gemini thought parts never reach comments', !r.posted.some((body) => body.includes('private thinking') || body.includes('PRIVATE GEMINI THOUGHT')));
check('Gemini thought-token usage is visible without exposing thought text',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: 512 tokens')));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } })
  : chatResult(call.model, `# review ${call.model}`, { reasoning: '' })));
check('zero or absent thinking usage keeps provider reporting accurate',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: 0 tokens'))
  && ['A', 'B'].every((lane) => r.posted.some((body) => body.includes(`lane-${lane}`) && body.includes('Thinking: not reported'))));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { usageMetadata: { promptTokenCount: 100 } })
  : chatResult(call.model, `# review ${call.model}`)));
check('missing Gemini token totals remain explicitly unreported',
  r.posted.some((body) => body.includes('lane-C') && body.includes('Thinking: not reported')));

r = await scenario((call) => reply(200, call.lane === 'C'
  ? geminiResult(`# review ${call.model}`, { finish: 'stop' })
  : chatResult(call.model, `# review ${call.model}`, { finish: 'STOP' })));
check('finish reasons are normalized across provider casing', r.error === undefined
  && ['A', 'B', 'C'].every((lane) => r.posted.some((body) => body.includes(`lane-${lane}`) && body.includes('status=valid')))
  && !r.posted.some((body) => body.includes('可能不完整')));

check('full-context primaries preserve input and output budgets', r.captured.filter(({ lane }) => lane !== 'C').every(({ body }) => body.messages[1].content.includes('Changed files and patches:') && body.max_tokens === 16384)
  && r.captured.find(({ lane }) => lane === 'C')?.body.generationConfig.maxOutputTokens === 16384
  && r.captured.find(({ lane }) => lane === 'C')?.body.generationConfig.thinkingConfig?.thinkingLevel === 'HIGH');

const expandedLaneBConfig = structuredClone(centralConfig);
expandedLaneBConfig.lanes[1].primary.max_output_tokens = 32768;
expandedLaneBConfig.lanes[1].fallbacks[0].max_output_tokens = 32768;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(expandedLaneBConfig) });
check('repository policy can raise only Lane B to a 32K completion ceiling', r.error === undefined
  && r.captured.find(({ lane }) => lane === 'A')?.body.max_tokens === 16384
  && r.captured.find(({ lane }) => lane === 'B')?.body.max_tokens === 32768
  && r.captured.find(({ lane }) => lane === 'C')?.body.generationConfig.maxOutputTokens === 16384);
check('protocol and credentials come from lanes', r.captured.find(({ lane }) => lane === 'A')?.url.endsWith('/chat/completions')
  && r.captured.find(({ lane }) => lane === 'A')?.headers.authorization === 'Bearer lane-a-key'
  && r.captured.find(({ lane }) => lane === 'B')?.headers.authorization === 'Bearer lane-b-key'
  && r.captured.find(({ lane }) => lane === 'C')?.headers['x-goog-api-key'] === 'lane-c-key');

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane A uses Qwen3.7-Max only after Qwen3.8-Max exhausts retries', r.captured.filter(({ model }) => model === 'qwen3.8-max').length === 3 && r.captured.filter(({ model }) => model === 'qwen3.7-max').length === 1);
const qwenFallback = r.captured.find(({ model }) => model === 'qwen3.7-max')?.body;
check('Qwen3.7-Max fallback uses the full review contract', qwenFallback?.max_tokens === 16384 && qwenFallback?.temperature === 0.2 && qwenFallback.messages[1].content.includes('Changed files and patches:'));
check('Qwen3.7-Max still yields one Lane A comment', r.posted.filter((body) => body.includes('ai-pr-review-bot:lane-A')).length === 1 && r.posted.some((body) => body.includes('qwen3.8-max unavailable -> served by qwen3.7-max')));

r = await scenario((call) => call.model === 'glm-5.2' ? reply(503, '{"error":"unavailable"}') : healthy(call));
check('Lane B falls back only to DeepSeek', r.captured.filter(({ model }) => model === 'glm-5.2').length === 3
  && r.captured.filter(({ model }) => model === 'deepseek-v4-pro-202606').length === 1
  && !r.captured.some(({ lane, model }) => lane !== 'B' && model === 'deepseek-v4-pro-202606'));

r = await scenario((call) => call.lane === 'A' ? reply(429, '{"error":{"code":"insufficient_quota","message":"weekly quota exhausted"}}') : healthy(call));
check('quota failure short-circuits only its provider lane', r.captured.filter(({ lane }) => lane === 'A').length === 1
  && !r.captured.some(({ model }) => model === 'qwen3.7-max') && r.captured.some(({ lane }) => lane === 'B') && r.captured.some(({ lane }) => lane === 'C'));
check('failed lane publishes a diagnostic and fails the strict aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('shared Token Plan quota is exhausted') && body.includes('status=diagnostic')));

r = await scenario((call) => { if (call.lane === 'A') throw new Error('fetch failed'); return healthy(call); });
check('DNS or TLS style failures retry primary but do not resend context to fallback', r.captured.filter(({ lane }) => lane === 'A').length === 3
  && !r.captured.some(({ model }) => model === 'qwen3.7-max') && r.logs.some((line) => line.includes('endpoint-unavailable') && line.includes('Lane A')));

r = await scenario((call) => call.model === 'qwen3.8-max' && 'temperature' in call.body
  ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'temperature\'"}}') : healthy(call));
const repairedQwen = r.captured.filter(({ model }) => model === 'qwen3.8-max').map(({ body }) => body);
check('optional-field rejection repairs the request inside the same lane', repairedQwen.length === 2 && !('temperature' in repairedQwen[1]));

r = await scenario((call) => call.model === 'qwen3.8-max' ? reply(200, chatResult(call.model, '')) : healthy(call));
check('empty final content advances to fallback without publishing reasoning', r.captured.some(({ model }) => model === 'qwen3.7-max') && !r.posted.some((body) => body.includes('private thinking')));

r = await scenario((call) => call.lane === 'A'
  ? reply(200, chatResult(call.model, '# incomplete', { finish: 'LENGTH' }))
  : healthy(call));
check('truncated output is marked partial and cannot satisfy the strict aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.posted.some((body) => body.includes('lane-A') && body.includes('status=partial') && body.includes('max_tokens')));

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
  && throttledGoogle.systemInstruction.parts[0].text.includes('two independent internal review passes')
  && throttledGoogle.contents[0].parts[0].text.includes('All changed file names:'));

const missingPromptConfig = structuredClone(centralConfig);
delete missingPromptConfig.review_policy.system_prompt;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingPromptConfig) });
check('workflow defense rejects a missing system prompt before model calls', /system_prompt/.test(r.error?.message || '') && r.captured.length === 0);

const missingFallbacksConfig = structuredClone(centralConfig);
delete missingFallbacksConfig.lanes[0].fallbacks;
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(missingFallbacksConfig) });
check('workflow defense rejects a missing fallback array before model calls', /fallbacks must be an array/.test(r.error?.message || '') && r.captured.length === 0);

const invalidThinkingConfig = structuredClone(centralConfig);
invalidThinkingConfig.lanes[2].primary.thinking_level = 'maximum';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(invalidThinkingConfig) });
check('workflow defense rejects an unsupported Google thinking level before model calls', /thinking_level is not supported/.test(r.error?.message || '') && r.captured.length === 0);

const crossProtocolThinkingConfig = structuredClone(centralConfig);
crossProtocolThinkingConfig.lanes[0].primary.thinking_level = 'high';
r = await scenario(healthy, { PR_REVIEW_CONFIG: JSON.stringify(crossProtocolThinkingConfig) });
check('workflow defense rejects thinking configuration outside Google protocol', /only supported by google-generate-content/.test(r.error?.message || '') && r.captured.length === 0);

r = await scenario(healthy, { LANE_B_KEY: '' });
check('an unprovisioned lane preserves healthy reviews but fails the strict aggregate gate', /Lane B/.test(r.error?.message || '')
  && r.captured.length === 2
  && !r.captured.some(({ lane }) => lane === 'B')
  && r.posted.length === 3
  && r.posted.some((body) => body.includes('PR_AGENT_LANE_B_KEY')));

r = await scenario(healthy, {
  LANE_A_KEY: '', LANE_A_API_BASE: '', LANE_B_KEY: '', LANE_B_API_BASE: '', LANE_C_KEY: '', LANE_C_API_BASE: '',
});
check('diagnostic-only execution fails the job after preserving lane diagnostics', /Lane A, Lane B, Lane C/.test(r.error?.message || '')
  && r.captured.length === 0 && r.posted.length === 3);

const newerPull = { ...pull, head: { ...pull.head, sha: 'cafebabe'.repeat(5) } };
r = await scenario(() => { throw new Error('model should not run'); }, {}, { comments: validEvidence, pulls: [pull, newerPull] });
check('head change during evidence reuse prevents a stale green result', r.captured.length === 0 && r.posted.length === 0
  && r.logs.some((line) => line.includes('Skip stale evidence reuse')));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [newerPull] });
check('superseded event makes zero model calls before context collection', r.captured.length === 0 && r.logs.some((line) => line.includes('before context collection')));
r = await scenario(() => { throw new Error('model should not run'); }, {}, { pulls: [pull, newerPull] });
check('head change during collection makes zero model calls', r.captured.length === 0 && r.logs.some((line) => line.includes('before model dispatch')));
r = await scenario(healthy, {}, { pulls: [pull, pull, newerPull] });
check('head change during model execution publishes no stale comments', r.captured.length === 3 && r.posted.length === 0 && r.logs.some((line) => line.includes('before comment publishing')));

r = await scenario(healthy, {}, { rejectComment: (body) => body.includes('lane-A') });
check('one comment failure preserves healthy independent lanes but fails the aggregate gate', /Lane A/.test(r.error?.message || '')
  && r.posted.length === 2 && r.posted.some((body) => body.includes('lane-B')) && r.posted.some((body) => body.includes('lane-C')));

if (checks.some((value) => !value)) process.exitCode = 1;
