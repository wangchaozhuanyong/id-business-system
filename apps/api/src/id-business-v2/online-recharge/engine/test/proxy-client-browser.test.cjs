'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('../upstream/node_modules/playwright');
const { runProxyClientDiagnostic } = require('../proxy-client-diagnostic.cjs');
const { observeSessionRequests } = require('../subscription-diagnostics.cjs');
async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw Error('fixture observation incomplete');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Only loopback TLS/CONNECT listeners; synthetic key remains in memory. The
// test context accepts this certificate only while all egress is denied except
// the two synthetic hostnames forwarded by this local proxy.
async function fixture(t) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const cert = execFileSync(
    '/bin/sh',
    ['-c', 'cat | openssl req -new -x509 -key /dev/stdin -sha256 -days 1 -subj /CN=localhost'],
    { input: key, timeout: 5000 }
  );
  const requests = [],
    tunnels = [],
    sockets = new Set();
  const server = https.createServer({ key, cert }, (req, res) => {
    requests.push({
      method: req.method,
      host: req.headers.host,
      url: req.url,
      cookiePresent: Boolean(req.headers.cookie),
      client:
        req.headers['sec-fetch-dest'] === 'document'
          ? 'navigation'
          : req.headers['sec-fetch-mode']
            ? 'same_origin_fetch'
            : 'context_request'
    });
    if (
      req.headers.host === 'api.ipify.org' &&
      req.method === 'GET' &&
      req.url === '/?format=text'
    ) {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('198.51.100.9');
    } else if (req.headers.host === 'chatgpt.com' && req.url === '/api/auth/session') {
      const isFetch = req.headers['sec-fetch-dest'] !== 'document';
      res.writeHead(isFetch ? 403 : 200, {
        'content-type': isFetch ? 'text/html' : 'application/json',
        'cache-control': 'no-store',
        ...(isFetch ? { 'cf-mitigated': 'challenge' } : {})
      });
      res.end(isFetch ? '<html>synthetic challenge</html>' : '{}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const proxy = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  const track = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  };
  server.on('connection', track);
  proxy.on('connection', track);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  proxy.on('connect', (req, client, head) => {
    if (!['api.ipify.org:443', 'chatgpt.com:443'].includes(req.url)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    tunnels.push(req.url);
    const upstream = net.connect(server.address().port, '127.0.0.1');
    track(upstream);
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => proxy.close(r))]);
  });
  const proxyConfig = { server: `http://127.0.0.1:${proxy.address().port}` };
  const isolated = {
    launch: async (options) => {
      const browser = await chromium.launch({
        ...options,
        executablePath: chromium.executablePath(),
        args: [
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        ]
      });
      const original = browser.newContext.bind(browser);
      browser.newContext = (contextOptions) =>
        original({ ...contextOptions, ignoreHTTPSErrors: true });
      return browser;
    }
  };
  return { requests, tunnels, proxyConfig, chromium: isolated };
}

test(
  'real isolated Chromium navigation/fetch/APIRequest traverse the same local CONNECT proxy in exactly five echo requests',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const result = await runProxyClientDiagnostic({
      proxyConfig: f.proxyConfig,
      chromium: f.chromium,
      timeoutMs: 20000
    });
    assert.equal(result.outcome, 'observations_match', JSON.stringify(result));
    assert.equal(result.requestsIssued, 5);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(f.requests.length, 5);
    assert.ok(f.requests.every((r) => r.host === 'api.ipify.org' && !r.cookiePresent));
    assert.deepEqual(
      f.requests.map((r) => r.client),
      ['navigation', 'context_request', 'same_origin_fetch', 'context_request', 'same_origin_fetch']
    );
    assert.ok(f.tunnels.every((x) => x === 'api.ipify.org:443'));
    assert.ok(!JSON.stringify(result).includes('198.51.100.9'));
  }
);

test(
  'real passive CDP observes existing synthetic document and fetch without creating additional Session requests',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      events = [];
    const browser = await f.chromium.launch({ headless: true, proxy: f.proxyConfig });
    const context = await browser.newContext({ proxy: f.proxyConfig });
    const observer = observeSessionRequests(context, (row) => events.push(row));
    try {
      const page = await context.newPage();
      // Fixture waits for instrumentation; the real task never waits on it.
      await until(() => events.some((x) => x.event === 'connection_observer' && x.complete));
      await page.goto('https://chatgpt.com/api/auth/session');
      // Same-origin synthetic URL, forwarded only to the loopback TLS fixture.
      const status = await page.evaluate(async () => (await fetch('/api/auth/session')).status);
      assert.equal(status, 403);
      await until(() => events.filter((x) => x.event === 'connection_response').length === 2);
      const rows = events.filter((x) => x.event === 'connection_response');
      assert.deepEqual(
        rows.map((x) => x.httpStatus),
        [200, 403]
      );
      assert.ok(
        rows.every(
          (x) => Number.isSafeInteger(x.connectionId) && typeof x.connectionReused === 'boolean'
        )
      );
      assert.equal(rows[1].cfMitigated, 'challenge');
      assert.equal(f.requests.filter((x) => x.url === '/api/auth/session').length, 2);
    } finally {
      observer.dispose();
      await browser.close();
    }
  }
);
