'use strict';
const { requestChatCompletion } = require('../review-action/dist/sdk-client.js');
const BASE = 'https://opencode.ai/zen/go/v1';
const emit = (x) => console.log(JSON.stringify(x));
const safeCode = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(s) ? s : undefined;
async function boundedBody(response) {
  const reader = response.body.getReader();
  let bytes = 0, result = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('body_limit');
      result += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(result + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
async function jsonProbe(label, path, init, timeoutMs) {
  const started = Date.now();
  try {
    const response = await fetch(BASE + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    let data;
    try { data = await boundedBody(response); } catch {}
    const error = data?.error;
    const text = (Array.isArray(data?.content) ? data.content.filter(p => p.type === 'text').map(p => p.text).join('') : '');
    emit({ test: label, status: response.status, elapsed_ms: Date.now() - started,
      code: safeCode(error?.code || error?.type || error?.name || data?.name),
      model_list_present: Array.isArray(data?.data),
      selected_models: Array.isArray(data?.data) ? data.data.map(m => m.id).filter(id => ['glm-5.3-flash','qwen3.8-max'].includes(id)) : undefined,
      finish_reason: safeCode(data?.stop_reason), content_chars: text.length,
      sentinel_present: text.includes('GO_RUNNER_OK') });
  } catch (e) {
    emit({ test: label, elapsed_ms: Date.now() - started, error: safeCode(e.name), cause: safeCode(e.cause?.code) });
  }
}
module.exports = async function run() {
  emit({ event: 'environment', runner: process.env.RUNNER_NAME, node: process.version,
    production_changed: false, provider: 'opencode-go' });
  await jsonProbe('public-models-direct', '/models', { method: 'GET' }, 30000);
  const configured = (process.env.GO_SAVED_BASE || '').trim().replace(/\/+$/, '');
  const key = process.env.GO_SAVED_KEY;
  const matched = configured === BASE;
  emit({ event: 'credential_guard', saved_base_is_opencode_go: matched, key_present: Boolean(key?.trim()) });
  if (!matched || !key?.trim()) {
    await jsonProbe('chat-auth-boundary-no-key', '/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 16, messages: [{ role: 'user', content: 'Reply GO_RUNNER_OK' }] }) }, 30000);
    emit({ event: 'generation_skipped', reason: 'No verified Go credential pair; no unrelated key transmitted' });
    return;
  }
  const started = Date.now();
  try {
    const response = await requestChatCompletion({ apiKey: key, baseURL: BASE,
      payload: { model: 'glm-5.3-flash', stream: true, max_tokens: 2048,
        messages: [{ role: 'user', content: 'Reply with exactly GO_RUNNER_OK, no other text.' }] },
      timeoutMs: 120000, signal: AbortSignal.timeout(120000) });
    const body = JSON.parse(await response.text());
    const text = body.choices?.[0]?.message?.content || '';
    emit({ test: 'glm-chat-sdk', status: response.status, elapsed_ms: Date.now() - started,
      finish_reason: safeCode(body.choices?.[0]?.finish_reason), content_chars: text.length,
      sentinel_present: text.includes('GO_RUNNER_OK') });
  } catch (e) {
    emit({ test: 'glm-chat-sdk', elapsed_ms: Date.now() - started, status: e.status,
      code: safeCode(e.providerCode || e.code), error: safeCode(e.name) });
  }
  await jsonProbe('qwen-anthropic-messages', '/messages', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'qwen3.8-max', max_tokens: 2048,
      messages: [{ role: 'user', content: 'Reply with exactly GO_RUNNER_OK, no other text.' }] }) }, 120000);
};
