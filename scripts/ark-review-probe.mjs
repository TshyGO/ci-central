import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

if (!process.env.ARK_KEY || !process.env.ARK_BASE) throw new Error('Missing Lane B credentials');
const endpoint = new URL(process.env.ARK_BASE.replace(/\/$/, '') + '/chat/completions');
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid HTTPS endpoint');
const fixture = `Review this synthetic patch. Return at most 4 lines in Chinese: file, concrete issue, impact and fix. If no issue, say so.
The application is multi-tenant. Invoices belong to a tenant, sessions contain tenantId.
File: invoice.ts
+ export function getInvoice(session, invoice) {
+   if (!session) throw new Error("unauthenticated");
+   return { amount: invoice.amount, customer: invoice.customer };
+ }
`;
const safeCode = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;

// One request per model, sequentially, never retries. Synthetic public fixture only.
for (const model of ['glm-5.3', 'deepseek-v4-pro-ga-260813', 'ark-code-latest']) {
  await new Promise((resolve) => {
    const started = Date.now(), timing = {};
    let finished = false, bytes = 0, content = '', reasoningChars = 0, finishReason, upstream, usage;
    let status, pending = '';
    const decoder = new StringDecoder('utf8');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const body = JSON.stringify({ model, stream: true, max_tokens: 8192, temperature: 0.2,
      messages: [{ role: 'system', content: 'Review code correctness and authorization. Give concise final findings; never expose private reasoning.' }, { role: 'user', content: fixture }] });
    const done = (outcome, errorCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const final = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      console.log(JSON.stringify({ model, outcome, status, elapsed_ms: Date.now() - started, timing, bytes,
        upstream, finishReason, reasoningChars, contentChars: final.length, usage, errorCode,
        review: outcome === 'complete' ? final.slice(0, 1200) : undefined }));
      resolve();
    };
    const consume = (frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') {
        done(finishReason === 'stop' && content.trim() ? 'complete' : 'incomplete');
        req.destroy();
        return;
      }
      const event = JSON.parse(data);
      if (event.error) { done('upstream_error', safeCode(event.error.code) || safeCode(event.error.type)); req.destroy(); return; }
      upstream = event.model || upstream;
      usage = event.usage || usage;
      const choice = event.choices?.find((entry) => entry.index === 0);
      if (!choice) return;
      if (typeof choice.delta?.content === 'string') content += choice.delta.content;
      if (typeof choice.delta?.reasoning_content === 'string') reasoningChars += choice.delta.reasoning_content.length;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    const req = https.request(endpoint, { method: 'POST', agent: false, signal: controller.signal,
      headers: { authorization: 'Bearer ' + process.env.ARK_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      status = res.statusCode; timing.headers_ms = Date.now() - started;
      if (status !== 200) { done('http_error'); res.destroy(); return; }
      res.on('data', (chunk) => {
        timing.first_byte_ms ??= Date.now() - started;
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { done('response_too_large'); req.destroy(); return; }
        pending += decoder.write(chunk);
        try {
          let match;
          while (!finished && (match = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            consume(frame);
          }
        } catch { done('parse_error'); req.destroy(); }
      });
      res.on('end', () => {
        try { pending += decoder.end(); if (pending.trim()) consume(pending); }
        catch { done('parse_error'); }
        done(finishReason === 'stop' && content.trim() ? 'complete' : 'incomplete');
      });
      res.on('error', (error) => done('body_error', safeCode(error.code)));
    });
    req.on('error', (error) => done(controller.signal.aborted ? 'deadline' : 'transport_error', safeCode(error.code)));
    req.end(body);
  });
}
