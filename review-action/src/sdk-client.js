'use strict';

const OpenAI = require('openai').default;
const Anthropic = require('@anthropic-ai/sdk').default;
const { Agent, ProxyAgent, fetch: undiciFetch } = require('undici');

const PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-generate-content']);
// Only `stop` is a complete review; every other terminal reason keeps its own name.
const ANTHROPIC_FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };
const GEMINI_FINISH = { STOP: 'stop', MAX_TOKENS: 'length' };
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Compatible gateways stream token usage after choice 0's finish_reason. Read it
// for at most this long; it is accounting only and never changes a final review.
const USAGE_TRAILER_GRACE_MS = 1000;
// A clean close after this much body silence is an idle close, not a cut mid-generation.
const IDLE_CLOSE_MS = 60000;
const TAIL_BYTES = 1024;
const ENVELOPE_KEYS = new Set(['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier', 'choices', 'usage']);
const safeCode = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;
const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function describeError(error) {
  let code;
  for (let cause = error, depth = 0; cause && depth < 5 && !code; depth++, cause = cause.cause) code = safeCode(cause.code);
  const name = safeCode(error?.name) || 'unknown';
  return code ? `${name}/${code}` : name;
}

// Shape of an SSE event without its text: separates a cut during reasoning from
// a usage trailer, a gateway cost frame or an unrecognized in-band error.
function describeEvent(event, protocol) {
  if (!event || typeof event !== 'object') return 'non_object';
  if (protocol === 'openai-responses' || protocol === 'anthropic-messages') return safeCode(event.type) || 'unknown';
  if (protocol === 'google-generate-content') {
    const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
    if (typeof candidate?.finishReason === 'string' && candidate.finishReason) return 'finish';
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    if (parts.some((part) => !part?.thought && typeof part?.text === 'string' && part.text)) return 'content';
    if (parts.some((part) => part?.thought)) return 'reasoning';
    return event.usageMetadata ? 'usage' : 'empty_delta';
  }
  const choice = Array.isArray(event.choices) ? event.choices.find((item) => item?.index === 0) : undefined;
  if (!choice) {
    if (event.usage) return 'usage';
    const keys = Object.keys(event).filter((key) => !ENVELOPE_KEYS.has(key)).map(safeCode).filter(Boolean).sort();
    return `no_choice:${keys.slice(0, 6).join('+') || 'none'}`.slice(0, 120);
  }
  if (typeof choice.finish_reason === 'string' && choice.finish_reason.trim()) return 'finish';
  if (typeof choice.delta?.content === 'string' && choice.delta.content) return 'content';
  const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
  return typeof reasoning === 'string' && reasoning ? 'reasoning' : 'empty_delta';
}

function appendTail(tail, chunk) {
  const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (bytes.length >= TAIL_BYTES) return Buffer.from(bytes.subarray(bytes.length - TAIL_BYTES));
  const joined = Buffer.concat([tail, bytes]);
  return joined.length > TAIL_BYTES ? joined.subarray(joined.length - TAIL_BYTES) : joined;
}

// Only a boolean leaves this function; the tail itself may contain reasoning text.
function tailFacts(tail, bytes) {
  if (!bytes) return { frame_boundary: null };
  return { frame_boundary: /[\r\n]*$/.exec(tail.toString('latin1'))[0].replace(/\r\n/g, '\n').length >= 2 };
}

// JSON strings cannot hold a raw line break, so a line-initial marker is SSE framing.
// Scanned per chunk with a short carry, so trailing frames cannot push it out of view.
const DONE_LINE = /[\r\n]data: ?\[DONE\](?=[\r\n]|$)/;

