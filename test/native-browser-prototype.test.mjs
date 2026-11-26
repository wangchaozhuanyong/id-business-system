import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { acceptWebSocketUpgrade } from '../server/native-ws.mjs';
import {
  attachPrototypeWsBridge,
  launchPrototypeWorkbenchSession,
  resolveProxySessionOnce,
  resolveWorkbenchProxy,
  verifyChatGptLogin,
  verifyProxyExitCountry
} from '../server/native-browser-session.mjs';

test('resolveWorkbenchProxy enforces region proxy requirement and explicit override precedence', () => {
  assert.deepEqual(resolveWorkbenchProxy({ proxyRegion: 'auto', regionProxies: {} }), {
    region: 'auto',
    regionLabel: '自动（直连）',
    expectedCountry: '',
    proxyUrl: ''
  });

  assert.throws(
    () => resolveWorkbenchProxy({ proxyRegion: 'ph', regionProxies: {} }),
    /未配置可用代理/
  );

  const fromRegion = resolveWorkbenchProxy({
    proxyRegion: 'eg',
    regionProxies: { eg: 'http://user:pass@eg.example:8080' }
  });
  assert.equal(fromRegion.expectedCountry, 'EG');
  assert.equal(fromRegion.proxyUrl, 'http://user:pass@eg.example:8080');

  const overridden = resolveWorkbenchProxy({
    proxyRegion: 'ph',
    customProxyUrl: 'http://127.0.0.1:9000',
    regionProxies: { ph: 'http://ph.example:8080' }
  });
  assert.equal(overridden.expectedCountry, 'PH');
  assert.equal(overridden.proxyUrl, 'http://127.0.0.1:9000');
});

test('verifyProxyExitCountry validates country match and blocks mismatches', async () => {
  const ok = await verifyProxyExitCountry({
    proxyUrl: 'http://ph.example:8080',
    expectedCountry: 'PH',
    probeFn: async () => ({ ip: '103.10.20.30', country: 'ph' })
  });
  assert.deepEqual(ok, {
    verified: true,
    ip: '103.10.20.30',
    country: 'PH',
    mode: 'proxy'
  });

  await assert.rejects(
    () =>
      verifyProxyExitCountry({
        proxyUrl: 'http://wrong.example:8080',
        expectedCountry: 'EG',
        probeFn: async () => ({ ip: '1.2.3.4', country: 'US' })
      }),
    /出口国家校验失败：期望 EG，实际检测到 US/
  );

  await assert.rejects(
    () =>
      verifyProxyExitCountry({
        proxyUrl: 'http://down.example:8080',
        expectedCountry: 'PH',
        probeFn: async () => {
          throw new Error('ECONNREFUSED');
        }
      }),
    /代理出口检测失败/
  );
});

test('verifyChatGptLogin distinguishes matched, mismatch, and unauthenticated states', async () => {
  const makeMockCdp = (probeValue) => ({
    ready: Promise.resolve(),
    async send(method) {
      if (method === 'Runtime.evaluate') {
        return { result: { value: probeValue } };
      }
      return {};
    },
    onEvent: () => () => {},
    close: () => {}
  });

  const matched = await verifyChatGptLogin({
    port: 9222,
    expectedEmail: 'User@Example.com',
    getTargetWsUrlFn: async () => 'ws://127.0.0.1:9222/devtools/page/1',
    createCdpClientFn: () =>
      makeMockCdp({ loggedIn: true, email: 'user@example.com', url: 'https://chatgpt.com/' })
  });
  assert.equal(matched.status, 'matched');
  assert.equal(matched.loggedIn, true);

  const mismatch = await verifyChatGptLogin({
    port: 9222,
    expectedEmail: 'expected@example.com',
    getTargetWsUrlFn: async () => 'ws://127.0.0.1:9222/devtools/page/1',
    createCdpClientFn: () =>
      makeMockCdp({ loggedIn: true, email: 'other@example.com', url: 'https://chatgpt.com/' })
  });
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.actualEmail, 'other@example.com');

  const unauth = await verifyChatGptLogin({
    port: 9222,
    expectedEmail: 'user@example.com',
    getTargetWsUrlFn: async () => 'ws://127.0.0.1:9222/devtools/page/1',
    createCdpClientFn: () =>
      makeMockCdp({ loggedIn: false, status: 401, reason: 'me_unauthorized', url: 'https://chatgpt.com/' })
  });
  assert.equal(unauth.status, 'unauthenticated');
  assert.equal(unauth.loggedIn, false);
});

