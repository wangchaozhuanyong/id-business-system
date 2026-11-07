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
