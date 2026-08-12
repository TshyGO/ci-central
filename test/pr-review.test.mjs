#!/usr/bin/env node
// Executes the real inline workflow script against mocked GitHub and HTTP APIs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', '.github', 'workflows', 'pr-review.yml'), 'utf8').split('\n');
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
const pull = { number: 42, title: 'Test', user: { login: 'octocat' }, base: { ref: 'main' }, head: { ref: 'feature' }, body: '' };
const context = { payload: { pull_request: { number: 42, head: { sha: 'deadbeef' } } }, repo: { owner: 'TshyGO', repo: 'Example' }, serverUrl: 'https://github.com', runId: 1 };
const env = {
  OPENAI_API_KEY: 'test-key', OPENAI_API_BASE: 'https://example.test/v1/', GOOGLE_AI_API_KEY: 'google-test-key',
  PR_REVIEW_MODELS: 'glm-5.2,qwen3.8-max,deepseek-v4-pro,gemini-3.6-flash',
  PR_REVIEW_MODEL_LABELS: '{"glm-5.2":"GLM-5.2","qwen3.8-max":"Qwen3.8-Max","deepseek-v4-pro":"DeepSeek-V4-Pro","gemini-3.6-flash":"Gemini-3.6-Flash"}',
  PR_REVIEW_FALLBACKS: '{"glm-5.2":["deepseek-v4-pro"],"qwen3.8-max":["glm-5.2"],"deepseek-v4-pro":["qwen3.8-max"]}',
  PR_REVIEW_DIFF_BUDGET: '100000',
};
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });
const result = (model, content, { reasoning = 'private thinking', finish = 'stop' } = {}) => JSON.stringify({
  model: `provider/${model}`,
  choices: [{ finish_reason: finish, message: { content, reasoning_content: reasoning } }],
  usage: { prompt_tokens: 1 },
});
const geminiResult = (content, { finish = 'STOP' } = {}) => JSON.stringify({
  candidates: [{ finishReason: finish, content: { parts: [{ text: content }] } }],
  usageMetadata: { promptTokenCount: 1 },
});

async function scenario(route, overrides = {}) {
  const posted = [], captured = [], urls = [], logs = [];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }), listFiles: 'files', listCommits: 'commits' },
      issues: { get: async () => { throw new Error('not found'); }, createComment: async ({ body }) => { posted.push(body); return { data: {} }; } },
    },
    paginate: async (which) => which === 'files' ? files : [{ commit: { message: 'test' } }],
  };
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const model = url.includes('generativelanguage.googleapis.com') ? 'gemini-3.6-flash' : body.model;
    captured.push({ model, body, headers: options.headers }); urls.push(url);
    return route(model, body);
  };
  let error;
  try { await runScript(github, context, { env: { ...env, ...overrides } }, fetch, (fn) => setTimeout(fn, 0), clearTimeout, { log: (...xs) => logs.push(xs.join(' ')) }); }
  catch (e) { error = e; }
  return { posted, captured, urls, logs, error };
}

const checks = [];
const check = (name, condition) => { checks.push(condition); console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`); };

let r = await scenario((model) => reply(200, model === 'gemini-3.6-flash' ? geminiResult(`# review ${model}`) : result(model, `# review ${model}`)));
check('four configured primaries are called', r.captured.map((x) => x.model).sort().join(',') === 'deepseek-v4-pro,gemini-3.6-flash,glm-5.2,qwen3.8-max');
check('Model Studio models use standard chat completions', r.urls.filter((url) => !url.includes('generativelanguage.googleapis.com')).every((url) => url.endsWith('/chat/completions')));
const studioBodies = r.captured.filter((x) => x.model !== 'gemini-3.6-flash').map((x) => x.body);
check('Model Studio payload contract is uniform', studioBodies.every((body) => body.messages?.length === 2 && body.stream === false && body.max_tokens === 16384 && body.temperature === 0.2));
const geminiCall = r.captured.find((x) => x.model === 'gemini-3.6-flash');
check('Gemini uses generateContent and its native payload', geminiCall && r.urls.find((url) => url.includes('generativelanguage.googleapis.com')).endsWith('/models/gemini-3.6-flash:generateContent') && geminiCall.body.systemInstruction?.parts?.length === 1 && geminiCall.body.contents?.[0]?.parts?.length === 1 && geminiCall.headers['x-goog-api-key'] === 'google-test-key');
check('one comment per model', r.posted.length === 4);
check('reasoning never reaches a PR comment', !r.posted.some((body) => body.includes('private thinking')));
check('labels use the new configured names', r.posted.some((body) => body.includes('Qwen3.8-Max')) && r.posted.some((body) => body.includes('DeepSeek-V4-Pro')));

r = await scenario((model) => model === 'glm-5.2' ? reply(503, '{"error":"unavailable"}') : reply(200, model === 'gemini-3.6-flash' ? geminiResult(`# review ${model}`) : result(model, `# review ${model}`)));
check('transient primary failure retries three times', r.captured.filter((entry) => entry.model === 'glm-5.2').length === 3);
check('configured fallback is used after primary failure', r.captured.some((entry) => entry.model === 'deepseek-v4-pro'));
check('fallback review is marked as degraded', r.posted.some((body) => body.includes('glm-5.2 unavailable -> served by deepseek-v4-pro')));

r = await scenario((model, body) => model === 'qwen3.8-max' && 'temperature' in body
  ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'temperature\'"}}')
  : reply(200, model === 'gemini-3.6-flash' ? geminiResult('# review') : result(model, '# review')));
const qwenAttempts = r.captured.filter((entry) => entry.model === 'qwen3.8-max').map((entry) => entry.body);
check('optional-field rejection retries without the field', qwenAttempts.length === 2 && !('temperature' in qwenAttempts[1]));

r = await scenario((model) => reply(200, model === 'gemini-3.6-flash' ? geminiResult('# review') : result(model, model === 'deepseek-v4-pro' ? '' : '# review')));
check('empty final content does not publish reasoning', !r.posted.some((body) => body.includes('private thinking')));
check('empty final content moves to its configured fallback', r.captured.filter((entry) => entry.model === 'qwen3.8-max').length >= 2);

r = await scenario((model) => reply(200, model === 'gemini-3.6-flash' ? geminiResult('', { finish: 'MAX_TOKENS' }) : result(model, '# review')));
check('Gemini empty output posts a diagnostic rather than leaking hidden data', r.posted.some((body) => body.includes('gemini-3.6-flash') && body.includes('AI review was not generated')) && !r.posted.some((body) => body.includes('private thinking')));

r = await scenario((model) => reply(200, model === 'gemini-3.6-flash' ? geminiResult('# partial', { finish: 'MAX_TOKENS' }) : result(model, '# review')));
check('Gemini non-STOP output is marked incomplete', r.posted.some((body) => body.includes('# partial') && body.includes('模型输出未完整结束')));

r = await scenario((model) => reply(200, model === 'gemini-3.6-flash' ? geminiResult('# review') : result(model, '# review')), { GOOGLE_AI_API_KEY: '' });
check('Gemini requires its separate secret', /PR_AGENT_GOOGLE_AI_KEY is required/.test(r.error?.message || ''));

if (checks.some((x) => !x)) process.exitCode = 1;
