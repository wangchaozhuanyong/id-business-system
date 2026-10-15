'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveProxy, parseExtracted, isPublic } = require('../proxy-connection.cjs');
const rpc = require('../rpc.cjs');
const store = require('../upstream/mysql-store.js');
test('direct proxy substitutes one session for all placeholders and keeps protocol', async () => {
  const result = await resolveProxy({
    proxy_url: 'socks5://u-{session}:p-{session}@gateway.example.test:1080',
    protocol: 'socks5',
    connectionMode: 'direct'
  });
  const url = new URL(result);
  assert.equal(url.username.slice(2), url.password.slice(2));
  assert.ok(!result.includes('{session}'));
});
test('extraction understands JSON, plain endpoint and provider credentials', async () => {
  assert.equal(parseExtracted('8.8.8.8:8080', 'http'), 'http://8.8.8.8:8080');
  const result = await resolveProxy(
    {
      proxy_url: 'https://provider.example.test/api',
      protocol: 'socks5',
      connectionMode: 'extraction'
    },
    async () => JSON.stringify({ data: { ip: '8.8.8.8', port: 1080, user: 'user', pass: 'pass' } })
  );
  assert.equal(result, 'socks5://user:pass@8.8.8.8:1080');
  assert.equal(parseExtracted('8.8.8.8:8080:user:pass', 'http'), 'http://user:pass@8.8.8.8:8080');
});
test('invalid responses and extraction failures cannot fall back to direct access', async () => {
  for (const value of [
    'garbage',
    '127.0.0.1:8080',
    '10.0.0.1:8080',
    'http://8.8.8.8:8080/path',
    'https://8.8.8.8:443',
    JSON.stringify({ host: 'localhost', port: 8080 })
  ])
    assert.throws(() => parseExtracted(value, 'http'));
  for (const fetcher of [
    async () => {
      throw new Error('timeout secret');
    },
    async () => '<html>bad response</html>'
  ])
    await assert.rejects(
      resolveProxy(
        {
          proxy_url: 'https://provider.example.test/?token=fixture-secret',
          connectionMode: 'extraction',
          protocol: 'http'
        },
        fetcher
      ),
      (error) =>
        !error.message.includes('fixture-secret') && !error.message.includes('timeout secret')
    );
  await assert.rejects(resolveProxy(null), /没有可用代理/);
  assert.equal(isPublic('169.254.169.254'), false);
  assert.equal(isPublic('::ffff:127.0.0.1'), false);
  assert.equal(isPublic('8.8.8.8'), true);
});
test('one execution caches resolution and clears it with task credentials', async () => {
  store.clearCredentials();
  let calls = 0;
  rpc.setTransportForTest(async (method) => {
    assert.equal(method, 'getActiveProxy');
    calls++;
    return {
      proxy_url: 'http://u-{session}:pass@gateway.example.test:8080',
      protocol: 'http',
      connectionMode: 'direct'
    };
  });
  const [a, b] = await Promise.all([store.getActiveProxy(), store.getActiveProxy()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  store.clearCredentials();
  assert.notEqual(await store.getActiveProxy(), a);
  assert.equal(calls, 2);
  store.clearCredentials();
});

test('failed proxy resolution writes a failed detection instead of leaving stale success', async () => {
  store.clearCredentials();
  let report;
  rpc.setTransportForTest(async (method, args) => {
    if (method === 'getActiveProxy')
      return { proxy_url: 'http://127.0.0.1:8080', protocol: 'http' };
    assert.equal(method, 'proxyTestResult');
    report = args;
    return { ok: true };
  });
  const result = await require('../task-runner.cjs').execute(
    { operation: 'proxy_test', payload: { proxyId: 'synthetic-failed-proxy' } },
    {}
  );
  assert.equal(result.success, false);
  assert.equal(report.ok, false);
  assert.equal(report.proxyId, 'synthetic-failed-proxy');
  assert.equal(report.latencyMs, null);
  store.clearCredentials();
});
