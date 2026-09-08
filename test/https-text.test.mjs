import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { requestText, normalizeStream } = require('../review-action/src/https-text.js');
const event = (payload) => 'data: ' + JSON.stringify(payload) + '\r\n\r\n';
const streamText = ': heartbeat\r\n\r\n'
  + event({ model: 'auto', choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE' } }] })
  + event({ choices: [{ index: 0, delta: { content: '审核正文' } }] })
  + event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  + event({ choices: [], usage: { completion_tokens: 42 } })
  + 'data: [DONE]\r\n\r\n';
const parsed = JSON.parse(normalizeStream(streamText));
assert.equal(parsed.choices[0].message.content, '审核正文');
assert.equal(parsed.choices[0].message.reasoning_content, 'PRIVATE');
assert.equal(parsed.usage.completion_tokens, 42);
assert.throws(() => normalizeStream(event({ choices: [{ index: 0, delta: { content: 'partial' } }] })), /completion marker/);
assert.throws(() => normalizeStream('data: not-json\n\n'), SyntaxError);
assert.throws(() => normalizeStream(event({ error: { code: 'quota' } })), /API error/);
const delay = process.env.LONG_REVIEW_TRANSPORT_TEST === '1' ? 310000 : 50;
let redirected = false;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/delay') {
    assert.equal(req.method, 'POST');
    assert.equal(Buffer.concat(chunks).toString(), 'test review');
    setTimeout(() => res.end('审核正文'), delay);
  } else if (req.url === '/hang') {
    // The caller's absolute deadline must close this connection.
  } else if (req.url === '/stream' || req.url === '/stream-hang') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(streamText);
    // Byte fragments can split a UTF-8 character or an SSE separator.
    for (let offset = 0; offset < bytes.length; offset += 7) res.write(bytes.subarray(offset, offset + 7));
    if (req.url === '/stream') res.end();
  } else if (req.url === '/body-hang') {
    res.writeHead(200);
    res.write('partial body');
  } else if (req.url === '/partial') {
    res.writeHead(200);
    res.write('incomplete');
    setTimeout(() => res.destroy(), 10);
  } else if (req.url === '/large') {
    res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: '/credential-leak' });
    res.end('redirect refused');
  } else if (req.url === '/credential-leak') {
    redirected = true;
    res.end('unexpected');
  } else {
    res.writeHead(429);
    res.end('rate limited');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
// Exercise real HTTP sockets without weakening production TLS validation or
// shipping a private test certificate. Only this test injects node:http.
const transport = (url, options, callback) => http.request({
  ...options, hostname: '127.0.0.1', port: server.address().port,
  path: url.pathname,
}, callback);
const send = (route, signal = AbortSignal.timeout(360000)) =>
  requestText('https://example.test' + route, {
    signal, headers: { 'content-type': 'text/plain' }, body: 'test review',
  }, transport);
try {
  assert.throws(() => requestText('http://example.test', {}), /HTTPS/);
  assert.throws(() => requestText('https://user:secret@example.test', {}), /credentials/);
  assert.throws(() => requestText('https://example.test', {}), /deadline/);
  const started = Date.now();
  const result = await send('/delay');
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(await result.text(), '审核正文');
  console.log('ok delayed complete response elapsed_ms=' + (Date.now() - started));
  await assert.rejects(send('/hang', AbortSignal.timeout(30)), { name: 'AbortError' });
  await assert.rejects(send('/hang', AbortSignal.abort()), { name: 'AbortError' });
  await assert.rejects(send('/body-hang', AbortSignal.timeout(30)), /aborted|before its body completed/);
  assert.deepEqual(JSON.parse(await (await send('/stream')).text()), parsed);
  assert.deepEqual(JSON.parse(await (await send('/stream-hang', AbortSignal.timeout(1000))).text()), parsed);
  await assert.rejects(send('/partial'), /aborted|before its body completed/);
  await assert.rejects(send('/large'), { code: 'REVIEW_RESPONSE_TOO_LARGE' });
  const redirect = await send('/redirect');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.ok, false);
  assert.equal(redirected, false);
  const limited = await send('/limited');
  assert.equal(limited.status, 429);
  assert.equal(await limited.text(), 'rate limited');
  console.log('ok deadline, pre-abort, incomplete body, size cap, redirect refusal and HTTP errors');
} finally {
  server.closeAllConnections();
  server.close();
}
