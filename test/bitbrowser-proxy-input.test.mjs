import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBitBrowserProxyInput, bitBrowserProxySettings } from '../modules/recharge/bitbrowser/proxy-input.mjs';
import { testBitBrowserProxy } from '../modules/recharge/bitbrowser/proxy-test.mjs';
test('raw supplier formats preserve credentials and share the execution parser', () => {
  for (const link of ['user:p:a@ss@gateway.example.test:8082', 'gateway.example.test:8082:user:p:a@ss']) {
    const parsed = parseBitBrowserProxyInput(link);
    assert.equal(parsed.username, 'user'); assert.equal(parsed.password, 'p:a@ss'); assert.equal(parsed.automaticProtocol, true);
    const settings = bitBrowserProxySettings({ ...parsed, countryCode: '' });
    assert.deepEqual(settings.staticProxyCredentials, { username: 'user', password: 'p:a@ss' });
    assert.equal(settings.browserOptions.staticPort, 8082); assert.equal(settings.useSelectedProxy, true);
  }
});
test('complete URLs infer direct vs extraction and invalid inputs never echo secrets', () => {
  assert.equal(parseBitBrowserProxyInput('socks5://user:pass@gateway.example.test:1080').protocol, 'socks5');
  assert.equal(parseBitBrowserProxyInput('https://extract.example.test/api?key=synthetic').mode, 'dynamic');
  assert.equal(parseBitBrowserProxyInput('https://proxy.example.test:443', { mode: 'static' }).mode, 'static');
  for (const link of ['bad-synthetic-secret', 'user@proxy.test:80', 'socks5://proxy.test', 'socks5://proxy.test:80/path']) {
    assert.throws(() => parseBitBrowserProxyInput(link), error => !error.message.includes(link));
  }
});
test('native probing recognizes protocol and only accepts an actual successful exit result', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    assert.equal(url, 'http://127.0.0.1:54345/checkagent'); assert.equal(options.headers['x-api-key'], 'synthetic-key');
    return Response.json({ success: true, data: calls.length === 1 ? { success: false } : { success: true, data: { ip: '8.8.8.8', countryCode: 'ph' } } });
  });
  const result = await testBitBrowserProxy({ link: 'user:synthetic-password@proxy.test:8082', url: 'http://127.0.0.1:54345', token: 'synthetic-key' });
  assert.deepEqual(calls.map(call => call.body.proxyType), ['socks5', 'http']);
  assert.equal(result.protocol, 'http'); assert.match(result.link, /^http:/); assert.equal(result.countryCode, 'PH'); assert.equal(result.ip, '8.8.8.8');
  assert.equal(calls[0].body.checkExists, 0);
});
test('native failures and private or malformed exit addresses are never reported as usable', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: { success: true, data: { ip: '127.0.0.1' } } }));
  await assert.rejects(() => testBitBrowserProxy({ link: 'socks5://user:synthetic-password@proxy.test:1080', url: 'http://127.0.0.1:54345', token: 'synthetic-key' }), error => !error.message.includes('synthetic-password'));
});
test('dynamic extraction can be tested while retaining the extraction URL for the real window', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: { success: true, data: { ip: '8.8.8.8', countryCode: 'US' } } }));
  const link = 'https://extract.example.test/api?key=synthetic';
  const result = await testBitBrowserProxy({ link, protocol: 'socks5', url: 'http://127.0.0.1:54345', token: 'synthetic-key', fetchExtraction: async (url, options) => { assert.equal(url, '/api/local/bitbrowser-proxies/extract'); assert.equal(options.credentials, 'same-origin'); assert.equal(JSON.parse(options.body).link, link); return Response.json({ link: 'socks5://user:synthetic-password@proxy.test:1080', automaticProtocol: false }); } });
  assert.equal(result.mode, 'dynamic'); assert.equal(result.link, link); assert.equal(result.protocol, 'socks5');
});

