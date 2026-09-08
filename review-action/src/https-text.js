'use strict';

const https = require('node:https');

// Ark's non-streaming reviews may take longer than native fetch's hidden 300s
// headers timeout. Use a dedicated HTTPS request, bounded from connection through
// complete body by the caller's AbortSignal. No redirects, proxy mutation, or
// global dispatcher changes; credentials can only reach the configured URL.
function requestText(endpoint, { signal, headers, body }, request = https.request) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Review endpoint must be HTTPS without URL credentials.');
  }
  if (!signal) throw new Error('Review HTTPS request requires a deadline signal.');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', signal, headers, agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          const error = new Error('Review response exceeded 8 MiB.');
          error.code = 'REVIEW_RESPONSE_TOO_LARGE';
          reject(error);
          req.destroy(error);
          res.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('aborted', () => {
        const error = new Error('Review response ended before its body completed.');
        error.code = 'ECONNRESET';
        reject(error);
      });
      res.on('end', () => {
        const status = res.statusCode;
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status, ok: status >= 200 && status < 300, text: async () => text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { requestText };
