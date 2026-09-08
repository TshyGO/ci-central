'use strict';

const https = require('node:https');

// Ark's non-streaming reviews may take longer than native fetch's hidden 300s
// headers timeout. Use a dedicated HTTPS request, bounded from connection through
// complete body by the caller's AbortSignal. No redirects, proxy mutation, or
// global dispatcher changes; credentials can only reach the configured URL.
function requestText(endpoint, { signal, headers, body, onHeaders, onProgress }, request = https.request) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Review endpoint must be HTTPS without URL credentials.');
  }
  if (!signal) throw new Error('Review HTTPS request requires a deadline signal.');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', signal, headers, agent: false,
    }, (res) => {
      onHeaders?.(res.statusCode);
      const chunks = [];
      let size = 0;
      let nextProgress = 0;
      let tail = '';
      const status = res.statusCode;
      const ok = status >= 200 && status < 300;
      const isStream = ok && String(res.headers['content-type']).includes('text/event-stream');
      const finish = () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          const normalized = isStream ? normalizeStream(text) : text;
          resolve({ status, ok, text: async () => normalized });
        } catch (error) { reject(error); }
      };
      res.on('data', (chunk) => {
        size += chunk.length;
        if (Date.now() >= nextProgress) {
          onProgress?.(size);
          nextProgress = Date.now() + 60000;
        }
        if (size > 8 * 1024 * 1024) {
          const error = new Error('Review response exceeded 8 MiB.');
          error.code = 'REVIEW_RESPONSE_TOO_LARGE';
          reject(error);
          req.destroy(error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
        if (isStream) {
          // SSE completion is a protocol marker, not TCP EOF. Some gateways keep
          // sending heartbeats after [DONE]; do not wait out the whole deadline.
          const scan = tail + chunk.toString('latin1');
          tail = scan.slice(-64);
          if (/(?:^|\r?\n)data: ?\[DONE\]\r?\n\r?\n/.test(scan)) {
            finish();
            res.destroy();
          }
        }
      });
      res.on('error', reject);
      res.on('aborted', () => {
        const error = new Error('Review response ended before its body completed.');
        error.code = 'ECONNRESET';
        reject(error);
      });
      res.on('end', finish);
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Parse only after the bounded response finishes. No deltas or private reasoning
// are ever published. An interrupted/malformed stream cannot become valid evidence.
function normalizeStream(text) {
  let content = '', reasoning = '', model, usage, finish;
  for (const event of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (data === '[DONE]') break;
    if (!data) continue;
    const payload = JSON.parse(data);
    if (payload.error) throw new Error('Ark streaming response reported an API error.');
    model = payload.model || model;
    usage = payload.usage || usage;
    const choice = payload.choices?.find((item) => item.index === 0);
    if (!choice) continue;
    if (typeof choice.delta?.content === 'string') content += choice.delta.content;
    if (typeof choice.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
    if (choice.finish_reason != null) finish = choice.finish_reason;
  }
  if (!finish) throw new Error('Ark stream ended without a completion marker.');
  return JSON.stringify({ model, usage, choices: [{
    finish_reason: finish, message: { content, reasoning_content: reasoning },
  }] });
}

module.exports = { requestText, normalizeStream };