test('launchPrototypeWorkbenchSession wires proxy verification, Chrome launch, and real login check', async () => {
  const sessionJson = JSON.stringify({
    user: { email: 'test@example.com' },
    sessionToken: 'tok_abc_123',
    deviceId: 'dev_001',
    account: { planType: 'free' }
  });

  let launchedArgs = null;
  const result = await launchPrototypeWorkbenchSession({
    sessionJson,
    proxyRegion: 'ph',
    ownerId: 'admin-1',
    regionProxies: { ph: 'http://u:p@ph.proxy:8080' },
    probeFn: async () => ({ ip: '103.55.66.77', country: 'PH' }),
    launchChromeFn: async (args) => {
      launchedArgs = args;
      return { ok: true, pid: 4242, port: 19222, profileDir: '/tmp/proto' };
    },
    verifyLoginFn: async ({ port, expectedEmail }) => ({
      status: 'matched',
      loggedIn: true,
      actualEmail: expectedEmail,
      expectedEmail,
      message: `登录核验通过：${expectedEmail}`
    })
  });

  assert.equal(result.ok, true);
  assert.ok(result.profileKey.startsWith('proto_'));
  assert.equal(launchedArgs.proxyUrl, 'http://u:p@ph.proxy:8080');
  assert.equal(launchedArgs.skipSessionRotation, true);
  assert.equal(launchedArgs.ownerId, 'admin-1');
  assert.equal(result.proxy.exitInfo.country, 'PH');
  assert.equal(result.loginVerification.status, 'matched');

  const rotatedOnce = resolveProxySessionOnce('gate.ipdeep.com:8082:user-session-12345-sessiontime-5:pass');
  assert.match(rotatedOnce, /^http:\/\/user-session-\d+-sessiontime-5:pass@gate\.ipdeep\.com:8082$/);
  assert.equal(resolveProxySessionOnce(rotatedOnce) !== rotatedOnce || !rotatedOnce.includes('12345'), true);
});

test('acceptWebSocketUpgrade and attachPrototypeWsBridge stream frames and forward input', async () => {
  const cdpEvents = new EventEmitter();
  const cdpCalls = [];
  const mockCdp = {
    ready: Promise.resolve(),
    async send(method, params) {
      cdpCalls.push({ method, params });
      return {};
    },
    onEvent(fn) {
      cdpEvents.on('event', fn);
      return () => cdpEvents.off('event', fn);
    },
    close() {}
  };

  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocketUpgrade(req, socket, head);
    void attachPrototypeWsBridge({
      ws,
      profileKey: 'proto_demo',
      ownerId: 'admin-1',
      getBrowserFn: () => ({ port: 19222, ownerId: 'admin-1', exitInfo: { country: 'PH', ip: '1.2.3.4' } }),
      getTargetWsUrlFn: async () => 'ws://127.0.0.1:19222/devtools/page/1',
      createCdpClientFn: () => mockCdp,
      verifyLoginFn: async ({ expectedEmail }) => ({
        status: 'matched',
        loggedIn: true,
        actualEmail: expectedEmail,
        expectedEmail
      })
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const received = [];
  const client = new globalThis.WebSocket(`ws://127.0.0.1:${port}/integrations/native-workbench/ws?profileKey=proto_demo`);

  await new Promise((resolve, reject) => {
    client.onerror = reject;
    client.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      received.push(msg);
      if (msg.type === 'ready') {
        cdpEvents.emit('event', {
          method: 'Page.screencastFrame',
          params: { data: 'ZmFrZV9qcGVn', metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 7 }
        });
        client.send(JSON.stringify({ type: 'mouse', eventType: 'mousePressed', x: 100, y: 200, button: 'left' }));
        client.send(JSON.stringify({ type: 'text', text: '4242' }));
        client.send(JSON.stringify({ type: 'recheckLogin', expectedEmail: 'a@b.com' }));
      } else if (msg.type === 'loginVerification') {
        resolve();
      }
    };
  });

  client.close();
  await new Promise((resolve) => server.close(resolve));

  assert.ok(received.some((m) => m.type === 'ready' && m.exitInfo?.country === 'PH'));
  assert.ok(received.some((m) => m.type === 'frame' && m.data === 'ZmFrZV9qcGVn'));
  assert.ok(received.some((m) => m.type === 'loginVerification' && m.verification?.status === 'matched'));
  assert.ok(cdpCalls.some((c) => c.method === 'Page.startScreencast'));
  assert.ok(cdpCalls.some((c) => c.method === 'Page.screencastFrameAck' && c.params?.sessionId === 7));
  assert.ok(cdpCalls.some((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.x === 100));
  assert.ok(cdpCalls.some((c) => c.method === 'Input.insertText' && c.params?.text === '4242'));
});
