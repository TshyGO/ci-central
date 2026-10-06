'use strict';

const OpenAI = require('openai').default;
const { Agent, ProxyAgent, fetch: undiciFetch } = require('undici');

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
  if (protocol === 'openai-responses') return safeCode(event.type) || 'unknown';
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

// Only booleans leave this function; the tail itself may contain reasoning text.
function tailFacts(tail, bytes) {
  if (!bytes) return { done_marker: false, frame_boundary: null };
  const text = tail.toString('latin1');
  return {
    // JSON strings cannot hold a raw line break, so a line-initial marker is SSE framing.
    done_marker: /[\r\n]data: ?\[DONE\]/.test(text) || (bytes <= tail.length && /^data: ?\[DONE\]/.test(text)),
    frame_boundary: /[\r\n]*$/.exec(text)[0].replace(/\r\n/g, '\n').length >= 2,
  };
}

function usageCounts(usage) {
  return {
    input_tokens: safeCount(usage?.prompt_tokens ?? usage?.input_tokens),
    output_tokens: safeCount(usage?.completion_tokens ?? usage?.output_tokens),
    reasoning_tokens: safeCount(usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.output_tokens_details?.reasoning_tokens),
  };
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
    events: 0, last_event: null, trailer: null };
  const report = (entry) => { try { onProgress(entry); } catch { /* Diagnostics cannot alter review results. */ } };
  let stream;
  let dispatcher;
  let content = '';
  let usage;
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
    if (!['openai-chat-completions', 'openai-responses'].includes(protocol)) {
      const error = new Error('Unsupported SDK protocol.'); error.code = 'REVIEW_INVALID_PROTOCOL'; throw error;
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
    const options = {
      apiKey, baseURL,
      ...(sessionId ? { defaultHeaders: { 'user-agent': 'NebulaLab-CI-Review/1.0', 'x-opencode-session': sessionId } } : {}),
      maxRetries: 0, timeout: timeoutMs, logLevel: 'off',
      fetch: async (url, init) => {
        const response = await fetchImpl(url, { ...init, dispatcher, redirect: 'error' });
        timing.headers_ms = Date.now() - started;
        timing.status = response.status;
        report({ ...timing, event: 'headers' });
        // Bound the raw bytes, including malformed/unframed SSE, before the SDK
        // decoder buffers them, and record how the body itself ended. Framing and
        // JSON parsing remain the SDK's job.
        const source = response.body?.getReader();
        const observed = source && new ReadableStream({
          async pull(controller) {
            let result;
            try { result = await source.read(); } catch (error) {
              body.end ??= 'error'; body.error ??= describeError(error); body.ended_ms ??= Date.now() - started;
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
            controller.enqueue(chunk);
          },
          cancel(reason) {
            body.end ??= 'cancel'; body.ended_ms ??= Date.now() - started;
            return source.cancel(reason);
          },
        });
        return new Response(observed, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    };
    const client = new OpenAI({ ...options, organization: null, project: null });
    stream = protocol === 'openai-responses'
      ? await client.responses.create({ ...payload, stream: true }, { signal, maxRetries: 0 })
      : await client.chat.completions.create({ ...payload, stream: true }, { signal, maxRetries: 0 });
    const events = stream[Symbol.asyncIterator]();
    for (let next = await events.next(); !next.done; next = await events.next()) {
      const event = next.value;
      signal.throwIfAborted();
      body.events += 1;
      body.last_event = describeEvent(event, protocol);
      timing.first_event_ms ??= Date.now() - started;
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
      const { done_marker: doneMarker } = tailFacts(body.tail, timing.bytes);
      if (body.ended_ms !== null && timing.last_byte_ms !== null) timing.idle_before_end_ms = body.ended_ms - timing.last_byte_ms;
      timing.incomplete_end = body.end === 'error' ? 'transport_error'
        : doneMarker ? 'done_without_finish'
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
      /^(?:REVIEW|UND_ERR)_[A-Z_]+$|^E[A-Z]+$/.test(code || '') && `code=${code}`,
      Number.isInteger(timing.status) && `http=${timing.status}`,
      timing.incomplete_end && `end=${timing.incomplete_end}`,
      timing.incomplete_end && body.last_event && `last_event=${body.last_event.split(':')[0]}`,
      Number.isInteger(timing.idle_before_end_ms) && `idle_before_end_ms=${timing.idle_before_end_ms}`,
      timing.incomplete_end && body.error && `body_error=${body.error}`,
    ].filter(Boolean).join(', ');
    const sanitized = new Error(signal?.aborted ? 'AI endpoint request aborted (model deadline reached).'
      : `SDK request failed${detail ? ` (${detail})` : ''}.`);
    sanitized.name = signal?.aborted ? 'AbortError' : 'SDKRequestError';
    sanitized.code = code;
    sanitized.status = Number.isInteger(error.status) ? error.status : undefined;
    sanitized.providerCode = safeCode(error.error?.code) || code;
    sanitized.providerType = safeCode(error.error?.type);
    if (signal?.aborted) sanitized.code = 'REVIEW_DEADLINE';
    timing.error_code = code || (signal?.aborted ? 'DEADLINE' : 'SDK_ERROR');
    timing.error_name = safeCode(error.name) || 'unknown';
    timing.provider_code = sanitized.providerCode;
    timing.provider_type = sanitized.providerType;
    throw sanitized;
  } finally {
    clearInterval(progressTimer);
    try { stream?.controller?.abort(); } catch { timing.cleanup_error = 'STREAM_ABORT'; }
    // The dispatcher owns only this request. Destroy also cancels error bodies
    // and connections whose stream was never constructed.
    try { await dispatcher?.destroy(); } catch { timing.cleanup_error = 'DISPATCHER_DESTROY'; }
    timing.elapsed_ms = Date.now() - started;
    report({ ...timing, body_end: body.end, body_error: body.error, ...tailFacts(body.tail, timing.bytes),
      max_gap_ms: body.max_gap_ms, events: body.events, last_event: body.last_event, usage_trailer: body.trailer,
      ...usageCounts(usage), event: 'finished' });
  }
};
}

module.exports = { requestChatCompletion: createChatRequester(), createChatRequester };
