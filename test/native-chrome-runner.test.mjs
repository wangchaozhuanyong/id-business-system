import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acceptWebSocketUpgrade } from '../server/native-ws.mjs';
import {
  findChromeExecutable,
  getPageTargetWsUrl,
  injectCookiesAndNavigate,
  waitForProfileDebugger,
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

const oldBrowser = '/devtools/browser/11111111-1111-4111-8111-111111111111';
const newBrowser = '/devtools/browser/22222222-2222-4222-8222-222222222222';

test('a stale DevTools marker never establishes a session, and a fresh marker must match the browser endpoint', async () => {
  const temporaryRoot = path.resolve('.runtime');
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const profileDir = await mkdtemp(path.join(temporaryRoot, 'test-devtools-marker-'));
  const markerFile = path.join(profileDir, 'DevToolsActivePort');
  let debuggerPath = oldBrowser;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://' + req.headers.host + debuggerPath }));
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

  const oldMarker = port + '\n' + oldBrowser;
  const rejectUnverified = () => assert.rejects(
    waitForProfileDebugger(profileDir, oldMarker, () => true, 100),
    (err) => err instanceof NativeBrowserError && err.status === 500
  );
  try {
    await writeFile(markerFile, oldMarker);
    await rejectUnverified();
    assert.equal(requests, 0, 'never query the port in the preserved stale marker');
    await writeFile(markerFile, port + '\n' + newBrowser);
    await rejectUnverified();
    assert.ok(requests > 0, 'reject a listener that reports the wrong browser identity');
    debuggerPath = newBrowser;
    assert.deepEqual(await waitForProfileDebugger(profileDir, oldMarker, () => true, 3000), {
      port, browserDebuggerPath: newBrowser
    });
  } finally {
    server.close();
    await rm(profileDir, { recursive: true });
  }
});

test('page target lookup refuses a reused port and never creates a page on it', async () => {
  const pagePath = '/devtools/page/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const requests = [];
  let debuggerPath = oldBrowser;
  let changeDuringLookup = true;
  let pageAvailable = true;
  const server = http.createServer((req, res) => {
    requests.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/json/version') {
      res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://' + req.headers.host + debuggerPath }));
    } else if (req.url === '/json/list') {
      if (changeDuringLookup) debuggerPath = newBrowser;
      res.end(JSON.stringify(pageAvailable ?
        [{ type: 'page', webSocketDebuggerUrl: 'ws://' + req.headers.host + pagePath }] : []));
    } else {
      assert.fail('Unexpected DevTools request');
    }
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    await assert.rejects(getPageTargetWsUrl(port, oldBrowser), /调试身份无法核对/);
    assert.deepEqual(requests.splice(0), [['GET', '/json/version'], ['GET', '/json/list'], ['GET', '/json/version']]);
    changeDuringLookup = false;
    await assert.rejects(getPageTargetWsUrl(port, oldBrowser), /调试身份无法核对/);
    assert.deepEqual(requests.splice(0), [['GET', '/json/version']]);
    assert.equal(await getPageTargetWsUrl(port, newBrowser), 'ws://127.0.0.1:' + port + pagePath);
    requests.length = 0;
    pageAvailable = false;
    await assert.rejects(getPageTargetWsUrl(port, newBrowser), /未找到可用的/);
    assert.deepEqual(requests, [['GET', '/json/version'], ['GET', '/json/list']]);
  } finally {
    server.close();
  }
});

test('cookie and navigation setup settles if the debugger closes or stops replying', async () => {
  const commands = [];
  const server = http.createServer();
  let closeOnCommand = true;
  server.on('upgrade', (request, socket, head) => {
    const ws = acceptWebSocketUpgrade(request, socket, head);
    ws.onMessage((raw) => {
      commands.push(JSON.parse(raw).method);
      if (closeOnCommand) ws.close();
    });
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const endpoint = 'ws://127.0.0.1:' + port + '/devtools/page/fixture';
  try {
    await assert.rejects(injectCookiesAndNavigate(endpoint, [], 'about:blank', 2000), /调试连接已关闭/);
    assert.deepEqual(commands, ['Network.enable']);
    closeOnCommand = false;
    await assert.rejects(injectCookiesAndNavigate(endpoint, [], 'about:blank', 200), /调试操作超时/);
    assert.deepEqual(commands, ['Network.enable', 'Network.enable']);
  } finally {
    server.close();
  }
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
