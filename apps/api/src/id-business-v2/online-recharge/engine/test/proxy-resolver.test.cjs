'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProxy, extractedValue } = require('../proxy-resolver.cjs');
const rpc = require('../rpc.cjs');
const store = require('../upstream/mysql-store');
const security = require('../security.cjs');
const extractionUrl =
  'https://api.ipdeep.com/api/Pro/DynamicIp/GetIpByGenerateLink?id=synthetic-only';
test.afterEach(() => {
  store.clearCredentials();
  rpc.clearTask();
  rpc.setTransportForTest(null);
  security.clearSecrets();
});
test('direct URI and four-part gateways preserve authentication', async () => {
  assert.equal(
    await resolveProxy('gateway.example.invalid:8082:synthetic-user:synthetic:p@ss'),
    'http://synthetic-user:synthetic%3Ap%40ss@gateway.example.invalid:8082'
  );
  assert.equal(
    await resolveProxy('socks5://synthetic-user:synthetic@gateway.example.invalid:1080'),
    'socks5://synthetic-user:synthetic@gateway.example.invalid:1080'
  );
  assert.equal(
    extractedValue({ data: ['gateway.example.invalid:8082:synthetic-user:synthetic-pass'] }),
    'http://synthetic-user:synthetic-pass@gateway.example.invalid:8082'
  );
});
test('IPDEEP extraction only fetches once per task even for concurrent lookups; next task fetches again', async (t) => {
  let fetched = 0,
    lookups = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    fetched++;
    assert.equal(options.redirect, 'error');
    return new Response(
      JSON.stringify(`gateway.example.invalid:8082:synthetic-session-${fetched}:synthetic-pass`)
    );
  });
  rpc.setTransportForTest(async () => {
    lookups++;
    return { proxy_url: extractionUrl, protocol: 'extraction' };
  });
  rpc.configureTask({ id: 'first', leaseVersion: 1 });
  const [a, b] = await Promise.all([store.getActiveProxy(), store.getActiveProxy()]);
  assert.equal(a, b);
  assert.equal(fetched, 1);
  assert.equal(lookups, 1);
  rpc.configureTask({ id: 'next', leaseVersion: 1 });
  const next = await store.getActiveProxy();
  assert.notEqual(a, next);
  assert.equal(fetched, 2);
  assert.equal(security.redactText(extractionUrl), '[已隐藏]');
  assert.equal(security.redactText('synthetic-pass'), '[已隐藏]');
});
test('extraction errors, oversized response and unapproved endpoints fail without exposing credentials or fallback', async () => {
  let fetched = 0;
  const fakeFetch = async () => {
    fetched++;
    return new Response('gateway.example.invalid:8082:user:pass');
  };
  await assert.rejects(
    resolveProxy(
      { proxy_url: 'http://127.0.0.1/path?id=synthetic', protocol: 'extraction' },
      { fetch: fakeFetch }
    ),
    /地址无效/
  );
  await assert.rejects(
    resolveProxy(
      {
        proxy_url:
          'https://api.ipdeep.com.evil.invalid/api/Pro/DynamicIp/GetIpByGenerateLink?id=synthetic',
        protocol: 'extraction'
      },
      { fetch: fakeFetch }
    ),
    /地址无效/
  );
  assert.equal(fetched, 0);
  await assert.rejects(
    resolveProxy(extractionUrl, { fetch: async () => new Response('x'.repeat(17000)) }),
    /提取失败/
  );
  await assert.rejects(
    resolveProxy(extractionUrl, {
      fetch: async () => new Response('supplier-error', { status: 429 })
    }),
    /提取失败/
  );
  assert.throws(() => extractedValue(['a:80:u:p', 'b:80:u:p']), /一个连接端点/);
});
test('session placeholder is stable inside a task and changes only for a later task', async () => {
  rpc.setTransportForTest(async () => ({
    proxy_url: 'http://user-{session}:synthetic@gateway.example.invalid:8082'
  }));
  rpc.configureTask({ id: 'first', leaseVersion: 1 });
  const first = await store.getActiveProxy();
  assert.equal(first, await store.getActiveProxy());
  assert.doesNotMatch(first, /\{session\}/);
  rpc.configureTask({ id: 'second', leaseVersion: 1 });
  assert.notEqual(first, await store.getActiveProxy());
});
