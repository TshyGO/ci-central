import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createProxyServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import selfsigned from 'selfsigned';
import { Agent, ProxyAgent } from 'undici';

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

async function fixture(t, implementation, route, requesterOptions = {}) {
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
  }, usageTrailerGraceMs: 200, ...requesterOptions });
  const invoke = async ({ timeoutMs = 2000, payload = basePayload, lane = 'B', protocol, sessionId, basePath = `/v1/${lane}`, onProgress = (entry) => logs.push(entry) } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await request({ apiKey: `test-only-${lane}`, baseURL: `https://127.0.0.1:${server.address().port}${basePath}`,
      payload, timeoutMs, protocol, sessionId, signal: controller.signal, onProgress }); }
    finally { clearTimeout(timer); }
  };
  return { invoke, calls, logs, dispatcherOptions };
}

for (const [name, implementation] of [
  ['source', require('../review-action/src/sdk-client.js')],
  ['bundled', require('../review-action/dist/sdk-client.js')],
]) {
  for (const rejectProxy of [false, true]) {
    test(`${name}: explicit authenticated proxy ${rejectProxy ? 'failure never falls back direct' : 'tunnels TLS without leaking proxy credentials'}`, async (t) => {
      const calls=[], connections=[], sockets=new Set();
      const target=createServer({key:certificate.private,cert:certificate.cert},(req,res)=>{
        calls.push(req.headers); res.writeHead(200,{'content-type':'text/event-stream'}); res.end(frame(delta('OK','stop')));
      });
      target.listen(0,'127.0.0.1'); await once(target,'listening');
      const proxy=createProxyServer();
      proxy.on('connect',(req,socket,head)=>{
        connections.push(req.headers);sockets.add(socket);socket.on('error',()=>{});
        if(rejectProxy){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');return;}
        const upstream=connect(target.address().port,'127.0.0.1',()=>{
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
        });sockets.add(upstream);upstream.on('error',()=>socket.destroy());
      });
      proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
      t.after(()=>{for(const s of sockets)s.destroy();target.closeAllConnections();target.close();proxy.close();});
      let directCalls=0;const logs=[];
      const request=implementation.createChatRequester({createDispatcher:()=>{directCalls++;throw new Error('direct forbidden');},
        createProxyDispatcher:(options)=>new ProxyAgent({...options,requestTls:{ca:certificate.cert}})});
      const promise=request({apiKey:'model-test-key',baseURL:`https://127.0.0.1:${target.address().port}/v1`,payload:basePayload,
        timeoutMs:2000,signal:AbortSignal.timeout(2000),proxyUrl:`http://proxy-user:proxy-password@127.0.0.1:${proxy.address().port}`,onProgress:p=>logs.push(p)});
      if(rejectProxy)await assert.rejects(promise);else assert.equal(JSON.parse(await (await promise).text()).choices[0].message.content,'OK');
      assert.equal(directCalls,0);assert.equal(connections.length,1);assert.equal(calls.length,rejectProxy?0:1);
      assert.equal(connections[0]['proxy-authorization'],'Basic '+Buffer.from('proxy-user:proxy-password').toString('base64'));
      if(!rejectProxy){assert.equal(calls[0]['proxy-authorization'],undefined);assert.equal(calls[0].authorization,'Bearer model-test-key');}
      assert.ok(!JSON.stringify(logs).includes('proxy-password'));
    });
  }
  test(`${name}: SenseNova reasoning alias is counted but never published`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(delta('', null, { reasoning: 'PRIVATE' })));
      res.write(frame(delta('', null, { reasoning_content: 'CANONICAL', reasoning: 'DUPLICATE' })));
      res.end(frame(delta('final review', 'stop')));
    });
    const result = JSON.parse(await (await f.invoke()).text());
    assert.equal(result.reasoning_chars, 16);
    assert.equal(result.choices[0].message.content, 'final review');
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE'));
  });
  test(`${name}: Responses uses final text only, coding headers and completion without EOF`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ type: 'response.reasoning_text.delta', delta: 'PRIVATE THOUGHT' }));
      res.write(frame({ type: 'response.output_text.delta', delta: '中文审核' }));
      res.write(frame({ type: 'response.completed', response: { status: 'completed', model: 'muse-spark-1.3-contributor',
        output: [{ type: 'reasoning', summary: [{ text: 'PRIVATE THOUGHT' }] },
          { type: 'message', content: [{ type: 'output_text', text: '中文审核' }] }], usage: { input_tokens: 20 } } }));
    });
    const result = JSON.parse(await (await f.invoke({ protocol: 'openai-responses', sessionId: 'repo-pr-877-lane-A',
      payload: { model: 'muse-spark-1.3-contributor', input: 'synthetic code', max_output_tokens: 16384, store: false } })).text());
    assert.equal(result.choices[0].message.content, '中文审核');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.reasoning_chars, 15);
    assert.equal(result.usage.input_tokens, 20);
    assert.equal(f.calls[0].url, '/v1/B/responses');
    assert.equal(f.calls[0].headers.authorization, 'Bearer test-only-B');
    assert.equal(f.calls[0].headers['x-opencode-session'], 'repo-pr-877-lane-A');
    assert.equal(f.calls[0].headers['user-agent'], 'NebulaLab-CI-Review/1.0');
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE THOUGHT'));
  });
  for (const mode of ['incomplete', 'tool', 'missing', 'failed', 'error', 'wrong_status']) {
    test(`${name}: Responses ${mode} cannot become a valid complete review`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const event = mode === 'error' ? { type: 'error', code: 'upstream_error', message: 'PRIVATE ERROR' }
          : mode === 'failed' ? { type: 'response.failed', response: { error: { code: 'upstream_error', message: 'PRIVATE ERROR' } } }
          : mode === 'incomplete' ? { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }
          : mode === 'tool' ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call' }] } }
          : mode === 'wrong_status' ? { type: 'response.completed', response: { status: 'in_progress' } }
          : { type: 'response.output_text.delta', delta: 'partial' };
        res.end(frame(event));
      });
      if (['tool','incomplete'].includes(mode)) {
        const result=JSON.parse(await (await f.invoke({ protocol: 'openai-responses' })).text());
        assert.notEqual(result.choices[0].finish_reason, 'stop');
      } else await assert.rejects(f.invoke({ protocol: 'openai-responses' }));
      assert.equal(f.calls.length, 1);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE ERROR'));
    });
  }
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

  // Command Code reports an exhausted plan as 429 RATE_LIMITED; only its message says so. Go names
  // the plan error type and gives the wait as retry-after. Only a boolean, a closed-vocabulary
  // window and a checked timestamp may leave the client, never the message or the account.
  const inThreeDays = new Date(Date.now() + 3 * 86400000).toISOString();
  for (const [label, status, headers, body, expected] of [
    ['Command Code weekly usage limit', 429, {}, { error: { code: 'RATE_LIMITED', type: 'rate_limit_error',
      message: `You've reached your weekly usage limit for your plan. Your limit resets at ${inThreeDays}. Please wait for the window to reset or upgrade your plan. PRIVATE test-only-B` } },
    { exhausted: true, window: 'weekly', resetAt: inThreeDays }],
    ['Command Code 5-hour usage limit', 429, {}, { error: { code: 'RATE_LIMITED', type: 'rate_limit_error',
      message: `You've reached your 5-hour usage limit for your plan. Your limit resets at ${inThreeDays}. PRIVATE` } },
    { exhausted: true, window: '5h', resetAt: inThreeDays }],
    ['a weekly limit whose message also counts hours', 429, {}, { error: { code: 'RATE_LIMITED', type: 'rate_limit_error',
      message: `You've reached your weekly usage limit. It resets in 5 hours, at ${inThreeDays}. PRIVATE` } },
    { exhausted: true, window: 'weekly', resetAt: inThreeDays }],
    ['Go usage limit with retry-after', 429, { 'retry-after': '48358' }, { type: 'error',
      error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { workspace: 'wrk_PRIVATE', limitName: 'weekly' } },
    { exhausted: true, window: 'weekly', resetInSeconds: 48358 }],
    ['an OpenAI insufficient_quota', 429, {}, { error: { code: 'insufficient_quota', type: 'insufficient_quota',
      message: 'You exceeded your current quota, please check your plan and billing details. PRIVATE' } },
    { exhausted: true, window: undefined, resetAt: undefined }],
    ['a reset time already in the past', 429, {}, { error: { code: 'RATE_LIMITED', type: 'rate_limit_error',
      message: "You've reached your weekly usage limit for your plan. Your limit resets at 2020-01-01T00:00:00.000Z. PRIVATE" } },
    { exhausted: true, window: 'weekly', resetAt: undefined }],
    ['an ordinary rate limit', 429, { 'retry-after': '20' }, { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error',
      message: 'Rate limit reached for requests per minute. Please try again in 20s. PRIVATE' } },
    { exhausted: false }],
    ['a capacity 503', 503, {}, { error: { code: 'overloaded', type: 'server_error',
      message: "You've reached your weekly usage limit for your plan. PRIVATE" } }, { exhausted: false }],
    ['a per-minute limit worded as a quota', 429, { 'retry-after': '20' }, { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error',
      message: 'Rate limit: quota exceeded for requests per minute, retry after 20 s. PRIVATE' } }, { exhausted: false }],
    ['a per-minute limit worded as a usage limit', 429, {}, { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error',
      message: 'usage limit exceeded per minute. PRIVATE' } }, { exhausted: false }],
    ['a generic quota message that names no plan, reset or window', 429, {}, { error: { code: 'too_many_requests', type: 'rate_limit_error',
      message: 'Quota exceeded, please slow down. PRIVATE' } }, { exhausted: false }],
  ]) {
    test(`${name}: Responses ${label} ${expected.exhausted ? 'is' : 'is not'} reported as an exhausted plan quota, without its text`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      });
      const started = Date.now();
      await assert.rejects(f.invoke({ protocol: 'openai-responses', payload: { model: 'gpt-6-luna', input: 'synthetic code', max_output_tokens: 16, store: false } }),
        (error) => {
          assert.equal(error.status, status);
          assert.equal(error.quotaExhausted, expected.exhausted);
          assert.equal(error.quotaWindow, expected.window);
          if (expected.resetInSeconds) {
            const reset = Date.parse(error.quotaResetAt);
            assert.ok(reset >= started + expected.resetInSeconds * 1000 - 1000 && reset <= Date.now() + expected.resetInSeconds * 1000 + 1000);
          } else assert.equal(error.quotaResetAt, expected.resetAt);
          assert.ok(!JSON.stringify(error).includes('PRIVATE') && !error.message.includes('usage limit'));
          return true;
        });
      assert.equal(f.calls.length, 1);
      const finished = f.logs.find((entry) => entry.event === 'finished');
      assert.equal(finished.quota_exhausted ?? false, expected.exhausted);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE'));
    });
  }
  for (const [limitName, window] of [['rolling_5h', '5h'], ['7d', 'weekly'], ['24h', 'daily'], ['monthly', 'monthly']]) {
    test(`${name}: Go's limitName ${limitName} names the ${window} window`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '600' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' }, metadata: { workspace: 'wrk_PRIVATE', limitName } }));
      });
      await assert.rejects(f.invoke({ protocol: 'openai-responses', payload: { model: 'muse-spark-1.3-contributor', input: 'synthetic code', max_output_tokens: 16, store: false } }),
        (error) => error.quotaExhausted === true && error.quotaWindow === window && !JSON.stringify(error).includes('PRIVATE'));
    });
  }
  test(`${name}: Anthropic Messages Go usage limit keeps its window from the plan metadata`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' },
        metadata: { workspace: 'wrk_PRIVATE', limitName: 'weekly' } }));
    });
    await assert.rejects(f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: { model: 'claude-haiku-5-5',
      max_tokens: 16, messages: [{ role: 'user', content: 'synthetic code' }] } }),
    (error) => error.status === 429 && error.quotaExhausted === true && error.quotaWindow === 'weekly'
      && Math.abs(Date.parse(error.quotaResetAt) - (Date.now() + 3600000)) < 5000 && !JSON.stringify(error).includes('PRIVATE'));
  });
  // ci-central#72 review: reading the error body for the plan window must not cost the HTTP status.
  test(`${name}: an error body cut off mid-read keeps its HTTP status`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'content-length': '4096' });
      res.write('{"error":{"code":"RATE_LIMITED","message":"PRIVATE');
      await delay(50);
      res.destroy();
    });
    await assert.rejects(f.invoke({ protocol: 'openai-responses', payload: { model: 'gpt-6-luna', input: 'synthetic code', max_output_tokens: 16, store: false } }),
      (error) => error.status === 429 && error.quotaExhausted === false && !JSON.stringify(error).includes('PRIVATE'));
    assert.equal(f.calls.length, 1);
  });

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

  test(`${name}: usage trailer after finish_reason is recorded as accounting only`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' })));
      res.write(frame(delta('final review', 'stop')));
      // One write: the [DONE] assertion must not depend on TCP segmentation.
      res.write(frame({ model: 'glm-5.3', choices: [], usage: { prompt_tokens: 120, completion_tokens: 45,
        total_tokens: 165, completion_tokens_details: { reasoning_tokens: 30 } } }) + 'data: [DONE]\n\n');
      // Deliberately leave the connection open after the trailer.
    });
    const result = JSON.parse(await (await f.invoke()).text());
    assert.equal(result.choices[0].message.content, 'final review');
    assert.equal(result.usage.completion_tokens, 45);
    const finished = f.logs.at(-1);
    assert.equal(finished.usage_trailer, 'usage');
    assert.deepEqual([finished.input_tokens, finished.output_tokens, finished.reasoning_tokens], [120, 45, 30]);
    assert.equal(finished.last_event, 'finish');
    assert.equal(finished.done_marker, true);
    // Stopping after the trailer is our own cancellation, not a transport error.
    assert.equal(finished.body_end, 'cancel');
    assert.equal(finished.body_error, null);
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE REASONING'));
  });

  for (const [mode, after, status] of [
    ['silent connection', '', 'timeout'],
    ['malformed trailer', 'data: {invalid}\n\n', 'error'],
    ['in-band error trailer', frame({ error: { code: 'billing_error', message: 'PRIVATE ERROR' } }), 'error'],
    ['EOF', null, 'end'],
  ]) {
    test(`${name}: ${mode} after finish_reason never invalidates the review`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (after === null) { res.end(frame(delta('final review', 'stop'))); return; }
        res.write(frame(delta('final review', 'stop')) + after);
      });
      const started = Date.now();
      const result = JSON.parse(await (await f.invoke()).text());
      assert.ok(Date.now() - started < 1500, 'the trailer wait is bounded by its grace window');
      assert.equal(result.choices[0].finish_reason, 'stop');
      assert.equal(result.choices[0].message.content, 'final review');
      assert.equal(f.logs.at(-1).usage_trailer, status);
      assert.equal(f.logs.at(-1).output_tokens, null);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE ERROR'));
    });
  }

  test(`${name}: usage trailer wait never outlives the request deadline`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(delta('final review', 'stop')));
    }, { usageTrailerGraceMs: 5000 });
    const started = Date.now();
    const result = JSON.parse(await (await f.invoke({ timeoutMs: 300 })).text());
    assert.ok(Date.now() - started < 1500, 'the deadline, not the grace window, bounds the trailer wait');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.choices[0].message.content, 'final review');
    assert.equal(f.logs.at(-1).usage_trailer, 'end');
  });

  for (const [mode, expected] of [
    ['clean close mid-reasoning', { end: 'clean_close', body_end: 'eof', done_marker: false, frame_boundary: true, last_event: 'reasoning' }],
    ['idle close', { end: 'idle_close', body_end: 'eof', done_marker: false, frame_boundary: true, last_event: 'reasoning' }],
    ['DONE without finish', { end: 'done_without_finish', done_marker: true, last_event: 'reasoning' }],
    ['close mid-frame', { end: 'clean_close', body_end: 'eof', done_marker: false, frame_boundary: false, last_event: 'reasoning' }],
    ['unrecognized in-band frame', { end: 'clean_close', body_end: 'eof', last_event: 'no_choice:code+message' }],
  ]) {
    test(`${name}: ${mode} reports how the incomplete stream ended`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' })));
        if (mode === 'idle close') await delay(600);
        if (mode === 'DONE without finish') res.write('data: [DONE]\n\n');
        if (mode === 'close mid-frame') res.write('data: {"model":"glm","choices":[{"index":0,"delta":{"reasoning_content":"PRIVATE');
        if (mode === 'unrecognized in-band frame') res.write(frame({ code: 'upstream_timeout', message: 'PRIVATE REASONING' }));
        res.end();
      }, { idleCloseMs: 300 });
      await assert.rejects(f.invoke(), (error) => {
        assert.equal(error.code, 'REVIEW_INCOMPLETE_STREAM');
        assert.match(error.message, new RegExp(`http=200, end=${expected.end}, last_event=${expected.last_event.split(':')[0]}`));
        assert.ok(!error.message.includes('PRIVATE'));
        return true;
      });
      const finished = f.logs.at(-1);
      assert.equal(finished.incomplete_end, expected.end);
      for (const field of ['body_end', 'done_marker', 'frame_boundary', 'last_event']) {
        if (field in expected) assert.equal(finished[field], expected[field], field);
      }
      // Margins absorb scheduler pauses: the idle case waits twice the threshold.
      if (mode === 'idle close') assert.ok(finished.idle_before_end_ms >= 300);
      assert.ok(!JSON.stringify(f.logs).includes('PRIVATE'));
    });
  }

  test(`${name}: [DONE] is recognized even when more than the tail window follows it`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' })) + 'data: [DONE]\n\n'
        + `: ${'x'.repeat(4096)}\n\n`);
    });
    await assert.rejects(f.invoke(), (error) => /end=done_without_finish/.test(error.message));
    assert.equal(f.logs.at(-1).done_marker, true);
  });

  for (const [mode, expected] of [
    ['capacity 429 with retry-after', { unserved: true, httpStatus: 429, retryAfterMs: 7000 }],
    ['queued stream closed before any token', { unserved: true, httpStatus: 200 }],
    ['stream closed after reasoning', { unserved: false, httpStatus: 200 }],
  ]) {
    test(`${name}: ${mode} reports whether any model output was produced`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        if (mode.startsWith('capacity')) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
          res.end(JSON.stringify({ error: { type: 'server_error', message: 'PRIVATE ERROR' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode.startsWith('queued')) res.write(': keep-alive\n\n: keep-alive\n\n');
        else res.write(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' })));
        res.end();
      });
      await assert.rejects(f.invoke(), (error) => {
        assert.equal(error.unserved, expected.unserved);
        assert.equal(error.httpStatus, expected.httpStatus);
        assert.equal(error.retryAfterMs, expected.retryAfterMs);
        assert.ok(!JSON.stringify(error).includes('PRIVATE'));
        return true;
      });
      assert.equal(f.logs.at(-1).unserved, expected.unserved);
    });
  }

  test(`${name}: transport AbortError swallowed by the SDK is still reported`, async (t) => {
    // The SDK ends iteration silently when the body fails with an AbortError that
    // the caller did not request; the raw body must keep that termination visible.
    const f = await fixture(t, implementation, async () => {}, { fetch: async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' }))));
        await delay(10);
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }) });
    await assert.rejects(f.invoke(), (error) => {
      assert.equal(error.code, 'REVIEW_INCOMPLETE_STREAM');
      assert.equal(error.name, 'SDKRequestError');
      assert.match(error.message, /end=transport_error, last_event=reasoning, idle_before_end_ms=\d+, body_error=AbortError/);
      return true;
    });
    assert.equal(f.logs.at(-1).body_end, 'error');
    assert.equal(f.logs.at(-1).body_error, 'AbortError');
    assert.equal(f.logs.at(-1).incomplete_end, 'transport_error');
  });

  test(`${name}: abrupt socket close keeps the transport code and body state`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(delta('', null, { reasoning_content: 'PRIVATE REASONING' })));
      await delay(20);
      res.destroy();
    });
    await assert.rejects(f.invoke(), (error) => {
      // Undici reports a peer FIN as UND_ERR_SOCKET and a reset as ECONNRESET.
      assert.match(error.code, /^(?:UND_ERR_SOCKET|ECONNRESET)$/);
      assert.ok(error.message.includes(`code=${error.code}, http=200`));
      return true;
    });
    assert.equal(f.logs.at(-1).body_end, 'error');
    assert.match(f.logs.at(-1).body_error, /UND_ERR_SOCKET|ECONNRESET/);
    assert.equal(f.logs.at(-1).incomplete_end, undefined);
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
    assert.equal(f.logs.at(-1).body_end, 'error');
    assert.equal(f.logs.at(-1).body_error, 'Error/REVIEW_RESPONSE_TOO_LARGE');
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

  // Anthropic Messages (Claude Haiku 5.5 through OpenCode Go `/messages`).
  const anthropicEvent = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const anthropicPayload = { model: 'claude-haiku-5-5', max_tokens: 65536, system: 'Review.', thinking: { type: 'adaptive' },
    output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'synthetic code' }] };
  const anthropicStream = (stopReason, { text = '中文审核' } = {}) => [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [],
      stop_reason: null, usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE THOUGHT' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 40 } } },
    { type: 'message_stop' },
  ];
  test(`${name}: Anthropic Messages publishes final text only with x-api-key and session headers`, async (t) => {
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
    const previous = names.map((key) => process.env[key]);
    process.env.ANTHROPIC_API_KEY = 'test-only-unrelated-environment';
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-only-unrelated-environment';
    process.env.ANTHROPIC_BASE_URL = 'https://unrelated.example.test';
    t.after(() => names.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of anthropicStream('end_turn')) res.write(anthropicEvent(event));
      res.end();
    });
    const result = JSON.parse(await (await f.invoke({ protocol: 'anthropic-messages', sessionId: 'repo-pr-877-lane-B',
      basePath: '/B/v1', payload: anthropicPayload })).text());
    assert.equal(result.choices[0].message.content, '中文审核');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.reasoning_chars, 15);
    assert.equal(result.model, 'claude-haiku-5-5');
    assert.equal(f.calls[0].url, '/B/v1/messages');
    assert.equal(f.calls[0].headers['x-api-key'], 'test-only-B');
    assert.equal(f.calls[0].headers.authorization, undefined);
    assert.equal(f.calls[0].headers['x-opencode-session'], 'repo-pr-877-lane-B');
    assert.ok(f.calls[0].headers['anthropic-version']);
    assert.equal(f.calls[0].body.stream, true);
    assert.deepEqual(f.calls[0].body.output_config, { effort: 'high' });
    assert.deepEqual(f.calls[0].body.thinking, { type: 'adaptive' });
    const finished = f.logs.find((entry) => entry.event === 'finished');
    assert.equal(finished.reasoning_tokens, 40);
    assert.equal(finished.input_tokens, 20);
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE THOUGHT'));
  });
  for (const [stopReason, expected] of [['max_tokens', 'length'], ['refusal', 'refusal']]) {
    test(`${name}: Anthropic Messages ${stopReason} cannot become a complete review`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of anthropicStream(stopReason)) res.write(anthropicEvent(event));
        res.end();
      });
      const result = JSON.parse(await (await f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: anthropicPayload })).text());
      assert.equal(result.choices[0].finish_reason, expected);
    });
  }
  test(`${name}: Anthropic Messages closed before a stop reason is an incomplete stream`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of anthropicStream('end_turn').slice(0, 7)) res.write(anthropicEvent(event));
      res.end();
    });
    await assert.rejects(f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: anthropicPayload }),
      (error) => error.code === 'REVIEW_INCOMPLETE_STREAM' && !error.unserved);
  });
  test(`${name}: Anthropic Messages quota rejection keeps the Go usage-limit type and stays unserved`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'PRIVATE LIMIT DETAIL' } }));
    });
    await assert.rejects(f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: anthropicPayload }),
      (error) => error.status === 429 && error.providerType === 'GoUsageLimitError' && error.unserved === true
        && !error.message.includes('PRIVATE'));
    assert.equal(f.calls.length, 1);
  });
  for (const [label, status, error, exhausted] of [
    ['a 402 billing_error', 402, { type: 'billing_error', message: 'PRIVATE BILLING DETAIL' }, true],
    ['a 400 low credit balance', 400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. PRIVATE' }, true],
    ['an ordinary 400', 400, { type: 'invalid_request_error', message: 'PRIVATE max_tokens: too large' }, false],
  ]) {
    test(`${name}: Anthropic Messages ${label} ${exhausted ? 'is' : 'is not'} reported as an exhausted credit, without its text`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error }));
      });
      await assert.rejects(f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: anthropicPayload }),
        (rejected) => rejected.status === status && rejected.creditExhausted === exhausted && rejected.providerType === error.type
          && !rejected.message.includes('PRIVATE') && !rejected.message.includes('credit balance'));
      assert.equal(f.calls.length, 1);
    });
  }
  test(`${name}: Anthropic Messages keeps the message_start input count when message_delta reports zero`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = anthropicStream('end_turn');
      events[8] = { ...events[8], usage: { input_tokens: 0, output_tokens: 50, output_tokens_details: { thinking_tokens: 40 } } };
      for (const event of events) res.write(anthropicEvent(event));
      res.end();
    });
    await f.invoke({ protocol: 'anthropic-messages', basePath: '/B/v1', payload: anthropicPayload });
    const finished = f.logs.find((entry) => entry.event === 'finished');
    assert.deepEqual([finished.input_tokens, finished.output_tokens, finished.reasoning_tokens], [20, 50, 40]);
  });
  test(`${name}: Anthropic Messages requires a base URL that ends in /v1`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => { res.writeHead(500); res.end(); });
    await assert.rejects(f.invoke({ protocol: 'anthropic-messages', basePath: '/B', payload: anthropicPayload }),
      (error) => error.code === 'REVIEW_INVALID_ENDPOINT');
    assert.equal(f.calls.length, 0);
  });

  // Gemini streamGenerateContent (Gemini 4 Argon through OpenCode Go).
  const geminiPayload = { model: 'gemini-4-argon-contributor', systemInstruction: { parts: [{ text: 'Review.' }] },
    contents: [{ role: 'user', parts: [{ text: 'synthetic code' }] }], generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'HIGH' } } };
  const geminiChunk = (parts, extra = {}) => ({ candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }] });
  test(`${name}: Gemini streams final text only with Go headers and completes on finishReason`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(geminiChunk([{ thought: true, text: 'PRIVATE THOUGHT' }])));
      const bytes = Buffer.from(frame(geminiChunk([{ text: '中文' }])));
      const split = bytes.indexOf(Buffer.from('中文')) + 1;
      res.write(bytes.subarray(0, split)); await delay(20); res.write(bytes.subarray(split));
      res.write(frame({ ...geminiChunk([{ text: '审核' }], { finishReason: 'STOP' }),
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 30 } }));
      // A finished Gemini stream may stay open; completion must not wait for EOF.
    });
    const result = JSON.parse(await (await f.invoke({ protocol: 'google-generate-content', sessionId: 'repo-pr-877-lane-C',
      payload: geminiPayload })).text());
    assert.equal(result.choices[0].message.content, '中文审核');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.reasoning_chars, 15);
    assert.equal(f.calls[0].url, '/v1/B/models/gemini-4-argon-contributor:streamGenerateContent?alt=sse');
    assert.equal(f.calls[0].headers['x-goog-api-key'], 'test-only-B');
    assert.equal(f.calls[0].headers.authorization, undefined);
    assert.equal(f.calls[0].headers['x-opencode-session'], 'repo-pr-877-lane-C');
    assert.equal(f.calls[0].body.model, undefined);
    assert.deepEqual(f.calls[0].body.generationConfig, geminiPayload.generationConfig);
    const finished = f.logs.find((entry) => entry.event === 'finished');
    assert.deepEqual([finished.input_tokens, finished.output_tokens, finished.reasoning_tokens], [20, 35, 30]);
    assert.ok(!JSON.stringify([result, f.logs]).includes('PRIVATE THOUGHT'));
  });
  for (const [reason, expected] of [['MAX_TOKENS', 'length'], ['SAFETY', 'safety']]) {
    test(`${name}: Gemini ${reason} cannot become a complete review`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frame(geminiChunk([{ text: 'partial' }], { finishReason: reason })));
      });
      const result = JSON.parse(await (await f.invoke({ protocol: 'google-generate-content', payload: geminiPayload })).text());
      assert.equal(result.choices[0].finish_reason, expected);
    });
  }
  test(`${name}: Gemini closed before a finishReason is an incomplete stream`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame(geminiChunk([{ text: 'partial' }])));
    });
    await assert.rejects(f.invoke({ protocol: 'google-generate-content', payload: geminiPayload }),
      (error) => error.code === 'REVIEW_INCOMPLETE_STREAM' && !error.unserved);
  });
  test(`${name}: Gemini HTTP rejection keeps status and provider type without the body`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'GoUsageLimitError', message: 'PRIVATE LIMIT DETAIL' } }));
    });
    await assert.rejects(f.invoke({ protocol: 'google-generate-content', payload: geminiPayload }),
      (error) => error.status === 429 && error.providerType === 'GoUsageLimitError' && error.unserved === true
        && error.retryAfterMs === 7000 && !error.message.includes('PRIVATE'));
  });
  for (const [shape, body, expected] of [
    ['string code', { error: { code: 'insufficient_quota', message: 'PRIVATE LIMIT DETAIL' } }, 'insufficient_quota'],
    ['Google array', [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'PRIVATE LIMIT DETAIL' } }], 'RESOURCE_EXHAUSTED'],
  ]) {
    test(`${name}: Gemini rejection keeps a ${shape} error code`, async (t) => {
      const f = await fixture(t, implementation, async (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      await assert.rejects(f.invoke({ protocol: 'google-generate-content', payload: geminiPayload }),
        (error) => error.status === 429 && error.providerCode === expected && !error.message.includes('PRIVATE'));
    });
  }
  test(`${name}: Gemini requires a model id`, async (t) => {
    const f = await fixture(t, implementation, async (_req, res) => { res.writeHead(500); res.end(); });
    const { model, ...withoutModel } = geminiPayload;
    await assert.rejects(f.invoke({ protocol: 'google-generate-content', payload: withoutModel }),
      (error) => error.code === 'REVIEW_INVALID_MODEL');
    assert.equal(f.calls.length, 0);
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