function usageCounts(usage) {
  // Gemini reports visible and thought tokens separately; output is their sum.
  const geminiOutput = Number.isSafeInteger(usage?.candidatesTokenCount)
    ? usage.candidatesTokenCount + (Number.isSafeInteger(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : 0) : undefined;
  return {
    input_tokens: safeCount(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount),
    output_tokens: safeCount(usage?.completion_tokens ?? usage?.output_tokens ?? geminiOutput),
    reasoning_tokens: safeCount(usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.output_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.thinking_tokens
      ?? usage?.thoughtsTokenCount),
  };
}

// An exhausted plan or usage limit, told apart from a rate limit by the provider's own words.
// Command Code answers it as 429 RATE_LIMITED and says "weekly usage limit ... resets at <time>"
// only in the message; Go names a *UsageLimitError and puts the wait in retry-after. Only a
// boolean, a closed-vocabulary window and a checked timestamp leave; never the message itself.
// Long and short forms alike: "5-hour", "5 hours", "5h", "rolling_5h"; "weekly", "7-day", "7d".
const QUOTA_WINDOWS = [['5h', /\b(?:5|five)[- ]?h(?:(?:ou)?rs?)?\b/i], ['weekly', /\bweek(?:ly)?\b|\b7[- ]?d(?:ays?)?\b/i],
  ['monthly', /\bmonth(?:ly)?\b|\b30[- ]?d(?:ays?)?\b/i], ['daily', /\bdaily\b|\b24[- ]?h(?:(?:ou)?rs?)?\b/i]];
const QUOTA_RESET_HORIZON_MS = 45 * 86400000;
// A per-minute or per-second limit is a rate limit, however it is worded ("quota exceeded for
// requests per minute"). Kept in step with the runner's raw-text check.
const RATE_WINDOW = /\bper[- ]?(?:minute|min|second|sec)\b|\b(?:requests|tokens)[- ]per[- ](?:minute|second)\b|\b[rt]p[ms]\b/i;
// A generic "usage limit" or "quota exceeded" names a spent plan only next to plan, billing,
// reset or window wording; a code that names the plan needs none.
const PLAN_WORDING = /\b(?:plan|billing|subscription|resets?)\b/i;
// Go puts the plan window in a top-level metadata.limitName that the OpenAI SDK drops from its error
// (it keeps only body.error), so the client reads that one field from the raw error body.
const ERROR_BODY_PEEK_BYTES = 65536;
function planQuota(error, providerError, body, peekedLimitName) {
  if (![402, 403, 429].includes(error?.status)) return { exhausted: false };
  const words = [providerError?.message, error?.message].filter((value) => typeof value === 'string')
    .map((value) => value.slice(0, 4000)).join('\n');
  const codes = [providerError?.type, providerError?.code, error?.code].filter((value) => typeof value === 'string');
  const planCode = codes.some((value) => /usagelimiterror$|^insufficient_quota$/i.test(value));
  const quotaCode = codes.some((value) => /^quota_exceeded$/i.test(value));
  const rawLimitName = typeof body?.metadata?.limitName === 'string' ? body.metadata.limitName : peekedLimitName;
  const limitName = typeof rawLimitName === 'string' ? rawLimitName.slice(0, 80).replace(/[_-]/g, ' ') : '';
  const planWorded = PLAN_WORDING.test(words) || [limitName, words].some((text) => QUOTA_WINDOWS.some(([, pattern]) => pattern.test(text)));
  const quotaWorded = /\busage limit\b|insufficient[_ ]quota|exceeded your current quota/i.test(words)
    || /\bquota\b[^.\n]{0,60}\b(?:exhausted|exceeded|reached|used up|depleted)\b/i.test(words);
  const exhausted = planCode || (!RATE_WINDOW.test(words) && (quotaCode || (quotaWorded && planWorded)));
  if (!exhausted) return { exhausted: false };
  // The word right before "usage limit" names the window; a later "resets in 5 hours" does not.
  const statedWindow = /([\w-]+)\s+(?:usage\s+)?limit\b/i.exec(words)?.[1] ?? '';
  const window = [limitName, statedWindow, words]
    .map((text) => QUOTA_WINDOWS.find(([, pattern]) => pattern.test(text))?.[0]).find(Boolean);
  const stated = /\breset[s]?\b[^\n]{0,40}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(words)?.[1];
  const retryAfter = String(error?.headers?.get?.('retry-after') ?? '').trim();
  const reset = stated ? Date.parse(stated)
    : /^\d{1,8}$/.test(retryAfter) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  const resetAt = Number.isFinite(reset) && reset > Date.now() - 60000 && reset < Date.now() + QUOTA_RESET_HORIZON_MS
    ? new Date(reset).toISOString() : undefined;
  return { exhausted: true, window, resetAt };
}

// Anthropic SDKs append /v1/messages to their base; Lane bases end in /v1 like the OpenAI ones.
function anthropicBaseURL(endpoint) {
  const path = endpoint.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/v1')) {
    const error = new Error('Invalid SDK HTTPS endpoint.'); error.code = 'REVIEW_INVALID_ENDPOINT'; throw error;
  }
  return `${endpoint.origin}${path.slice(0, -'/v1'.length)}`;
}

