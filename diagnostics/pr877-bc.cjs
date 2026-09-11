'use strict';
// Temporary owner-authorized diagnostic. No publication, secret writes or production changes.
const fs = require('node:fs');
const crypto = require('node:crypto');
const OpenAI = require('openai').default;
const { Agent, fetch: undiciFetch } = require('undici');
const EXPECTED_HEAD = 'b568643dc65edf2e6651191c445115d4951c058c';
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const log = (value) => console.log(JSON.stringify(value));
const code = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(s) ? s : undefined;
const knownFields = new Set(['content', 'reasoning_content', 'reasoning', 'thinking', 'reasoning_details',
  'role', 'tool_calls', 'function_call', 'refusal', 'encrypted_content', 'analysis', 'text']);
function observeFields(target, obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj)) {
    const name = knownFields.has(key) ? key : 'OTHER';
    const item = target[name] ||= { events: 0, string_chars: 0, objects: 0 };
    item.events++;
    if (typeof value === 'string') item.string_chars += value.length;
    else if (value && typeof value === 'object') item.objects++;
  }
}
async function getInput(github) {
  const owner = 'TshyGO', repo = 'NebulaLab', pullNumber = 877;
  const { data: pull } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull.head.sha !== EXPECTED_HEAD) throw new Error('PR head changed; refusing incomparable input');
  const config = JSON.parse(fs.readFileSync('review-action/config/repositories/TshyGO__NebulaLab.json', 'utf8'));
  // Use the exact deployed context packer; PR/issue text remains data, never code.
  const source = fs.readFileSync('.github/workflows/pr-review.yml', 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf('            const files = await github.paginate(github.rest.pulls.listFiles,');
  const end = source.indexOf('            // Model ids are scoped to a lane', start);
  if (start < 0 || end < start) throw new Error('Context extractor boundary mismatch');
  const fragment = source.slice(start, end);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const input = await new AsyncFunction('github', 'pull', 'owner', 'repo', 'pullNumber', 'reviewPolicy',
    fragment + '\nreturn {system,user,patchChars:diffPack.packedChars,files:files.length};')(
      github, pull, owner, repo, pullNumber, config.review_policy);
  if (input.patchChars !== 36879 || input.files !== 12) throw new Error('PR patch differs from original failure');
  input.messages = [{ role: 'system', content: input.system }, { role: 'user', content: input.user }];
  log({ event: 'input', head: EXPECTED_HEAD, patch_chars: input.patchChars, files: input.files,
    input_sha256: hash(JSON.stringify(input.messages)), packer_sha256: hash(fragment) });
  return { ...input, config };
}
async function probe({ label, payload, timeoutMs, originalDeadline }, credentials) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stats = { event: 'progress', label, elapsed_ms: 0, bytes: 0, events: 0,
    headers_ms: null, first_event_ms: null, first_content_ms: null, content_chars: 0,
    reasoning_chars: 0, finish_reason: null, choice_index: {}, delta_fields: {}, message_fields: {} };
  const report = (event) => log({ ...stats, event, elapsed_ms: Date.now() - started });
  const ticker = setInterval(() => report('progress'), 30000);
  const counterfactual = originalDeadline ? setTimeout(() => report('production_deadline_snapshot'), originalDeadline) : null;
  let dispatcher, stream, content = '';
  try {
    const base = new URL(credentials.baseURL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !credentials.apiKey?.trim()) {
      throw new Error('Invalid explicit lane credentials');
    }
    dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
      connectTimeout: Math.min(30000, timeoutMs), autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1000 });
    const client = new OpenAI({ ...credentials, organization: null, project: null,
      maxRetries: 0, timeout: timeoutMs, logLevel: 'off',
      fetch: async (url, init) => {
        const response = await undiciFetch(url, { ...init, dispatcher, redirect: 'error' });
        stats.status = response.status;
        stats.headers_ms = Date.now() - started;
        const bounded = response.body?.pipeThrough(new TransformStream({ transform(chunk, c) {
          stats.bytes += chunk.byteLength;
          if (stats.bytes > 32 * 1024 * 1024) throw new Error('Response byte limit');
          c.enqueue(chunk);
        } }));
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      } });
    log({ event: 'request', label, model: payload.model, max_tokens: payload.max_tokens ?? 'omitted',
      reasoning_effort: payload.reasoning_effort ?? 'omitted', timeout_ms: timeoutMs,
      input_sha256: hash(JSON.stringify(payload.messages)), requests: 1 });
    stream = await client.chat.completions.create(payload, { signal: controller.signal, maxRetries: 0 });
    for await (const event of stream) {
      controller.signal.throwIfAborted();
      stats.events++;
      stats.first_event_ms ??= Date.now() - started;
      stats.upstream = code(event.model) || stats.upstream;
      for (const choice of event.choices || []) {
        const index = choice.index === 0 ? 'number_zero' : choice.index === '0' ? 'string_zero'
          : choice.index === undefined ? 'missing' : 'other';
        stats.choice_index[index] = (stats.choice_index[index] || 0) + 1;
        observeFields(stats.delta_fields, choice.delta);
        observeFields(stats.message_fields, choice.message);
      }
      const choice = event.choices?.find((item) => item.index === 0);
      if (typeof choice?.delta?.content === 'string') {
        if (choice.delta.content) stats.first_content_ms ??= Date.now() - started;
        content += choice.delta.content;
        stats.content_chars = content.length;
      }
      if (typeof choice?.delta?.reasoning_content === 'string') stats.reasoning_chars += choice.delta.reasoning_content.length;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.trim()) {
        stats.finish_reason = ['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) ? choice.finish_reason : 'other';
        break;
      }
    }
    if (!stats.finish_reason) {
      controller.signal.throwIfAborted();
      const error = new Error('No completion boundary'); error.code = 'INCOMPLETE_STREAM'; throw error;
    }
    stats.valid = stats.finish_reason === 'stop' && Boolean(content.trim()) && !/<\/?think\b/i.test(content);
    stats.final_sha256 = hash(content);
    if (stats.valid && process.env.DIAG_MODE === 'B-original-long') {
      fs.mkdirSync('diagnostic-output', { recursive: true });
      fs.writeFileSync('diagnostic-output/final-review.md', content, { mode: 0o600 });
    }
  } catch (error) {
    stats.valid = false;
    stats.error = controller.signal.aborted ? 'DEADLINE' : code(error.code) || code(error.name) || 'ERROR';
    if (Number.isInteger(error.status)) stats.status = error.status;
    stats.provider_code = code(error.error?.code);
    // Never print error.message, raw payloads, final content, headers, keys or private reasoning.
  } finally {
    clearTimeout(timer); clearInterval(ticker); clearTimeout(counterfactual);
    try { stream?.controller?.abort(); } catch {}
    try { await dispatcher?.destroy(); } catch {}
    content = '';
    report('result');
    if (process.env.DIAG_MODE === 'B-original-long') {
      fs.mkdirSync('diagnostic-output', { recursive: true });
      fs.writeFileSync('diagnostic-output/metrics.json', JSON.stringify({ ...stats, elapsed_ms: Date.now() - started }, null, 2), { mode: 0o600 });
    }
  }
  return stats;
}
async function run(github) {
  const laneId = process.env.DIAG_LANE;
  if (!['B', 'C'].includes(laneId)) throw new Error('Only B/C allowed');
  const input = await getInput(github);
  const lane = input.config.lanes.find((l) => l.id === laneId);
  const credentials = { apiKey: process.env.DIAG_KEY, baseURL: process.env.DIAG_BASE };
  const payload = (model, extra = {}) => ({ model: model.id, messages: input.messages, stream: true,
    ...(model.omit_max_tokens ? {} : { max_tokens: model.max_output_tokens }), temperature: model.temperature, ...extra });
  const cases = process.env.DIAG_MODE === 'B-original-long' && laneId === 'B' ? [
    { label: 'B-auto-original-30min', payload: payload(lane.primary), timeoutMs: 1800000, originalDeadline: 360000 },
  ] : laneId === 'B' ? [
    { label: 'B-auto-original-extended', payload: payload(lane.primary), timeoutMs: 600000, originalDeadline: 360000 },
    { label: 'B-auto-low', payload: payload(lane.primary, { reasoning_effort: 'low' }), timeoutMs: 360000 },
    { label: 'B-pro-low', payload: payload(lane.fallbacks[0], { reasoning_effort: 'low' }), timeoutMs: 300000 },
  ] : [
    { label: 'C-flash-original', payload: payload(lane.primary), timeoutMs: 180000 },
    { label: 'C-lite-original-extended', payload: payload(lane.fallbacks[0]), timeoutMs: 300000, originalDeadline: 180000 },
  ];
  const results = [];
  for (const spec of cases) results.push(await probe(spec, credentials));
  log({ event: 'diagnostic_complete', lane: laneId, cases: results.length, valid_cases: results.filter((r) => r.valid).length,
    diagnostic_only: true, production_changed: false });
}
module.exports = { run, observeFields };
