'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../proxy-test.cjs');
const rpc = require('../rpc.cjs');
const { isPublic } = require('../proxy-connection.cjs');

const proxyUrl = 'socks5://synthetic-user:synthetic-password@gateway.example.test:1080';
const response = (data, status = 200, contentType = 'text/plain') => ({
  data,
  status,
  headers: { 'content-type': contentType }
});

test('exit detection accepts complete public IPv4 and IPv6 addresses only', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublic(ip), true, ip);
    assert.equal(probe.exitIp(response(` ${ip}\n`)), ip);
  }
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.0.2.10',
    '224.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    '2001:db8::1',
    '2001::1',
    '2002:0808:0808::1',
    '3fff::1',
    '2606:4700::1111%en0',
    '999.1.1.1'
  ]) {
    assert.equal(isPublic(ip), false, ip);
    assert.equal(probe.exitIp(response(ip)), null, ip);
  }
});

test('HTTP 200 HTML, empty, JSON, login text and an IP followed by text are failures', () => {
  for (const data of [
    '',
    '   ',
    '<html>Authentication required</html>',
    'Authentication required',
    '8.8.8.8 login required',
    '8.8.8.8\n1.1.1.1',
    '{"ip":"8.8.8.8"}',
    { ip: '8.8.8.8' },
    ['8.8.8.8']
  ])
    assert.equal(probe.exitIp(response(data)), null);
  assert.equal(probe.exitIp(response('8.8.8.8', 200, 'text/html')), null);
  assert.equal(probe.exitIp(response('8.8.8.8', 407)), null);
});

test('a failed primary probe uses a second probe through the same explicit proxy agent', async () => {
  const calls = [];
  let created = 0;
  let destroyed = 0;
  const agent = { destroy: () => destroyed++ };
  const result = await probe.testProxyUrl(proxyUrl, {
    createAgent: (raw) => {
      assert.equal(raw, proxyUrl);
      created++;
      return agent;
    },
    request: async (url, config) => {
      calls.push(url);
      assert.equal(config.httpAgent, agent);
      assert.equal(config.httpsAgent, agent);
      assert.equal(config.proxy, false);
      assert.equal(config.maxRedirects, 0);
      assert.equal(config.maxContentLength, 1024);
      assert.equal(config.responseType, 'text');
      return calls.length === 1
        ? response('<html>invalid response</html>')
        : response('2606:4700:4700::1111\n');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.ip, '2606:4700:4700::1111');
  assert.deepEqual(calls, probe.PROBE_URLS);
  assert.equal(created, 1);
  assert.equal(destroyed, 1);
});

test('invalid responses from both probes cannot be reported as connectivity success', async () => {
  const result = await probe.testProxyUrl(proxyUrl, {
    createAgent: () => ({ destroy() {} }),
    request: async () => response('<html>Proxy login failed synthetic-password</html>')
  });
  assert.equal(result.ok, false);
  assert.equal(result.ip, null);
  assert.equal(result.errorCode, 'invalid_exit_ip');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password|<html>|gateway/);
});

test('connection and authentication errors return controlled descriptions without secret text', async () => {
  for (const [code, expected] of [
    ['ETIMEDOUT', 'connection_timeout'],
    ['ECONNABORTED', 'connection_timeout'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ENOTFOUND', 'proxy_dns_failed'],
    ['CERT_HAS_EXPIRED', 'proxy_tls_failed'],
    ['ECONNRESET', 'network_error']
  ]) {
    const result = await probe.testProxyUrl(proxyUrl, {
      createAgent: () => ({ destroy() {} }),
      request: async () => {
        throw Object.assign(new Error(`connection failed ${proxyUrl}`), { code });
      }
    });
    assert.equal(result.errorCode, expected);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-user|synthetic-password|gateway/);
  }
  for (const status of [401, 407]) {
    const result = await probe.testProxyUrl(proxyUrl, {
      createAgent: () => ({ destroy() {} }),
      request: async () => response('password=synthetic-password', status)
    });
    assert.equal(result.errorCode, 'proxy_auth_failed');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-password/);
  }
});

test('a fallback network failure cannot hide a primary proxy authentication failure', async () => {
  let calls = 0;
  const result = await probe.testProxyUrl(proxyUrl, {
    createAgent: () => ({ destroy() {} }),
    request: async () => {
      if (++calls === 1) return response('authentication required', 407);
      throw Object.assign(new Error('network failure'), { code: 'ECONNRESET' });
    }
  });
  assert.equal(result.errorCode, 'proxy_auth_failed');
  assert.equal(calls, 2);
});

