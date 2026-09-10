import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import selfsigned from 'selfsigned';
import { Agent } from 'undici';

const require = createRequire(import.meta.url);
const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048, days: 1, extensions: [
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ],
});
const delta = (content, finish_reason = null, extra = {}) => ({ model: 'auto',
  choices: [{ index: 0, delta: { content, ...extra }, finish_reason }] });
const frame = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;
const basePayload = { model: 'ark-code-latest', stream: true, max_tokens: 65536, temperature: 0.2,
  messages: [{ role: 'system', content: 'Review.' }, { role: 'user', content: 'synthetic code' }] };

async function fixture(t, implementation, route) {
  const calls = [], logs = [], dispatcherOptions = [];
  const server = createServer({ key: certificate.private, cert: certificate.cert }, async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(text) });
    try { await route(req, res, calls.at(-1)); } catch (error) { res.destroy(error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = implementation.createChatRequester({ createDispatcher: (options) => {
    dispatcherOptions.push(options);
    return new Agent({ ...options, connect: { ca: certificate.cert } });
  } });
  const invoke = async ({ timeoutMs = 2000, payload = basePayload, lane = 'B', onProgress = (entry) => logs.push(entry) } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await request({ apiKey: `test-only-${lane}`, baseURL: `https://127.0.0.1:${server.address().port}/v1/${lane}`,
      payload, timeoutMs, signal: controller.signal, onProgress }); }
    finally { clearTimeout(timer); }
  };
  return { invoke, calls, logs, dispatcherOptions };
}

