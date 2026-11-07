import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBitBrowserProxyExtraction } from '../server/bitbrowser-proxy-extraction.mjs';
import { parseBitBrowserProxyExtraction } from '../modules/recharge/bitbrowser/proxy-extraction.mjs';
const origin = 'https://id.example.com', actor = { id: 'fixture-admin', role: 'admin' };
const payload = { link: 'https://extract.example.com:8443/api?key=synthetic-secret', protocol: 'socks5' };
function fixture({ answers = [{ address: '8.8.8.8', family: 4 }], text = 'proxy.example.com:1080:user:synthetic-pass', status = 200, networkError = false } = {}) {
  const requests = [];
  const handler = createBitBrowserProxyExtraction({ publicOrigin: origin, resolve: async () => answers, request(options, cb) {
    requests.push(options); const outgoing = new EventEmitter(); outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => {
      if (networkError) return outgoing.emit('error', new Error('synthetic-secret'));
      const response = Readable.from([Buffer.from(text)]); response.statusCode = status; cb(response);
    }); return outgoing;
  } });
  return { handler, requests };
}
async function call(handler, body = payload, options = {}) {
  const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]);
  req.method = options.method || 'POST';
  req.headers = { host: 'id.example.com', origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...options.headers };
  const res = new EventEmitter(); res.headers = {}; res.setHeader = (key, value) => res.headers[key] = value;
  res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = text => res.body = JSON.parse(text);
  await handler(req, res, options.actor === undefined ? actor : options.actor); return res;
}
test('provider text and bounded JSON IP/port replies share the static proxy parser', () => {
  const rows = [
    'user:synthetic-pass@proxy.example.com:8080',
    { data: [{ ip: '8.8.8.8', port: 1080, username: 'user', password: 'synthetic-pass' }] },
    { result: { list: [{ host: 'proxy.example.com', port: '1080', user: 'user', pwd: 'synthetic-pass' }] } },
    { data: { proxy_list: ['socks5://user:synthetic-pass@proxy.example.com:1080'] } }
  ];
  for (const row of rows) {
    const parsed = parseBitBrowserProxyExtraction(typeof row === 'string' ? row : JSON.stringify(row), { protocol: 'socks5' });
    assert.equal(parsed.mode, 'static'); assert.equal(parsed.protocol, 'socks5'); assert.equal(parsed.username, 'user'); assert.equal(parsed.password, 'synthetic-pass');
  }
  assert.equal(parseBitBrowserProxyExtraction('proxy.example.com:1080').automaticProtocol, true);
  assert.throws(() => parseBitBrowserProxyExtraction(JSON.stringify({ success: false, data: rows[1].data })), /未完成检测/);
  for (const [text, reason] of [['IP not allowed in whitelist: synthetic-secret', /白名单/], ['insufficient balance synthetic-secret', /余额/], ['<html>synthetic-secret</html>', /未返回可识别/], ['x'.repeat(8200), /过大/]])
    assert.throws(() => parseBitBrowserProxyExtraction(text), error => reason.test(error.message) && !error.message.includes('synthetic-secret'));
});
test('only an authenticated admin same-origin bounded POST can fetch extraction', async () => {
  const { handler, requests } = fixture();
  for (const [options, expected] of [[{ actor: null }, 401], [{ actor: { ...actor, role: 'staff' } }, 403], [{ headers: { origin: 'https://other.example' } }, 403], [{ headers: { host: 'other.example' } }, 403], [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403], [{ method: 'GET' }, 405], [{ headers: { 'content-type': 'text/plain' } }, 415], [{ raw: 'bad' }, 400], [{ raw: ' '.repeat(4097) }, 413]])
    assert.equal((await call(handler, payload, options)).status, expected);
  assert.equal(requests.length, 0);
  const result = await call(handler);
  assert.equal(result.status, 200); assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.link, 'socks5://user:synthetic-pass@proxy.example.com:1080');
  const options = requests[0];
  assert.equal(options.hostname, '8.8.8.8'); assert.equal(options.family, 4); assert.equal(options.agent, false);
  assert.equal(options.headers.Host, 'extract.example.com:8443'); assert.equal(options.servername, 'extract.example.com'); assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.checkServerIdentity('8.8.8.8', { subjectaltname: 'DNS:extract.example.com' }), undefined);
  assert(options.checkServerIdentity('8.8.8.8', { subjectaltname: 'DNS:wrong.example.com' }));
  assert(!Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)));
});
test('SSRF/private/mixed DNS, redirects, oversized bodies and network errors cannot leak or pass', async () => {
  for (const link of ['http://127.0.0.1/api?key=synthetic-secret', 'https://169.254.169.254/latest', 'http://localhost:54345', 'file:///etc/passwd']) {
    const { handler, requests } = fixture(); assert.equal((await call(handler, { ...payload, link })).status, 400); assert.equal(requests.length, 0);
  }
  const mixed = fixture({ answers: [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] });
  assert.equal((await call(mixed.handler)).status, 422); assert.equal(mixed.requests.length, 0);
  for (const options of [{ status: 302 }, { status: 403 }, { text: 'x'.repeat(8193) }, { networkError: true }, { text: '{"success":false,"msg":"whitelist synthetic-secret"}' }]) {
    const { handler, requests } = fixture(options), res = await call(handler);
    assert(res.status >= 400); assert.equal(requests.length, 1); assert(!JSON.stringify(res.body).includes('synthetic-secret')); assert.equal(res.body.reason, 'extraction');
  }
});
test('per-actor rate limiting bounds the authenticated relay', async () => {
  const { handler, requests } = fixture();
  for (let i = 0; i < 20; i++) assert.equal((await call(handler)).status, 200);
  assert.equal((await call(handler)).status, 429); assert.equal(requests.length, 20);
});