test('default proxy agent resolves the dependency installed inside the frozen upstream package', async () => {
  const result = await probe.testProxyUrl(proxyUrl, {
    request: async (_, config) => {
      assert.equal(config.httpsAgent.constructor.name, 'ProxyAgent');
      return response('8.8.8.8');
    }
  });
  assert.equal(result.ok, true);
});

test('invalid or unsupported proxy cannot issue a probe or fall back to direct traffic', async () => {
  for (const raw of ['', 'invalid', 'ftp://8.8.8.8:1080']) {
    const result = await probe.testProxyUrl(raw, {
      createAgent: () => assert.fail('must not create agent'),
      request: async () => assert.fail('must not access network')
    });
    assert.equal(result.errorCode, 'unsupported_protocol');
  }
});

test('lease loss while resolving a proxy never submits a stale failed result', async () => {
  const store = require('../upstream/mysql-store');
  store.clearCredentials();
  const methods = [];
  rpc.setTransportForTest(async (method) => {
    methods.push(method);
    throw new rpc.LeaseLostError();
  });
  try {
    await assert.rejects(
      require('../task-runner.cjs').execute({
        operation: 'proxy_test',
        payload: { proxyId: 'synthetic-stale-proxy' }
      }),
      (error) => error.code === 'LEASE_LOST'
    );
    assert.deepEqual(methods, ['getActiveProxy']);
  } finally {
    rpc.setTransportForTest(null);
    store.clearCredentials();
  }
});

test('preparation failure returns per-proxy failure and tries to persist it under the task lease', async () => {
  const { runTask } = require('../task-runner.cjs');
  const originalConsole = Object.fromEntries(
    ['log', 'warn', 'error', 'info', 'debug'].map((name) => [name, console[name]])
  );
  const originalSend = process.send;
  const originalConnected = process.connected;
  const protectedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /CHATGPT_|CDK_CODE|PROXY|API_KEY|WORKER_KEY/.test(key)
    )
  );
  const reports = [];
  const sent = [];
  process.connected = true;
  process.send = (item) => sent.push(item);
  rpc.setTransportForTest(async (method, args) => {
    if (method === 'getRuntimeConfig') throw new Error(`untrusted failure ${proxyUrl}`);
    assert.equal(method, 'proxyTestResult');
    reports.push(args);
    return { ok: true };
  });
  try {
    await runTask({
      id: 'synthetic-preparation-task',
      workerId: 'synthetic-worker',
      leaseId: 'synthetic-lease',
      leaseVersion: 2,
      operation: 'proxy_test',
      payload: { ids: ['synthetic-proxy', 'synthetic-proxy'] }
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ok, false);
    assert.equal(reports[0].taskId, 'synthetic-preparation-task');
    assert.equal(reports[0].leaseVersion, 2);
    assert.equal(reports[0].errorCode, 'execution_failed');
    assert.equal(sent.at(-1).status, 'failed');
    assert.equal(sent.at(-1).result.results[0].proxyId, 'synthetic-proxy');
    assert.doesNotMatch(JSON.stringify({ reports, sent }), /synthetic-password|gateway/);
  } finally {
    Object.assign(console, originalConsole);
    process.send = originalSend;
    process.connected = originalConnected;
    Object.assign(process.env, protectedEnv);
    rpc.setTransportForTest(null);
  }
});

test('result write failure retains the actual probe outcome instead of inventing a connectivity failure', async () => {
  const store = require('../upstream/mysql-store');
  store.clearCredentials();
  const originalProbe = probe.testProxyUrl;
  const methods = [];
  probe.testProxyUrl = async () => ({ ok: true, ip: '8.8.8.8', latencyMs: 12 });
  rpc.setTransportForTest(async (method) => {
    methods.push(method);
    if (method === 'getActiveProxy') return { proxy_url: proxyUrl };
    throw new Error('synthetic response lost');
  });
  const task = { operation: 'proxy_test', payload: { proxyId: 'synthetic-report-proxy' } };
  try {
    await assert.rejects(require('../task-runner.cjs').execute(task), (error) => {
      const result = probe.taskFailure(task, error);
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'result_write_failed');
      assert.equal(result.results[0].ok, true);
      assert.equal(result.results[0].ip, '8.8.8.8');
      assert.equal(result.results[0].latencyMs, 12);
      return true;
    });
    assert.deepEqual(methods, ['getActiveProxy', 'proxyTestResult']);
  } finally {
    probe.testProxyUrl = originalProbe;
    rpc.setTransportForTest(null);
    store.clearCredentials();
  }
});