// Gemini SSE frames are single JSON objects; a frame that is not JSON is a broken stream.
async function* geminiEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (frame) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return undefined;
    try { return JSON.parse(data); } catch {
      const error = new Error('Gemini stream frame was not JSON.'); error.code = 'REVIEW_INVALID_STREAM'; throw error;
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let match = /\r?\n\r?\n/.exec(buffer); match; match = /\r?\n\r?\n/.exec(buffer)) {
        const event = parse(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (event !== undefined) yield event;
      }
    }
    const event = parse(buffer + decoder.decode());
    if (event !== undefined) yield event;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function geminiRejection(response) {
  let parsed;
  try { parsed = JSON.parse(await response.text()); } catch { /* Status alone is enough. */ }
  // Google streaming endpoints may wrap the error object in an array.
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  const inner = envelope?.error && typeof envelope.error === 'object' ? envelope.error : undefined;
  const error = new Error('Gemini request was rejected.');
  error.status = response.status;
  error.headers = response.headers;
  // Keep string codes such as insufficient_quota: quota classification depends on them.
  error.error = { code: safeCode(inner?.status) || safeCode(inner?.code)
    || (Number.isSafeInteger(inner?.code) ? String(inner.code) : undefined), type: inner?.type };
  return error;
}

// The review is already final when this runs: wait briefly, ignore errors, never fail it.
// The request deadline still applies: its abort ends the SDK iterator, and a next()
// left pending by the grace timer is settled by the stream abort in the caller's cleanup.
async function readUsageTrailer(events, graceMs) {
  const deadline = Date.now() + graceMs;
  let timer;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout' };
      const next = events.next();
      next.catch(() => {});
      const result = await Promise.race([next, new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
      clearTimeout(timer);
      if (!result) return { status: 'timeout' };
      if (result.done) return { status: 'end' };
      if (result.value?.usage) return { status: 'usage', usage: result.value.usage };
    }
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// One SDK client per request: credentials, connection settings and cancellation
// cannot bleed between lanes. Retry/fallback orchestration stays in the workflow.
function createChatRequester({ createDispatcher = (options) => new Agent(options),
  createProxyDispatcher = (options) => new ProxyAgent(options), fetch: fetchImpl = undiciFetch,
  usageTrailerGraceMs = USAGE_TRAILER_GRACE_MS, idleCloseMs = IDLE_CLOSE_MS } = {}) {
return async function requestChatCompletion({ apiKey, baseURL, payload, signal, timeoutMs,
  protocol = 'openai-chat-completions', sessionId, proxyUrl, onProgress = () => {} }) {
  const started = Date.now();
  const timing = { transport: 'openai-sdk', headers_ms: null, first_event_ms: null, first_content_ms: null,
    last_byte_ms: null, elapsed_ms: 0, bytes: 0, content_chars: 0, reasoning_chars: 0, finish_reason: null, upstream: null };
  // The SDK ends iteration silently on clean EOF, [DONE] and a transport
  // AbortError alike; only the raw body can tell those terminations apart.
  const body = { end: null, error: null, ended_ms: null, max_gap_ms: 0, tail: Buffer.alloc(0),
    done_marker: false, carry: '\n', events: 0, last_event: null, trailer: null };
  const report = (entry) => { try { onProgress(entry); } catch { /* Diagnostics cannot alter review results. */ } };
  let stream;
  let events;
  let dispatcher;
  let content = '';
  let usage;
  let peekedLimitName;
  const progressTimer = setInterval(() => {
    timing.elapsed_ms = Date.now() - started;
    report({ ...timing, event: 'progress' });
  }, 30000);
  progressTimer.unref();
  try {
    let endpoint;
    try { endpoint = new URL(baseURL); } catch {
      const error = new Error('Invalid SDK HTTPS endpoint.'); error.code = 'REVIEW_INVALID_ENDPOINT'; throw error;
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      const error = new Error('Invalid SDK HTTPS endpoint.'); error.code = 'REVIEW_INVALID_ENDPOINT'; throw error;
    }
    if (!signal || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
      const error = new Error('SDK request requires a deadline.'); error.code = 'REVIEW_INVALID_DEADLINE'; throw error;
    }
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      const error = new Error('SDK request requires an explicit Lane key.'); error.code = 'REVIEW_INVALID_CREDENTIAL'; throw error;
    }
    if (!PROTOCOLS.has(protocol)) {
      const error = new Error('Unsupported SDK protocol.'); error.code = 'REVIEW_INVALID_PROTOCOL'; throw error;
    }
    const sdkBaseURL = protocol === 'anthropic-messages' ? anthropicBaseURL(endpoint) : baseURL;
    if (protocol === 'google-generate-content'
        && (typeof payload?.model !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(payload.model))) {
      const error = new Error('Gemini request requires a model id.'); error.code = 'REVIEW_INVALID_MODEL'; throw error;
    }
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(sessionId))) {
      const error = new Error('Invalid coding session identifier.'); error.code = 'REVIEW_INVALID_SESSION'; throw error;
    }
    if (proxyUrl !== undefined) {
      let proxy;
      try { proxy = new URL(proxyUrl); } catch { /* reject below */ }
      if (!proxy || !['http:', 'https:'].includes(proxy.protocol) || proxy.search || proxy.hash || !['', '/'].includes(proxy.pathname)) {
        const error = new Error('Invalid explicit proxy.'); error.code = 'REVIEW_INVALID_PROXY'; throw error;
      }
    }
    const connectionOptions = {
      headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
      connectTimeout: Math.min(30000, timeoutMs),
      // Cross-region endpoints can exceed Node's 250ms per-address default.
      // Address selection is connection setup, not an extra inference attempt.
      autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1000,
    };
    dispatcher = proxyUrl === undefined ? createDispatcher(connectionOptions)
      : createProxyDispatcher({ ...connectionOptions, uri: proxyUrl });
    const sessionHeaders = sessionId ? { 'user-agent': 'NebulaLab-CI-Review/1.0', 'x-opencode-session': sessionId } : undefined;
    const observedFetch = async (url, init) => {
      const response = await fetchImpl(url, { ...init, dispatcher, redirect: 'error' });
      timing.headers_ms = Date.now() - started;
      timing.status = response.status;
      report({ ...timing, event: 'headers' });
      if (response.status >= 400 && response.body) {
        // An error body is small and final. A bounded copy is read here so that Go's plan window
        // (metadata.limitName) survives the SDK; only that one short field is kept.
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            size += value.byteLength;
            if (size >= ERROR_BODY_PEEK_BYTES) { reader.cancel().catch(() => {}); break; }
          }
        } catch { /* A body cut off mid-read still carries its HTTP status; keep what arrived. */ }
        const text = Buffer.concat(chunks).subarray(0, ERROR_BODY_PEEK_BYTES).toString('utf8');
        try {
          const limitName = JSON.parse(text)?.metadata?.limitName;
          if (typeof limitName === 'string') peekedLimitName = limitName.slice(0, 80);
        } catch { /* Not JSON: there is no plan metadata to keep. */ }
        timing.bytes += size;
        return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      // Bound the raw bytes, including malformed/unframed SSE, before the SDK
      // decoder buffers them, and record how the body itself ended. Framing and
      // JSON parsing remain the SDK's job.
      const source = response.body?.getReader();
      const observed = source && new ReadableStream({
        async pull(controller) {
          let result;
          try { result = await source.read(); } catch (error) {
            if (body.end === null) {
              body.end = 'error'; body.error = describeError(error); body.ended_ms = Date.now() - started;
            }
            throw error;
          }
          if (result.done) {
            body.end ??= 'eof'; body.ended_ms ??= Date.now() - started;
            controller.close();
            return;
          }
          const chunk = result.value;
          const now = Date.now() - started;
          if (timing.last_byte_ms !== null) body.max_gap_ms = Math.max(body.max_gap_ms, now - timing.last_byte_ms);
          timing.last_byte_ms = now;
          timing.bytes += chunk.byteLength;
          if (timing.bytes > MAX_RESPONSE_BYTES) {
            const error = new Error('SDK response exceeded byte limit.');
            error.code = 'REVIEW_RESPONSE_TOO_LARGE';
            body.end ??= 'error'; body.error ??= describeError(error); body.ended_ms ??= now;
            source.cancel(error).catch(() => {});
            throw error;
          }
          body.tail = appendTail(body.tail, chunk);
          const scanned = body.carry + Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1');
          body.done_marker ||= DONE_LINE.test(scanned);
          body.carry = scanned.slice(-16);
          controller.enqueue(chunk);
        },
        cancel(reason) {
          body.end ??= 'cancel'; body.ended_ms ??= Date.now() - started;
          return source.cancel(reason);
        },
      });
      return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const options = {
      apiKey, baseURL: sdkBaseURL,
      ...(sessionHeaders ? { defaultHeaders: sessionHeaders } : {}),
      maxRetries: 0, timeout: timeoutMs, logLevel: 'off',
      fetch: observedFetch,
    };
    if (protocol === 'google-generate-content') {
      // No official SDK is bundled for Gemini; this is the documented streaming REST call.
      timing.transport = 'gemini-sse';
      const { model, ...request } = payload;
      const response = await observedFetch(`${baseURL.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-goog-api-key': apiKey, ...sessionHeaders },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw await geminiRejection(response);
      events = geminiEvents(response);
    } else if (protocol === 'anthropic-messages') {
      timing.transport = 'anthropic-sdk';
      // Explicit null keeps ANTHROPIC_AUTH_TOKEN from adding a second credential.
      const client = new Anthropic({ ...options, authToken: null });
      stream = await client.messages.create({ ...payload, stream: true }, { signal, maxRetries: 0 });
      events = stream[Symbol.asyncIterator]();
    } else {
      const client = new OpenAI({ ...options, organization: null, project: null });
      stream = protocol === 'openai-responses'
        ? await client.responses.create({ ...payload, stream: true }, { signal, maxRetries: 0 })
        : await client.chat.completions.create({ ...payload, stream: true }, { signal, maxRetries: 0 });
      events = stream[Symbol.asyncIterator]();
    }
    for (let next = await events.next(); !next.done; next = await events.next()) {
      const event = next.value;
      signal.throwIfAborted();
      body.events += 1;
      body.last_event = describeEvent(event, protocol);
      timing.first_event_ms ??= Date.now() - started;
      if (protocol === 'anthropic-messages') {
        if (event.type === 'message_start') {
          timing.upstream = safeCode(event.message?.model) || timing.upstream;
          usage = { ...event.message?.usage };
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          if (event.delta.text) timing.first_content_ms ??= Date.now() - started;
          content += event.delta.text;
          timing.content_chars = content.length;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          timing.reasoning_chars += event.delta.thinking.length;
        }
        if (event.type === 'message_delta') {
          // message_delta carries cumulative output usage; a zero there never replaces a
          // count message_start already reported (some gateways zero-fill input fields).
          for (const [key, value] of Object.entries(event.usage || {})) {
            if (value === null || value === undefined || (value === 0 && usage?.[key] > 0)) continue;
            usage = { ...usage, [key]: value };
          }
          const stop = event.delta?.stop_reason;
          if (typeof stop === 'string' && stop) {
            timing.finish_reason = ANTHROPIC_FINISH[stop] || safeCode(stop) || 'unknown';
            break;
          }
        }
        continue;
      }
      if (protocol === 'google-generate-content') {
        timing.upstream = safeCode(event.modelVersion) || timing.upstream;
        usage = event.usageMetadata || usage;
        const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
        for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
          if (typeof part?.text !== 'string') continue;
          if (part.thought) { timing.reasoning_chars += part.text.length; continue; }
          if (part.text) timing.first_content_ms ??= Date.now() - started;
          content += part.text;
          timing.content_chars = content.length;
        }
        // A finishReason is completion evidence; a Gemini stream may stay open after it.
        if (typeof candidate?.finishReason === 'string' && candidate.finishReason) {
          timing.finish_reason = GEMINI_FINISH[candidate.finishReason] || safeCode(candidate.finishReason.toLowerCase()) || 'unknown';
          break;
        }
        continue;
      }
      if (protocol === 'openai-responses') {
        timing.upstream = safeCode(event.response?.model) || timing.upstream;
        usage = event.response?.usage || usage;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          if (event.delta) timing.first_content_ms ??= Date.now() - started;
          content += event.delta;
          timing.content_chars = content.length;
        }
        if (event.type === 'response.reasoning_text.delta' && typeof event.delta === 'string') timing.reasoning_chars += event.delta.length;
        if (event.type === 'response.completed' && event.response?.status === 'completed') {
          const output = event.response.output;
          if (Array.isArray(output)) {
            content = output.filter((item) => item.type === 'message')
              .flatMap((item) => Array.isArray(item.content) ? item.content : [])
              .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
              .map((part) => part.text).join('\n');
            if (content) timing.first_content_ms ??= Date.now() - started;
            timing.content_chars = content.length;
          }
          timing.finish_reason = Array.isArray(output) && output.some((item) => item.type !== 'message' && item.type !== 'reasoning') ? 'tool_calls' : 'stop';
          break;
        }
        if (event.type === 'response.incomplete') {
          timing.finish_reason = event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'incomplete';
          break;
        }
        if (event.type === 'response.failed' || event.type === 'error') {
          const error = new Error('Responses stream failed.');
          error.code = safeCode(event.response?.error?.code || event.code) || 'REVIEW_RESPONSE_FAILED';
          throw error;
        }
        continue;
      }
      timing.upstream = safeCode(event.model) || timing.upstream;
      usage = event.usage || usage;
      const choice = event.choices?.find((item) => item.index === 0);
      if (choice) {
        if (typeof choice.delta?.content === 'string') {
          if (choice.delta.content) timing.first_content_ms ??= Date.now() - started;
          content += choice.delta.content;
          timing.content_chars = content.length;
        }
        // SenseNova uses `reasoning`; count either representation without storing it.
        // Prefer the canonical field if a gateway duplicates both fields.
        const reasoning = typeof choice.delta?.reasoning_content === 'string'
          ? choice.delta.reasoning_content : choice.delta?.reasoning;
        if (typeof reasoning === 'string') timing.reasoning_chars += reasoning.length;
        // Some compatible gateways send an empty finish_reason on ordinary
        // deltas. It is not a terminal event and must not truncate the review.
        if (typeof choice.finish_reason === 'string' && choice.finish_reason.trim()) {
          timing.finish_reason = safeCode(choice.finish_reason.trim()) || 'unknown';
          // A finish_reason on choice 0 is completion evidence. Do not wait for
          // [DONE], heartbeats or TCP EOF after it has arrived.
          break;
        }
      }
    }
    if (timing.finish_reason && protocol === 'openai-chat-completions' && !usage) {
      const trailer = await readUsageTrailer(events, usageTrailerGraceMs);
      body.trailer = trailer.status;
      usage = trailer.usage || usage;
    }
    if (!timing.finish_reason) {
      signal.throwIfAborted();
      if (body.ended_ms !== null && timing.last_byte_ms !== null) timing.idle_before_end_ms = body.ended_ms - timing.last_byte_ms;
      timing.incomplete_end = body.end === 'error' ? 'transport_error'
        : body.done_marker ? 'done_without_finish'
          : body.end === 'eof' ? (timing.idle_before_end_ms >= idleCloseMs ? 'idle_close' : 'clean_close')
            : 'unknown';
      const error = new Error('SDK stream ended without a finish_reason.');
      error.code = 'REVIEW_INCOMPLETE_STREAM';
      throw error;
    }
    const result = { model: timing.upstream || payload.model, usage,
      reasoning_chars: timing.reasoning_chars,
      choices: [{ finish_reason: timing.finish_reason, message: { content } }] };
    return { ok: true, status: timing.status, text: async () => JSON.stringify(result) };
  } catch (error) {
    // SDK errors can embed URL, headers, response bodies or reasoning. Expose
    // only bounded machine codes, HTTP status and the abort state to the caller.
    let cause = error;
    let code;
    for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) code ||= safeCode(cause.code);
    // The message reaches the PR comment, so it carries only local vocabulary:
    // our own/transport codes, HTTP status and the observed stream termination.
    const detail = [
      /^(?:REVIEW|UND_ERR)_[A-Z_]+$|^E[A-Z_]+$/.test(code || '') && `code=${code}`,
      Number.isInteger(timing.status) && `http=${timing.status}`,
      timing.incomplete_end && `end=${timing.incomplete_end}`,
      timing.incomplete_end && body.last_event && `last_event=${body.last_event.split(':')[0]}`,
      Number.isInteger(timing.idle_before_end_ms) && `idle_before_end_ms=${timing.idle_before_end_ms}`,
      timing.incomplete_end && /^[A-Za-z]+(?:\/(?:(?:REVIEW|UND_ERR)_[A-Z_]+|E[A-Z_]+))?$/.test(body.error || '')
        && `body_error=${body.error}`,
    ].filter(Boolean).join(', ');
    const sanitized = new Error(signal?.aborted ? 'AI endpoint request aborted (model deadline reached).'
      : `SDK request failed${detail ? ` (${detail})` : ''}.`);
    sanitized.name = signal?.aborted ? 'AbortError' : 'SDKRequestError';
    sanitized.code = code;
    sanitized.status = Number.isInteger(error.status) ? error.status : undefined;
    // Anthropic error bodies nest the provider error one level deeper than OpenAI's.
    const providerError = error.error?.error && typeof error.error.error === 'object' ? error.error.error : error.error;
    sanitized.providerCode = safeCode(providerError?.code) || code;
    sanitized.providerType = safeCode(providerError?.type);
    // Only a boolean leaves: Anthropic reports an exhausted credit balance as 402 billing_error,
    // or as a 400 whose message says the credit balance is too low.
    sanitized.creditExhausted = sanitized.status === 402 || providerError?.type === 'billing_error'
      || /credit balance is too low/i.test(typeof providerError?.message === 'string' ? providerError.message : '');
    // The Anthropic SDK keeps the whole error body, where Go adds the plan metadata.
    const quota = planQuota(error, providerError, error.error, peekedLimitName);
    sanitized.quotaExhausted = quota.exhausted;
    sanitized.quotaWindow = quota.window;
    sanitized.quotaResetAt = quota.resetAt;
    if (quota.exhausted) Object.assign(timing, { quota_exhausted: true, quota_window: quota.window ?? null, quota_reset_at: quota.resetAt ?? null });
    if (signal?.aborted) sanitized.code = 'REVIEW_DEADLINE';
    sanitized.httpStatus = Number.isInteger(timing.status) ? timing.status : undefined;
    // No model output reached us (rejected, or queued and closed before any token),
    // so a resend cannot duplicate a review. Responses, Messages and Gemini streams
    // count any event, because their thinking may stream without visible text.
    sanitized.unserved = !signal?.aborted && !timing.finish_reason && timing.content_chars === 0
      && timing.reasoning_chars === 0 && (protocol === 'openai-chat-completions' || body.events === 0);
    const retryAfter = Number(error?.headers?.get?.('retry-after'));
    if (Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 600) sanitized.retryAfterMs = retryAfter * 1000;
    timing.unserved = sanitized.unserved;
    timing.error_code = code || (signal?.aborted ? 'DEADLINE' : 'SDK_ERROR');
    timing.error_name = safeCode(error.name) || 'unknown';
    timing.provider_code = sanitized.providerCode;
    timing.provider_type = sanitized.providerType;
    throw sanitized;
  } finally {
    clearInterval(progressTimer);
    // Our own cleanup abort must not be logged as a transport error on the body.
    body.end ??= 'cancel'; body.ended_ms ??= Date.now() - started;
    try { stream?.controller?.abort(); } catch { timing.cleanup_error = 'STREAM_ABORT'; }
    // Settle the SDK iterator as `for await` would; the abort above keeps this from waiting.
    try { Promise.resolve(events?.return?.()).catch(() => {}); } catch { timing.cleanup_error = 'ITERATOR_RETURN'; }
    // The dispatcher owns only this request. Destroy also cancels error bodies
    // and connections whose stream was never constructed.
    try { await dispatcher?.destroy(); } catch { timing.cleanup_error = 'DISPATCHER_DESTROY'; }
    timing.elapsed_ms = Date.now() - started;
    report({ ...timing, body_end: body.end, body_error: body.error, done_marker: body.done_marker, ...tailFacts(body.tail, timing.bytes),
      max_gap_ms: body.max_gap_ms, events: body.events, last_event: body.last_event, usage_trailer: body.trailer,
      ...usageCounts(usage), event: 'finished' });
  }
};
}

module.exports = { requestChatCompletion: createChatRequester(), createChatRequester };
