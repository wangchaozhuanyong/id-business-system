import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBitBrowserProxyWrite, summarizeBitBrowserProxies, readBitBrowserProxy } from '../server/bitbrowser-proxies.mjs';
const input = { version: 0, name: '办公室移动 IP', countryCode: 'ph', kind: 'mobile', mode: 'static', protocol: 'http', link: 'socks5://test-user:test-password@192.0.2.1:1080' };
test('IP metadata is separated from credentials and the selected country follows the saved IP', () => {
  const { proxy } = validateBitBrowserProxyWrite(input);
  assert.equal(proxy.countryCode, 'PH'); assert.equal(proxy.protocol, 'socks5');
  const summary = summarizeBitBrowserProxies([proxy]);
  assert.equal(summary[0].endpoint, '192.0.2.1:1080');
  assert(!JSON.stringify(summary).includes('test-password'));
  assert.equal(readBitBrowserProxy({ version: 1, data: [proxy] }, { id: proxy.id, version: 1 }), proxy);
  assert.throws(() => readBitBrowserProxy({ version: 2, data: [proxy] }, { id: proxy.id, version: 1 }), { status: 409 });
});
test('dynamic extraction supports separate protocol and keeps query credentials out of summaries', () => {
  const { proxy } = validateBitBrowserProxyWrite({ ...input, mode: 'dynamic', protocol: 'socks5', link: 'https://proxy.example.test/extract?key=test-extraction-key' });
  assert.equal(proxy.protocol, 'socks5');
  assert(!JSON.stringify(summarizeBitBrowserProxies([proxy])).includes('test-extraction-key'));
});
test('invalid proxy metadata, malformed URL and injected fields are rejected', () => {
  for (const changes of [{ countryCode: 'China' }, { kind: 'unknown' }, { link: 'not-a-link' }, { mode: 'direct' }, { version: -1 },
    { link: 'socks5://proxy.example.test' }, { link: 'http://user@proxy.example.test:8080' }, { mode: 'dynamic', link: 'http://proxy.example.test/?key=test' },
    { ownerId: 'another-user' }, { link: 'http://proxy.example.test:8080/path' }])
    assert.throws(() => validateBitBrowserProxyWrite({ ...input, ...changes }), { status: 400 });
});

test('editing keeps the existing secret and id, but requires a new link for protocol or mode changes', () => {
  const { proxy } = validateBitBrowserProxyWrite(input);
  const edited = validateBitBrowserProxyWrite({ ...input, id: proxy.id, version: 1, protocol: proxy.protocol, name: '新名称', link: '' }, proxy).proxy;
  assert.equal(edited.id, proxy.id); assert.equal(edited.link, proxy.link); assert.equal(edited.name, '新名称');
  assert.throws(() => validateBitBrowserProxyWrite({ ...input, id: proxy.id, link: '' }, proxy), { status: 400 });
  assert.throws(() => validateBitBrowserProxyWrite({ ...input, id: proxy.id }, undefined), { status: 404 });
});

test('simple form infers a raw proxy connection and accepts an automatically detected country', () => {
  const { proxy } = validateBitBrowserProxyWrite({ version: 0, name: '住宅代理', kind: 'dynamic_residential', link: 'user:synthetic-pass@proxy.example.test:8082' });
  assert.equal(proxy.countryCode, ''); assert.equal(proxy.mode, 'static'); assert.equal(proxy.protocol, 'socks5');
  assert.match(proxy.link, /^socks5:/);
});