test('HTTP and explicit-port extraction URLs retain protocol hints for execution', () => {
  for (const link of ['http://extract.example.test/api?protocol=socks5', 'https://extract.example.test:8443/api?proxy_type=socks5']) {
    const parsed = parseBitBrowserProxyInput(link);
    assert.equal(parsed.mode, 'dynamic'); assert.equal(parsed.protocol, 'socks5');
    assert.equal(bitBrowserProxySettings(parsed).dynamicProxyUrl, link);
  }
});
test('extraction failure remains incomplete and never reaches the native probe', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not probe'); });
  await assert.rejects(() => testBitBrowserProxy({ link: 'https://extract.example.test/api?key=synthetic',
    fetchExtraction: async () => Response.json({ error: '提取服务限制访问来源或白名单，未完成检测。', reason: 'extraction' }, { status: 422 })
  }), error => error.reason === 'extraction' && /白名单/.test(error.message) && !error.message.includes('synthetic'));
});

test('a dropped native check retries once, without retrying account operations or hiding repeated failures', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) throw new TypeError('synthetic dropped connection');
    return Response.json({ success: true, data: { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } });
  });
  const input = { link: 'socks5://user:synthetic-pass@proxy.test:1080', url: 'http://127.0.0.1:54345', token: 'synthetic-key' };
  assert.equal((await testBitBrowserProxy(input)).protocol, 'socks5'); assert.equal(calls, 2);
  calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('synthetic dropped connection'); });
  await assert.rejects(() => testBitBrowserProxy(input), e => e.reason === 'bitbrowser_direct_unreachable'); assert.equal(calls, 2);
  calls = 0; const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); throw new TypeError('synthetic dropped connection'); });
  await assert.rejects(() => testBitBrowserProxy({ ...input, signal: controller.signal }), /已取消/); assert.equal(calls, 1);
});

test('the country label is metadata and never becomes a native execution restriction', () => {
  const settings = bitBrowserProxySettings({ link: 'https://extract.example.test/api?key=synthetic', protocol: 'socks5', mode: 'dynamic', countryCode: 'EG' });
  assert.equal(settings.expectedCountryCode, ''); assert.equal(settings.proxyType, 'socks5');
  assert.equal(settings.dynamicProxyUrl, 'https://extract.example.test/api?key=synthetic');
});

test('native timeout is incomplete and auto detection can continue with the next protocol', async t => {
  const timers = [], calls = [];
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 30000); const c = new AbortController(); timers.push(c); return c.signal; });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body).proxyType);
    if (calls.length === 1) { timers[0].abort(); throw new DOMException('synthetic timeout', 'AbortError'); }
    return Response.json({ success: true, data: { success: true, data: { ip: '8.8.8.8', countryCode: 'PH' } } });
  });
  const input = { link: 'user:synthetic-pass@proxy.test:1080', url: 'http://127.0.0.1:54345', token: 'synthetic-key' };
  assert.equal((await testBitBrowserProxy(input)).protocol, 'http'); assert.deepEqual(calls, ['socks5', 'http']);
  timers.length = 0; calls.length = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls.push('request'); timers[0].abort(); throw new DOMException('synthetic timeout', 'AbortError'); });
  await assert.rejects(() => testBitBrowserProxy({ ...input, link: 'socks5://user:synthetic-pass@proxy.test:1080' }), e => e.reason === 'bitbrowser_proxy_probe_timeout' && /30 秒/.test(e.message));
  assert.equal(calls.length, 1, '超时不能被误当成连接中断重复检测');
});

test('extraction rate-limit metadata remains available to the bulk controller', async () => {
  await assert.rejects(() => testBitBrowserProxy({ link: 'https://extract.example.test/api?key=synthetic',
    fetchExtraction: async () => Response.json({ error: '代理提取检测过于频繁，请稍后重试。', reason: 'extraction' }, { status: 429 })
  }), error => error.reason === 'extraction' && error.status === 429 && !error.message.includes('synthetic'));
});
