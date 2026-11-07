import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { runBitBrowserJsonLogin } from '../modules/recharge/bitbrowser/login/index.mjs';

const profileId = 'a'.repeat(32);
const authorizationToken = 'login-fixture-authorization';
const localApiKey = 'login-fixture-local-api';
const groupName = 'gpt账号注册';
const tagName = '申请gpt';
const windowName = 'ChatGPT-user';
const origin = 'http://127.0.0.1:4348';
const websocketUrl = 'ws://127.0.0.1:9222/devtools/browser/fixture';
const identity = {
  kind: 'identity',
  email: 'user@example.test',
  userId: 'user-fixture',
  accountId: 'account-fixture',
  plan: 'free'
};

const freshProfileApi = [
  '/health',
  '/group/list',
  '/browserTag/list',
  '/browser/update',
  '/browserTag/updateRelation',
  '/browser/detail',
  '/browser/open'
];

function localAuthorization() {
  return JSON.stringify({
    sessionToken: authorizationToken,
    user: { id: identity.userId, email: identity.email },
    account: { id: identity.accountId }
  });
}

async function withLoginFixture(observedIdentity, useFixture) {
  const requests = [];
  const commands = [];
  const errors = [];
  let profile;
  let sessionCookieApplied = false;
  let officialTabOpen = false;
  let socketClosed = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['x-api-key'], localApiKey);
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.authorization, undefined);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      assert.equal(rawBody.includes(authorizationToken), false);
      const body = JSON.parse(rawBody);
      requests.push({ path: request.url, body });

      let data;
      switch (request.url) {
        case '/health':
          break;
        case '/group/list':
          assert.deepEqual(body, { page: 0, pageSize: 100, all: true });
          data = { list: [{ id: 'fixture-group', groupName }] };
          break;
        case '/browserTag/list':
          data = [{ id: 'fixture-tag', tagName }];
          break;
        case '/browser/update':
          if (body.id) {
            assert.equal(body.id, profileId);
            for (const key of ['cookie', 'password', 'browserFingerPrint']) assert(!Object.hasOwn(body, key));
            profile = { ...profile, ...body }; data = { id: profileId }; break;
          }
          assert.equal(body.groupId, 'fixture-group');
          assert.equal(body.name, windowName);
          assert.equal(body.url, 'https://chatgpt.com/');
          assert.equal(body.cookie, '');
          assert.equal(body.password, '');
          for (const flag of [
            'syncTabs',
            'syncCookies',
            'syncLocalStorage',
            'syncIndexedDb',
            'syncAuthorization'
          ]) {
            assert.equal(body[flag], false, flag);
          }
          assert.equal(body.browserFingerPrint.coreVersion, '152');
          profile = { ...body, id: profileId };
          data = { id: profileId };
          break;
        case '/browserTag/updateRelation':
          assert.deepEqual(body, {
            browserId: profileId,
            addTagIds: ['fixture-tag'],
            removeTagIds: []
          });
          break;
        case '/browser/detail':
          assert.deepEqual(body, { id: profileId });
          data = profile;
          break;
        case '/browser/close':
          assert.equal(body.id, profileId); officialTabOpen = false; break;
        case '/browser/pids/alive':
          assert.deepEqual(body, { ids: [profileId] });
          data = { [profileId]: officialTabOpen ? 1234 : 0 };
          break;
        case '/browser/open':
          assert.equal(body.id, profileId);
          assert.ok(body.args.includes('--remote-allow-origins=' + origin));
          data = { ws: websocketUrl, coreVersion: '152' };
          break;
        default:
          assert.fail('Unexpected BitBrowser API call: ' + request.url);
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });

  function commandResult(method, params) {
    switch (method) {
      case 'Browser.getVersion':
        return { product: 'Chrome/152.0.0.0' };
      case 'Target.getTargets':
        return {
          targetInfos: [
            {
              type: 'page',
              targetId: 'fixture-tab',
              url: officialTabOpen ? 'https://chatgpt.com/' : 'about:blank'
            }
          ]
        };
      case 'Target.attachToTarget':
        assert.deepEqual(params, { targetId: 'fixture-tab', flatten: true });
        return { sessionId: 'fixture-cdp-session' };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'main-frame' } } };
      case 'Network.enable':
      case 'Network.setExtraHTTPHeaders':
        return {};
      case 'Network.getCookies':
        return { cookies: [] };
      case 'Network.setCookies':
        assert.equal(params.cookies.length, 1);
        assert.deepEqual(params.cookies[0], {
          name: '__Secure-next-auth.session-token',
          value: authorizationToken,
          url: 'https://chatgpt.com/',
          httpOnly: true,
          secure: true,
          sameSite: 'Lax'
        });
        sessionCookieApplied = true;
        return {};
      case 'Page.navigate':
        assert.equal(sessionCookieApplied, true);
        assert.deepEqual(params, { url: 'https://chatgpt.com/' });
        officialTabOpen = true;
        return {};
      case 'Runtime.evaluate': {
        assert.equal(sessionCookieApplied, true);
        const expression = params.expression;
        if (expression.includes('/cdn-cgi/trace')) {
          return { result: { value: { kind: 'proxy_ready' } } };
        }
        if (expression.includes('accounts-profile-button')) {
          return { result: { value: { kind: 'page_ready' } } };
        }
        const invocation = expression.slice(expression.lastIndexOf(')(') + 2);
        if (invocation.startsWith('"clear"')) {
          return { result: { value: { kind: 'loading' } } };
        }
        assert.match(invocation, /^"inspect","",/);
        assert.match(invocation, /"sessionOnly":true/);
        assert.ok(expression.includes('/api/auth/session'));
        return { result: { value: observedIdentity } };
      }
      default:
        assert.fail('Unexpected CDP command: ' + method);
    }
  }

  class FakeCdpWebSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;

    constructor(endpoint) {
      super();
      assert.equal(endpoint, websocketUrl);
      queueMicrotask(() => {
        this.readyState = FakeCdpWebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
      });
    }

    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      commands.push(method);
      let reply;
      try {
        reply = { id, result: commandResult(method, params) };
      } catch (error) {
        errors.push(error);
        reply = { id, error: { message: 'Fixture rejected this CDP command' } };
      }
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) }))
      );
    }

    close() {
      this.readyState = 3;
      socketClosed = true;
      this.dispatchEvent(new Event('close'));
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const priorWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeCdpWebSocket, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { origin } },
    configurable: true
  });
  try {
    await useFixture({
      requests,
      commands,
      socketClosed: () => socketClosed,
      login: (onProgress = () => {}, options = {}) =>
        runBitBrowserJsonLogin({
          url: 'http://127.0.0.1:' + server.address().port,
          token: localApiKey,
          groupName,
          tagName,
          windowName,
          sessionJson: localAuthorization(),
          signal: AbortSignal.timeout(5_000),
          onProgress, ...options
        })
    });
    assert.deepEqual(errors, []);
  } finally {
    if (priorWebSocket) Object.defineProperty(globalThis, 'WebSocket', priorWebSocket);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('opens the selected BitBrowser window and returns success only after JSON identity verification', async () => {
  await withLoginFixture(identity, async ({ requests, commands, socketClosed, login }) => {
    const stages = [];
    const result = await login((stage) => stages.push(stage));
    assert.deepEqual(result, { email: identity.email, profileId, currentPlan: identity.plan });
    assert.deepEqual(
      requests.map(({ path }) => path),
      freshProfileApi
    );
    assert.ok(commands.indexOf('Network.setCookies') < commands.indexOf('Page.navigate'));
    assert.ok(commands.includes('Runtime.evaluate'));
    assert.ok(stages.includes('bitbrowser_profile_opened'));
    assert.ok(stages.includes('session_restore'));
    assert.equal(socketClosed(), true);
  });
});

test('reuses the verified window for the same account and leaves the live session intact', async () => {
  await withLoginFixture(identity, async ({ requests, commands, login }) => {
    await login();
    const requestStart = requests.length;
    const commandStart = commands.length;
    const second = await login();
    assert.equal(second.profileId, profileId);
    assert.deepEqual(
      requests.slice(requestStart).map(({ path }) => path),
      ['/browser/detail', '/browser/pids/alive', '/browser/open']
    );
    const secondCommands = commands.slice(commandStart);
    assert.equal(secondCommands.includes('Network.setCookies'), false);
    assert.equal(secondCommands.includes('Page.navigate'), false);
    assert.ok(secondCommands.includes('Runtime.evaluate'));
  });
});

test('an explicit new IP updates only the retained window network after confirmed close', async () => {
  await withLoginFixture(identity, async ({ requests, login }) => {
    await login(undefined, { expectedCountryCode: 'US', dynamicProxyUrl: 'https://first.example.test/get' });
    const before = requests.length;
    const result = await login(undefined, { expectedCountryCode: 'MY', dynamicProxyUrl: 'https://second.example.test/get' });
    assert.equal(result.profileId, profileId);
    const paths = requests.slice(before).map(({ path }) => path);
    assert(paths.indexOf('/browser/close') < paths.indexOf('/browser/update'));
    assert(paths.indexOf('/browser/update') < paths.indexOf('/browser/open'));
    assert.equal(requests.slice(before).find(({ path }) => path === '/browser/update').body.dynamicIpUrl, 'https://second.example.test/get');
  });
});

for (const [field, replacement] of [
  ['email', 'other@example.test'],
  ['userId', 'other-user'],
  ['accountId', 'other-account']
]) {
  test('refuses to report success when the verified account has a different ' + field, async () => {
    await withLoginFixture(
      { ...identity, [field]: replacement },
      async ({ requests, socketClosed, login }) => {
        await assert.rejects(
          login(),
          (error) =>
            error.reason === 'official_login_email_mismatch' || /账号.*不一致/.test(error.message)
        );
        assert.deepEqual(
          requests.map(({ path }) => path),
          freshProfileApi
        );
        assert.equal(socketClosed(), true);
      }
    );
  });
}
