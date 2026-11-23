import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  findChromeExecutable,
  getFreePort,
  waitForDebuggerReady,
  NativeBrowserError,
  resolveDynamicProxySession,
  parseProxyServerConfig,
  createLocalProxyTunnel
} from '../server/native-chrome-runner.mjs';

test('findChromeExecutable returns string or null', () => {
  const exe = findChromeExecutable();
  if (exe !== null) {
    assert.equal(typeof exe, 'string');
    assert.ok(exe.length > 0);
  }
});

test('getFreePort provides a valid free port', async () => {
  const port = await getFreePort();
  assert.equal(typeof port, 'number');
  assert.ok(port > 1024 && port < 65536);
});

test('waitForDebuggerReady resolves when debug endpoint responds', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fake' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });

  try {
    const data = await waitForDebuggerReady(port, 3000);
    assert.equal(data.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/fake');
  } finally {
    server.close();
  }
});

test('waitForDebuggerReady throws when endpoint unreachable', async () => {
  // Use a port that is unlikely to be running
  const port = await getFreePort();
  await assert.rejects(
    () => waitForDebuggerReady(port, 400),
    (err) => err instanceof NativeBrowserError && err.status === 500
  );
});

test('resolveDynamicProxySession rotates dynamic mobile proxy session IDs with CSPRNG', () => {
  const tpl = 'user-session-{session}';
  const out1 = resolveDynamicProxySession(tpl);
  const out2 = resolveDynamicProxySession(tpl);
  assert.notEqual(out1, tpl);
  assert.match(out1, /^user-session-\d{8}$/);
  assert.match(out2, /^user-session-\d{8}$/);

  const existingSession = 'customer_abc-session-98765432-sessiontime-10';
  const rotated = resolveDynamicProxySession(existingSession);
  assert.match(rotated, /^customer_abc-session-\d{8}-sessiontime-10$/);
  assert.notEqual(rotated, existingSession);

  // Normal static user remains untouched
  assert.equal(resolveDynamicProxySession('static_user'), 'static_user');
  assert.equal(resolveDynamicProxySession(''), '');
});

test('parseProxyServerConfig correctly parses various proxy formats', () => {
  const p1 = parseProxyServerConfig('http://user:pwd@1.2.3.4:8080');
  assert.deepEqual(p1, {
    protocol: 'http:',
    host: '1.2.3.4',
    port: 8080,
    username: 'user',
    password: 'pwd'
  });

  const p2 = parseProxyServerConfig('1.2.3.4:8080:user:pwd');
  assert.deepEqual(p2, {
    protocol: 'http:',
    host: '1.2.3.4',
    port: 8080,
    username: 'user',
    password: 'pwd'
  });

  const p3 = parseProxyServerConfig('1.2.3.4:8080');
  assert.deepEqual(p3, {
    protocol: 'http:',
    host: '1.2.3.4',
    port: 8080,
    username: '',
    password: ''
  });

  const p4 = parseProxyServerConfig('socks5://1.2.3.4:1080');
  assert.deepEqual(p4, {
    protocol: 'socks5:',
    host: '1.2.3.4',
    port: 1080,
    username: '',
    password: ''
  });

  assert.equal(parseProxyServerConfig(''), null);
});

test('createLocalProxyTunnel spins up and closes cleanly', async () => {
  const tunnel = await createLocalProxyTunnel({
    upstreamHost: '127.0.0.1',
    upstreamPort: 9999,
    username: 'myuser',
    password: 'mypassword'
  });
  assert.ok(tunnel.port > 1024);
  assert.equal(tunnel.url, `http://127.0.0.1:${tunnel.port}`);
  await tunnel.close();
});
