import https from 'node:https';
if (!process.env.ARK_KEY || !process.env.ARK_BASE) throw new Error('Missing Ark slots');
const url = new URL(process.env.ARK_BASE.replace(/\/$/, '') + '/chat/completions');
if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid HTTPS endpoint');
for (const stream of [false, true]) {
  await new Promise((resolve) => {
    const start = Date.now();
    const timings = {};
    const body = JSON.stringify({ model: 'ark-code-latest', stream, max_tokens: 512, messages: [{ role: 'user', content: 'Reply with OK.' }] });
    const req = https.request(url, { method: 'POST', agent: false, signal: AbortSignal.timeout(45000),
      headers: { authorization: 'Bearer ' + process.env.ARK_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      timings.headers = Date.now() - start;
      let text = '';
      res.on('data', (chunk) => { timings.firstByte ??= Date.now() - start; if (text.length < 100000) text += chunk; });
      res.on('end', () => {
        let summary;
        try {
          const events = stream ? text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6))) : [JSON.parse(text)];
          summary = events.map((e) => ({ model: e.model, finish: e.choices?.[0]?.finish_reason, content: e.choices?.[0]?.message?.content || e.choices?.[0]?.delta?.content, error: e.error?.code })).filter((e) => e.model || e.finish || e.content || e.error);
        } catch { summary = 'unparsed'; }
        console.log(JSON.stringify({ stream, status: res.statusCode, elapsed: Date.now() - start, timings, summary }));
        resolve();
      });
      res.on('error', (error) => { console.log(JSON.stringify({ stream, phase: 'body', code: error.code, timings })); resolve(); });
    });
    req.on('socket', (socket) => {
      socket.once('lookup', () => { timings.lookup = Date.now() - start; });
      socket.once('connect', () => { timings.connect = Date.now() - start; });
      socket.once('secureConnect', () => { timings.tls = Date.now() - start; });
    });
    req.on('error', (error) => { console.log(JSON.stringify({ stream, code: error.code, elapsed: Date.now() - start, timings })); resolve(); });
    req.end(body);
  });
}