for (const [name, implementation] of [
  ['source', require('../review-action/src/sdk-client.js')],
  ['bundled', require('../review-action/dist/sdk-client.js')],
]) {
  test(`${name}: real TLS + SDK SSE, split UTF-8, finish without DONE/EOF`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(frame(delta('中文审核', null, { reasoning_content: 'PRIVATE REASONING' })));
      const split = bytes.indexOf(Buffer.from('中文')) + 1;
      res.write(bytes.subarray(0, split));
      await delay(10);
      res.write(bytes.subarray(split));
      res.write(frame(delta('', 'stop')));
      // Deliberately leave the connection open; completion must not await EOF.
    });
    const response = await f.invoke();
    const result = JSON.parse(await response.text());
    assert.equal(result.choices[0].message.content, '中文审核');
    assert.equal(result.reasoning_chars, 17);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, '/v1/B/chat/completions');
    assert.equal(f.calls[0].headers.authorization, 'Bearer test-only-B');
    assert.deepEqual(f.calls[0].body, basePayload);
    assert.equal(f.logs.at(-1).finish_reason, 'stop');
    assert.notEqual(f.logs.at(-1).first_content_ms, null);
    assert.equal(f.logs.at(-1).event, 'finished');
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE REASONING'));
    assert.deepEqual(f.dispatcherOptions, [{ headersTimeout: 2000, bodyTimeout: 2000,
      connectTimeout: 2000, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 1000 }]);
  });

  test(`${name}: A/B/C use isolated credentials and preserve provider parameters`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame(delta('OK', 'stop')) + 'data: [DONE]\n\n');
    });
    await Promise.all(['A', 'B', 'C'].map((lane) => f.invoke({ lane, payload: {
      ...basePayload, model: lane === 'A' ? 'qwen3.8-max' : lane === 'B' ? 'ark-code-latest' : 'deepseek-v4-flash',
      max_tokens: lane === 'C' ? undefined : lane === 'A' ? 16384 : 65536,
    } })));
    assert.equal(f.calls.length, 3);
    for (const call of f.calls) {
      const lane = call.url.split('/')[2];
      assert.equal(call.headers.authorization, `Bearer test-only-${lane}`);
      assert.equal(call.body.stream, true);
      assert.equal('max_tokens' in call.body, lane !== 'C');
      assert.equal(call.body.reasoning_effort, undefined);
      assert.equal(call.body.thinking, undefined);
    }
  });

  test(`${name}: empty finish_reason on initial/intermediate deltas is not completion`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(delta('', '')));
      await delay(10);
      res.write(frame(delta('complete review', '')));
      res.write(frame(delta('', 'stop')));
    });
    const result = JSON.parse(await (await f.invoke()).text());
    assert.equal(result.choices[0].message.content, 'complete review');
    assert.equal(result.choices[0].finish_reason, 'stop');
  });

  for (const status of [400, 401, 403, 429, 500, 503, 307]) {
    test(`${name}: HTTP ${status} sends once, never retries/redirects or logs response secrets`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', location: '/do-not-follow' });
        res.end(JSON.stringify({ error: { code: 'insufficient_quota', type: 'rate_limit_error', message: 'PRIVATE ERROR test-only-B' } }));
      });
      await assert.rejects(f.invoke(), (error) => {
        assert.ok(!JSON.stringify(error).includes('PRIVATE ERROR'));
        assert.ok(!error.message.includes('test-only-B'));
        if (status !== 307) assert.equal(error.status, status);
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE ERROR'));
    });
  }

  for (const [label, body] of [
    ['DONE without finish', frame(delta('partial')) + 'data: [DONE]\n\n'],
    ['EOF without finish', frame(delta('partial'))],
    ['malformed JSON', 'data: {invalid}\n\n'],
    ['upstream stream error', frame({ error: { code: 'upstream_error', message: 'PRIVATE REASONING' } })],
    ['HTML response', '<html>verification</html>'],
  ]) {
    test(`${name}: ${label} cannot become valid evidence`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body);
      });
      await assert.rejects(f.invoke());
      assert.equal(f.calls.length, 1);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE REASONING'));
    });
  }

  test(`${name}: length and empty final content remain distinguishable`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(delta('', 'length')));
    });
    const result = JSON.parse(await (await f.invoke()).text());
    assert.equal(result.choices[0].finish_reason, 'length');
    assert.equal(result.choices[0].message.content, '');
  });

  for (const mode of ['headers', 'reasoning', 'content', 'disconnect']) {
    test(`${name}: ${mode} stall/interrupt is bounded and logs partial progress`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        if (mode === 'headers') return;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame(delta(mode === 'content' ? 'partial' : '', null, { reasoning_content: 'SECRET' })));
        if (mode === 'disconnect') { await delay(20); res.destroy(); }
      });
      await assert.rejects(f.invoke({ timeoutMs: 150 }));
      assert.equal(f.calls.length, 1);
      assert.ok(!JSON.stringify(f.logs).includes('SECRET'));
      if (mode === 'content') assert.equal(f.logs.at(-1).content_chars, 7);
      if (mode === 'headers') assert.equal(f.logs.at(-1).headers_ms, null);
    });
  }

  test(`${name}: delayed response headers are governed by configured deadline`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      await delay(1100);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(delta('OK', 'stop')));
    });
    assert.equal((await f.invoke({ timeoutMs: 2500 })).status, 200);
    assert.ok(f.logs.at(-1).headers_ms >= 1000);
  });

  test(`${name}: unframed oversized SSE is bounded before SDK decoding`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + 'x'.repeat(33 * 1024 * 1024));
    });
    await assert.rejects(f.invoke({ timeoutMs: 5000 }), (error) => error.code === 'REVIEW_RESPONSE_TOO_LARGE');
    assert.equal(f.calls.length, 1);
  });

  test(`${name}: unsafe endpoints are rejected before any request`, async () => {
    for (const baseURL of ['PRIVATE INVALID URL', 'http://example.test/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?key=x', 'https://example.test/v1#fragment']) {
      await assert.rejects(implementation.requestChatCompletion({ apiKey: 'test-only', baseURL,
        payload: basePayload, signal: new AbortController().signal, timeoutMs: 100 }), (error) => {
          assert.equal(error.code, 'REVIEW_INVALID_ENDPOINT');
          assert.ok(!JSON.stringify(error).includes(baseURL));
          return true;
        });
    }
  });

  test(`${name}: explicit Lane credentials cannot fall back to OpenAI environment defaults`, async (t) => {
    const names = ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'];
    const previous = names.map((name) => process.env[name]);
    names.forEach((name) => { process.env[name] = 'test-only-unrelated-environment'; });
    t.after(() => names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }));
    for (const apiKey of [undefined, null, '', '  ', 17]) {
      await assert.rejects(implementation.requestChatCompletion({ apiKey, baseURL: 'https://example.test/v1',
        payload: basePayload, signal: new AbortController().signal, timeoutMs: 100 }),
      (error) => error.code === 'REVIEW_INVALID_CREDENTIAL');
    }
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(delta('OK', 'stop')));
    });
    await f.invoke();
    assert.equal(f.calls[0].headers.authorization, 'Bearer test-only-B');
    assert.equal(f.calls[0].headers['openai-organization'], undefined);
    assert.equal(f.calls[0].headers['openai-project'], undefined);
  });

  test(`${name}: diagnostic callback failures do not mask completion`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(delta('OK', 'stop')));
    });
    const response = await f.invoke({ onProgress: () => { throw new Error('test-only logger failure'); } });
    assert.equal(JSON.parse(await response.text()).choices[0].message.content, 'OK');
  });
}

test('real 310-second headers exceed old Node fetch limit', { skip: process.env.SDK_LONG_HEADER_TEST !== '1', timeout: 370000 }, async (t) => {
  const f = await fixture(t, require('../review-action/dist/sdk-client.js'), async (_req, res) => {
    await delay(310000);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame(delta('OK', 'stop')));
  });
  assert.equal((await f.invoke({ timeoutMs: 360000 })).status, 200);
  assert.ok(f.logs.at(-1).headers_ms >= 310000);
});
