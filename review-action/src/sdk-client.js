'use strict';

const OpenAI = require('openai').default;
const { Agent, ProxyAgent, fetch: undiciFetch } = require('undici');

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const safeCode = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;

// One SDK client per request: credentials, connection settings and cancellation
// cannot bleed between lanes. Retry/fallback orchestration stays in the workflow.
function createChatRequester({ createDispatcher = (options) => new Agent(options),
  createProxyDispatcher = (options) => new ProxyAgent(options) } = {}) {
return async function requestChatCompletion({ apiKey, baseURL, payload, signal, timeoutMs,
  protocol = 'openai-chat-completions', sessionId, proxyUrl, onProgress = () => {} }) {
  const started = Date.now();
  const timing = { transport: 'openai-sdk', headers_ms: null, first_event_ms: null, first_content_ms: null,
    elapsed_ms: 0, bytes: 0, content_chars: 0, reasoning_chars: 0, finish_reason: null, upstream: null };
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
        const response = await undiciFetch(url, { ...init, dispatcher, redirect: 'error' });
        timing.headers_ms = Date.now() - started;
        timing.status = response.status;
        report({ ...timing, event: 'headers' });
        // Bound the raw bytes, including malformed/unframed SSE, before the SDK
        // decoder buffers them. Framing and JSON parsing remain the SDK's job.
        const bounded = response.body?.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            timing.bytes += chunk.byteLength;
            if (timing.bytes > MAX_RESPONSE_BYTES) {
              const error = new Error('SDK response exceeded byte limit.');
              error.code = 'REVIEW_RESPONSE_TOO_LARGE';
              throw error;
            }
            controller.enqueue(chunk);
          },
        }));
        return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    };
    const client = new OpenAI({ ...options, organization: null, project: null });
    stream = protocol === 'openai-responses'
      ? await client.responses.create({ ...payload, stream: true }, { signal, maxRetries: 0 })
      : await client.chat.completions.create({ ...payload, stream: true }, { signal, maxRetries: 0 });
    for await (const event of stream) {
      signal.throwIfAborted();
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
          // [DONE], usage trailers, heartbeats or TCP EOF after it has arrived.
          break;
        }
      }
    }
    if (!timing.finish_reason) {
      signal.throwIfAborted();
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
    const sanitized = new Error(signal?.aborted ? 'AI endpoint request aborted (model deadline reached).' : 'SDK request failed.');
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
    report({ ...timing, event: 'finished' });
  }
};
}

module.exports = { requestChatCompletion: createChatRequester(), createChatRequester };
