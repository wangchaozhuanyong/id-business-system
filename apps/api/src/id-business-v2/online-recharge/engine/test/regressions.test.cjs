'use strict';
/* global window, document */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const outcomes = require('../outcomes.cjs');
const rpc = require('../rpc.cjs');
const security = require('../security.cjs');
const credentialClient = require('../credential-client.cjs');
const store = require('../upstream/mysql-store');
const { executeThirdParty } = require('../third-party.cjs');
const { evaluateSubscription, recheck } = require('../confirmation.cjs');
const task = () => ({
  id: 'synthetic-task',
  workerId: 'test-worker',
  leaseId: 'test-lease',
  leaseVersion: 2,
  plan: 'pro_5x',
  session: '{}',
  provider: 'third_party',
  code: null
});
const card = () => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  card_number: '4242424242424242',
  card_expiry: '12/29',
  card_cvc: '123',
  leaseId: 'card-lease',
  leaseVersion: 7
});
test.afterEach(() => {
  store.clearCredentials();
  rpc.setTransportForTest(null);
  credentialClient.setRequesterForTest(null);
  rpc.clearTask();
  security.clearSecrets();
});
const sessionBearer = (accountId = 'fixture-account', userId = 'fixture-user', revision = 'old') =>
  `synthetic.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId },
      'https://api.openai.com/profile': { email: 'fixture@example.invalid' },
      jti: revision
    })
  ).toString('base64url')}.synthetic`;
async function sessionInstallFixture({
  status = 200,
  body,
  headers = {},
  original = {},
  failure,
  dependencies = {}
} = {}) {
  const filename = path.resolve(__dirname, '../upstream/session-auth.js');
  const source = await fs.readFile(filename, 'utf8');
  const module = { exports: {} };
  const logs = [];
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      Buffer,
      URL,
      process: { env: {} },
      performance,
      console: {
        log: (...items) => logs.push(items.join(' ')),
        warn: (...items) => logs.push(items.join(' '))
      },
      require: (name) => dependencies[name] || require(path.resolve(path.dirname(filename), name))
    },
    { filename }
  );
  const session = {
    accessToken: sessionBearer(),
    sessionToken: 'synthetic-cookie-only',
    user: { id: 'fixture-user', email: 'fixture@example.invalid', name: 'Original' },
    account: { id: 'fixture-account' },
    expires: '2030-01-01T00:00:00.000Z',
    ...original
  };
  const calls = { cookies: [], routes: [], scripts: [], realSessionRequests: 0 };
  const context = {
    newPage: async () => ({
      goto: async (url) => {
        if (url.endsWith('/api/auth/session')) {
          calls.realSessionRequests++;
          if (failure) throw failure;
        }
        return { status: () => status, headers: () => headers };
      },
      evaluate: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      close: async () => {}
    }),
    addCookies: async (cookies) => calls.cookies.push(...cookies),
    cookies: async () => calls.cookies,
    addInitScript: async (script, payload) => calls.scripts.push({ script, payload }),
    route: async (pattern, handler) => calls.routes.push({ pattern, handler })
  };
  return {
    api: module.exports,
    context,
    session,
    calls,
    logs,
    install: () => module.exports.installChatGptSession(context, JSON.stringify(session))
  };
}
test('verified Cookie refresh supplies the fresh bearer without generic route injection', async () => {
  const refreshed = sessionBearer('fixture-account', 'fixture-user', 'refreshed');
  const body = {
    accessToken: refreshed,
    user: { id: 'fixture-user', name: 'Verified' },
    account: { id: 'fixture-account' },
    expires: '2031-01-01T00:00:00.000Z'
  };
  const f = await sessionInstallFixture({ body });
  const installed = await f.install();
  assert.equal(installed.cookieVerified, true);
  assert.equal(installed.sessionData.accessToken, refreshed);
  assert.equal(installed.sessionData.user.name, 'Verified');
  assert.equal(installed.sessionData.expires, body.expires);
  assert.equal(installed.sessionData.sessionToken, f.session.sessionToken);
  assert.equal(f.calls.realSessionRequests, 1);
  assert.equal(f.calls.scripts[0].payload.accessToken, refreshed);
  const callerHeaders = Object.freeze({
    Authorization: `Bearer ${refreshed}`,
    accept: 'application/json'
  });
  let continuation;
  await f.calls.routes.at(-1).handler({
    request: () => ({
      url: () => 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
      method: () => 'GET',
      resourceType: () => 'fetch',
      headers: () => callerHeaders
    }),
    continue: async (options) => {
      continuation = options;
    }
  });
  assert.equal(continuation, undefined, 'Session routing must preserve native request headers');
  assert.equal(callerHeaders.Authorization, `Bearer ${refreshed}`);
  let routedSession;
  await f.calls.routes[0].handler({
    request: () => ({ url: () => 'https://chatgpt.com/api/auth/session', method: () => 'GET' }),
    fulfill: async (options) => {
      routedSession = JSON.parse(options.body);
    }
  });
  assert.equal(routedSession.accessToken, refreshed);
  const window = {
    location: {
      origin: 'https://chatgpt.com',
      href: 'https://chatgpt.com/',
      hostname: 'chatgpt.com'
    },
    fetch: async () => {
      throw new Error('Synthetic fixture forbids network');
    }
  };
  vm.runInNewContext(
    `(${f.calls.scripts[0].script.toString()})(${JSON.stringify(f.calls.scripts[0].payload)})`,
    {
      window,
      location: window.location,
      URL,
      localStorage: { setItem() {} },
      Request,
      Response
    }
  );
  assert.equal(
    (await (await window.fetch('https://chatgpt.com/api/auth/session')).json()).accessToken,
    refreshed
  );
  assert.equal(f.logs.join('\n').includes(refreshed), false);
  assert.equal(security.redactText(refreshed).includes(refreshed), false);
});
test('synthetic session bootstrap is isolated from third-party frames and fetch destinations', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const f = await sessionInstallFixture({ body: { accessToken: sessionBearer() } });
  await f.install();
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  try {
    const context = await browser.newContext();
    let thirdPartyFetches = 0;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://chatgpt.com' && url.pathname === '/') {
        await route.fulfill({
          contentType: 'text/html',
          body: '<main><button>New chat</button><textarea id="prompt-textarea"></textarea></main><iframe src="https://third-party.invalid/frame"></iframe>'
        });
      } else if (url.origin === 'https://third-party.invalid') {
        if (url.pathname === '/api/auth/session') thirdPartyFetches++;
        await route.fulfill({
          contentType: url.pathname === '/frame' ? 'text/html' : 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: url.pathname === '/frame' ? '<main>Third party synthetic frame</main>' : '{}'
        });
      } else {
        await route.abort();
      }
    });
    await context.addInitScript(f.calls.scripts[0].script, f.calls.scripts[0].payload);
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/');
    assert.equal(
      await page.evaluate(() => window.__CHATGPT_BOOTSTRAP_SESSION__?.user?.id),
      'fixture-user'
    );
    assert.equal(
      await page.evaluate(() => Boolean(localStorage.getItem('oai/apps/chat/bootstrap-session'))),
      true
    );
    assert.equal(
      await page.evaluate(async () =>
        Boolean((await (await fetch('/api/auth/session')).json()).accessToken)
      ),
      true
    );
    const frame = page
      .frames()
      .find((candidate) => candidate.url() === 'https://third-party.invalid/frame');
    assert.ok(frame);
    assert.deepEqual(
      await frame.evaluate(() => ({
        injectedSession: Boolean(window.__CHATGPT_BOOTSTRAP_SESSION__),
        persistedSession: Boolean(localStorage.getItem('oai/apps/chat/bootstrap-session'))
      })),
      { injectedSession: false, persistedSession: false }
    );
    assert.equal(
      await page.evaluate(async () =>
        Boolean(
          (await (await fetch('https://third-party.invalid/api/auth/session')).json()).accessToken
        )
      ),
      false
    );
    assert.equal(
      thirdPartyFetches,
      1,
      'Cross-origin auth paths must reach the synthetic remote response'
    );
  } finally {
    await browser.close();
  }
});
test('session routing never manufactures authorization or overrides caller headers', async () => {
  const f = await sessionInstallFixture({ body: { accessToken: sessionBearer() } });
  await f.install();
  for (const origin of [
    'https://chatgpt.com',
    'https://openai.com',
    'https://auth.openai.com',
    'https://pay.openai.com',
    'https://api.chatgpt.com',
    'https://api.openai.com'
  ]) {
    for (const headers of [
      Object.freeze({ accept: 'application/json' }),
      Object.freeze({
        Authorization: `Bearer ${f.session.accessToken}`,
        accept: 'application/json'
      })
    ]) {
      let continuation;
      const before = { ...headers };
      await f.calls.routes.at(-1).handler({
        request: () => ({
          url: () => `${origin}/fixed-path`,
          method: () => 'GET',
          resourceType: () => 'fetch',
          headers: () => headers
        }),
        continue: async (options) => {
          continuation = options;
        }
      });
      assert.equal(continuation, undefined, 'Native caller headers cannot become a route override');
      assert.deepEqual(headers, before);
    }
  }
  for (const url of [
    'https://third-party.invalid/?redirect=https://chatgpt.com/backend-api/accounts/check',
    'https://chatgpt.com.third-party.invalid/api/auth/session',
    'https://third-party.invalid/?host=pay.openai.com',
    'https://third-party.invalid/?host=auth.openai.com',
    'https://chatgpt.com:444/fixed-path',
    'http://chatgpt.com/fixed-path'
  ]) {
    let sent;
    await f.calls.routes.at(-1).handler({
      request: () => ({
        url: () => url,
        method: () => 'GET',
        resourceType: () => 'fetch',
        headers: () => ({})
      }),
      continue: async (options) => {
        sent = options?.headers;
      }
    });
    assert.equal(sent?.Authorization, undefined, 'A third party cannot inherit the session bearer');
  }
  for (const registered of f.calls.routes.slice(0, -1)) {
    let continued = 0;
    let fulfilled = 0;
    await registered.handler({
      request: () => ({
        url: () => 'https://third-party.invalid/api/auth/session',
        method: () => 'GET'
      }),
      continue: async () => {
        continued++;
      },
      fulfill: async () => {
        fulfilled++;
      }
    });
    assert.equal(continued, 1);
    assert.equal(
      fulfilled,
      0,
      'Third-party auth paths cannot receive the synthetic official session'
    );
  }
});
test('native cross-origin 302 strips caller authorization and session routing adds none', async () => {
  const http = require('node:http');
  const { chromium } = require('../upstream/node_modules/playwright');
  const f = await sessionInstallFixture({ body: { accessToken: sessionBearer() } });
  await f.install();
  const expected = `Bearer ${f.session.accessToken}`;
  const observed = [];
  let originA;
  const serverB = http.createServer((request, response) => {
    observed.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(200, {
      'content-type': 'text/plain',
      'access-control-allow-origin': originA || '*'
    });
    response.end('synthetic-destination');
  });
  const listen = async (server) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const originB = await listen(serverB);
  const serverA = http.createServer((request, response) => {
    observed.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === '/route-start' || request.url === '/native-start') {
      response.writeHead(302, {
        location: `${originB}${request.url.replace('-start', '-finish')}`
      });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<main>Synthetic redirect seed</main>');
    }
  });
  let browser;
  try {
    originA = await listen(serverA);
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
      ]
    });
    const context = await browser.newContext();
    const continuations = [];
    let externalRequests = 0;
    context.on('request', (request) => {
      if (![originA, originB].includes(new URL(request.url()).origin)) externalRequests++;
    });
    for (const pathname of ['/route-start', '/native-start']) {
      await context.route(`${originA}${pathname}`, async (route) => {
        const request = route.request();
        // Only the initial URL is represented as official. Native networking,
        // both loopback origins, actual 302 handling and request headers remain real.
        await f.calls.routes.at(-1).handler({
          request: () => ({
            url: () => `https://chatgpt.com${pathname}`,
            method: () => request.method(),
            resourceType: () => request.resourceType(),
            headers: () => request.headers()
          }),
          abort: () => route.abort(),
          continue: async (options) => {
            continuations.push(options);
            await route.continue(options);
          }
        });
      });
    }
    const page = await context.newPage();
    await page.goto(`${originA}/route-start`);
    assert.equal(observed.find((item) => item.path === '/route-start')?.authorization, undefined);
    assert.equal(observed.find((item) => item.path === '/route-finish')?.authorization, undefined);
    await page.goto(`${originA}/seed`);
    assert.equal(
      await page.evaluate(
        async ({ start, authorization }) =>
          (await fetch(start, { headers: { Authorization: authorization } })).status,
        { start: `${originA}/native-start`, authorization: expected }
      ),
      200
    );
    assert.equal(observed.find((item) => item.path === '/native-start')?.authorization, expected);
    assert.equal(observed.find((item) => item.path === '/native-finish')?.authorization, undefined);
    assert.deepEqual(continuations, [undefined, undefined]);
    assert.equal(externalRequests, 0);
  } finally {
    await browser?.close();
    await Promise.all(
      [serverA, serverB].map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
      )
    );
  }
});
test('refreshed Cookie credentials cannot switch account, user or discard identity binding', async () => {
  const good = {
    accessToken: sessionBearer('fixture-account', 'fixture-user', 'refreshed'),
    user: { id: 'fixture-user' },
    account: { id: 'fixture-account' }
  };
  for (const body of [
    { ...good, accessToken: sessionBearer('other-account', 'fixture-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('fixture-account', 'other-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('', 'fixture-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('fixture-account', '', 'refreshed') },
    { ...good, account: { id: 'other-account' } },
    { ...good, user: { id: 'other-user' } }
  ]) {
    const f = await sessionInstallFixture({ body });
    await assert.rejects(
      f.install,
      (error) =>
        error.code === 'ACCOUNT_MISMATCH' &&
        !/fixture-account|fixture-user|synthetic\./.test(error.message)
    );
    assert.equal(f.calls.scripts.length, 0);
    assert.equal(f.calls.routes.length, 0);
  }
  const inconsistent = await sessionInstallFixture({
    body: good,
    original: { account: { id: 'other-account' } }
  });
  await assert.rejects(inconsistent.install, (error) => error.code === 'ACCOUNT_MISMATCH');
  const inconsistentUser = await sessionInstallFixture({
    body: good,
    original: { user: { id: 'other-user' } }
  });
  await assert.rejects(inconsistentUser.install, (error) => error.code === 'ACCOUNT_MISMATCH');
  const unbound = await sessionInstallFixture({
    body: good,
    original: { accessToken: 'opaque-synthetic-token', user: null, account: null }
  });
  await assert.rejects(unbound.install, (error) => error.code === 'ACCOUNT_MISMATCH');
});
test('same or missing fresh bearer retains the original session fields', async () => {
  for (const accessToken of [undefined, sessionBearer()]) {
    const f = await sessionInstallFixture({
      body: {
        ...(accessToken ? { accessToken } : {}),
        user: { id: 'fixture-user', name: 'Changed' },
        expires: '2031-01-01T00:00:00.000Z'
      }
    });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, true);
    assert.deepEqual(JSON.parse(JSON.stringify(installed.sessionData)), {
      ...f.session,
      authProvider: 'google-oauth2'
    });
  }
});
test('Cookie identity is never accepted from a forbidden response or challenge page', async () => {
  const body = {
    accessToken: sessionBearer('fixture-account', 'fixture-user', 'refreshed'),
    user: { id: 'fixture-user' }
  };
  const unauthorized = await sessionInstallFixture({ status: 401, body });
  await assert.rejects(unauthorized.install, (error) => error.code === 'SESSION_INVALID');
  for (const response of [
    { status: 403 },
    { status: 429 },
    { status: 500 },
    { status: 200, headers: { 'cf-mitigated': 'challenge' } }
  ]) {
    const f = await sessionInstallFixture({ ...response, body });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, false);
    assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  }
});
test('ambiguous HTTP 200 bodies stay unverified while an exact empty session is rejected', async () => {
  for (const body of [
    { error: 'temporary_failure' },
    {
      error: 'refresh_failed',
      accessToken: sessionBearer('fixture-account', 'fixture-user', 'untrusted'),
      user: { id: 'fixture-user' }
    },
    [],
    '<html>temporary failure</html>'
  ]) {
    const f = await sessionInstallFixture({ body });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, false);
    assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  }
  const empty = await sessionInstallFixture({ body: {} });
  await assert.rejects(empty.install, (error) => error.code === 'SESSION_INVALID');
});
test('Cookie probe timeout retains the original credential without manufacturing verification', async () => {
  const f = await sessionInstallFixture({
    failure: Object.assign(new Error('synthetic_timeout'), { name: 'TimeoutError' })
  });
  const installed = await f.install();
  assert.equal(installed.cookieVerified, false);
  assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  assert.equal(f.calls.realSessionRequests, 1);
});
test('rendered authentication ignores hidden login text and preserves visible login rejection', async (t) => {
  const bootstrapLogs = [];
  t.mock.method(console, 'log', (...items) => bootstrapLogs.push(items));
  t.mock.method(console, 'warn', (...items) => bootstrapLogs.push(items));
  const { chromium } = require('../upstream/node_modules/playwright');
  const detect = require('../upstream/auth-page-detect');
  const auth = require('../upstream/session-auth');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  try {
    const page = await browser.newPage();
    const chatUi =
      '<button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea>';
    for (const [label, markup] of [
      ['hidden attribute', '<div hidden>Log in Sign up</div>'],
      ['display none', '<div style="display:none">Sign in with Google</div>'],
      ['visibility hidden', '<div style="visibility:hidden">Sign in to continue</div>'],
      [
        'transparent controls',
        '<div style="opacity:0"><button>Log in</button><button>Sign up for free</button><h1>Sign in to continue</h1></div>'
      ],
      [
        'inert controls',
        '<div inert><button>Log in</button><button>Sign up for free</button><h1>Sign in to continue</h1></div>'
      ],
      [
        'aria hidden controls',
        '<div aria-hidden="true"><button>Log in</button><button>Sign up for free</button><h1>Sign in to continue</h1></div>'
      ],
      [
        'conversation quote',
        '<article data-message-author-role="user"><p>Earlier message: Sign in to continue, Log in Sign up, Sign in with Google.</p></article>'
      ],
      [
        'script and template',
        '<script type="application/json">{"message":"登录 ChatGPT"}</script><template>使用 Google 登录</template>'
      ]
    ])
      await t.test(`hidden authentication copy: ${label}`, async () => {
        await page.setContent(`<html><body>${chatUi}${markup}</body></html>`);
        assert.equal(await detect.isLoginPageContent(page), false);
        assert.equal(await detect.hasVisibleLoginChrome(page), false);
        assert.equal(await detect.hasLoggedInChatUi(page), true);
        await auth.assertChatGptLoggedIn(page, 'synthetic homepage');
      });
    await t.test('visible authentication content overrides chat markers', async () => {
      await page.setContent(`<html><body>${chatUi}<h1>Sign in to continue</h1></body></html>`);
      assert.equal(await detect.isLoginPageContent(page), true);
      await assert.rejects(
        auth.assertChatGptLoggedIn(page, 'synthetic homepage'),
        (error) => error.code === 'SESSION_NOT_CONFIRMED'
      );
    });
    await t.test('hidden chat markers cannot manufacture a logged in page', async () => {
      await page.setContent(
        `<main>Loading account</main><div style="opacity:0">${chatUi}</div><div inert>${chatUi}</div><div aria-hidden="true">${chatUi}</div>`
      );
      assert.equal(await detect.hasLoggedInChatUi(page), false);
      assert.equal(await detect.hasVisibleLoginChrome(page), false);
    });
    await t.test('visible login controls remain a blocker with hidden duplicates', async () => {
      await page.setContent(
        `${chatUi}<button hidden>Log in</button><button style="opacity:0">Log in</button><button>Log in</button><button>Sign up</button>`
      );
      assert.equal(await detect.hasVisibleLoginChrome(page), true);
      assert.equal(await detect.hasLoggedInChatUi(page), false);
      await assert.rejects(
        auth.assertChatGptLoggedIn(page, 'synthetic homepage'),
        (error) => error.code === 'SESSION_NOT_CONFIRMED'
      );
    });
    await t.test('a real browser login redirect remains rejected', async () => {
      await page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<h1>Sign in to continue</h1>' })
      );
      await page.goto('https://auth.openai.com/u/login');
      await assert.rejects(
        auth.assertChatGptLoggedIn(page, 'synthetic homepage'),
        (error) => error.code === 'SESSION_NOT_CONFIRMED'
      );
    });
    await t.test(
      'unknown coded bootstrap exceptions are controlled without relabeling real network failures',
      async () => {
        const nativeGoto = page.goto.bind(page);
        const session = JSON.stringify({
          accessToken: sessionBearer(),
          user: { id: 'fixture-user' }
        });
        try {
          page.goto = async () => {
            throw Object.assign(new Error('PRIVATE_AUTH_VALUE'), { code: 'PRIVATE_AUTH_VALUE' });
          };
          await assert.rejects(
            auth.bootstrapChatGptSession(page, session, { cookieVerified: true }),
            (error) =>
              error.code === 'SESSION_BOOTSTRAP_FAILED' && !/PRIVATE_AUTH_VALUE/.test(error.message)
          );
          const networkError = Object.assign(new Error('PRIVATE_AUTH_VALUE'), {
            code: 'ECONNRESET'
          });
          page.goto = async () => {
            throw networkError;
          };
          await assert.rejects(
            auth.bootstrapChatGptSession(page, session, { cookieVerified: true }),
            (error) => error === networkError
          );
        } finally {
          page.goto = nativeGoto;
        }
      }
    );
    assert.doesNotMatch(JSON.stringify(bootstrapLogs), /PRIVATE_AUTH_VALUE/);
  } finally {
    await browser.close();
  }
});
test('authentication readiness waits for stable recovery and respects cancellation and one deadline', async (t) => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const { waitForLoggedInChatUi } = require('../upstream/auth-page-detect');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  try {
    const page = await browser.newPage();
    const chat =
      '<button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea>';
    const guest = `${chat}<button>Log in</button>`;
    const timeline = async (initial, changes = []) => {
      await page.setContent(`<html><body data-auth-phase="${initial}"><main id="auth-fixture">${initial === 'guest' ? guest : chat}</main><script>
        for (const timer of window.syntheticAuthTimers || []) clearTimeout(timer);
        window.syntheticAuthTimers = ${JSON.stringify(changes)}.map(step => setTimeout(() => {
          document.getElementById('auth-fixture').innerHTML = step.state === 'guest' ? ${JSON.stringify(guest)} : ${JSON.stringify(chat)};
          document.body.dataset.authPhase = step.state;
        }, step.after));
      </script></body></html>`);
    };
    await t.test('one transient login control can recover before readiness', async () => {
      await timeline('guest', [{ after: 600, state: 'recovered' }]);
      assert.equal(
        await waitForLoggedInChatUi(page, 2500, { deadlineAt: performance.now() + 2500 }),
        true
      );
      assert.equal(await page.getAttribute('body', 'data-auth-phase'), 'recovered');
    });
    await t.test('initial chat cannot skip a later guest transition before recovery', async () => {
      await timeline('initial', [
        { after: 100, state: 'guest' },
        { after: 750, state: 'recovered' }
      ]);
      assert.equal(
        await waitForLoggedInChatUi(page, 2500, { deadlineAt: performance.now() + 2500 }),
        true
      );
      assert.equal(await page.getAttribute('body', 'data-auth-phase'), 'recovered');
    });
    await t.test('a permanent guest remains unready', async () => {
      await timeline('guest');
      assert.equal(
        await waitForLoggedInChatUi(page, 700, { deadlineAt: performance.now() + 700 }),
        false
      );
    });
    await t.test('a late guest invalidates the first chat observation', async () => {
      await timeline('initial', [{ after: 100, state: 'guest' }]);
      assert.equal(
        await waitForLoggedInChatUi(page, 1300, { deadlineAt: performance.now() + 1300 }),
        false
      );
      assert.equal(await page.getAttribute('body', 'data-auth-phase'), 'guest');
    });
    await t.test(
      'lease cancellation interrupts readiness without another UI observation',
      async () => {
        await timeline('guest');
        const controller = new AbortController();
        const reason = Object.assign(new Error('Synthetic lease cancellation'), {
          code: 'LEASE_LOST'
        });
        const timer = setTimeout(() => controller.abort(reason), 80);
        try {
          await assert.rejects(
            waitForLoggedInChatUi(page, 1500, {
              deadlineAt: performance.now() + 1500,
              signal: controller.signal
            }),
            (error) => error === reason
          );
        } finally {
          clearTimeout(timer);
        }
      }
    );
    await t.test('the shared deadline is not extended by a longer local wait', async () => {
      await timeline('guest');
      const started = performance.now();
      assert.equal(await waitForLoggedInChatUi(page, 5000, { deadlineAt: started + 650 }), false);
      assert.ok(
        performance.now() - started < 1500,
        'Readiness must stop at the original shared deadline'
      );
    });
  } finally {
    await browser.close();
  }
});
test('late verification preserves the authentication wait boundary without restarting verification', async (t) => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const { waitForLoggedInChatUi } = require('../upstream/auth-page-detect');
  const human = require('../upstream/human-verification');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  const chat =
    '<button>New chat</button><textarea id="prompt-textarea" placeholder="Ask anything"></textarea>';
  const guest = `${chat}<button>Log in</button>`;
  try {
    await t.test('stopWhen exits readiness within the original deadline', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<main>${guest}</main>`);
        let calls = 0;
        const started = performance.now();
        assert.equal(
          await waitForLoggedInChatUi(page, 5000, {
            deadlineAt: started + 1500,
            stopWhen: async () => {
              calls++;
              return true;
            }
          }),
          false
        );
        assert.equal(calls, 1);
        assert.ok(performance.now() - started < 1000);
      } finally {
        await page.close();
      }
    });
    for (const phase of ['during-prewait', 'after-verification']) {
      await t.test(`a challenge ${phase} never bypasses or restarts verification`, async () => {
        const page = await browser.newPage();
        let clears = 0;
        const f = await sessionInstallFixture({
          dependencies: {
            './human-verification': {
              isBlockingHumanVerificationVisible: async (target) =>
                target.locator('#synthetic-challenge').isVisible(),
              clearHumanVerification: async () => {
                clears++;
                return phase === 'during-prewait'
                  ? { cleared: false, code: 'VERIFICATION_SOLVER_DISABLED' }
                  : { cleared: true };
              }
            }
          }
        });
        page.goto = async () => {
          await page.setContent(`<main>${phase === 'during-prewait' ? guest : chat}</main><script>
            setTimeout(() => {
              const challenge = document.createElement('section');
              challenge.id = 'synthetic-challenge';
              challenge.textContent = 'Synthetic verification';
              document.body.appendChild(challenge);
            }, 2800);
          </script>`);
        };
        try {
          await assert.rejects(
            f.api.bootstrapChatGptSession(page, JSON.stringify(f.session), {
              cookieVerified: true,
              deadlineAt: performance.now() + 10000
            }),
            (error) =>
              error.code ===
                (phase === 'during-prewait'
                  ? 'VERIFICATION_SOLVER_DISABLED'
                  : 'HUMAN_VERIFICATION_REQUIRED') &&
              error.bootstrapDiagnostics?.reason === 'verification_failed' &&
              error.bootstrapDiagnostics?.challengeDetected === true
          );
          assert.equal(clears, 1);
        } finally {
          await page.close();
        }
      });
    }
    for (const recover of [true, false]) {
      await t.test(
        `a guest appearing at verification entry ${recover ? 'recovers once' : 'remains blocked'}`,
        async () => {
          const page = await browser.newPage();
          let clears = 0;
          let entryResult;
          const f = await sessionInstallFixture({
            dependencies: {
              './human-verification': {
                ...human,
                clearHumanVerification: async (target, options) => {
                  clears++;
                  await target.setContent(`<main>${guest}</main>`);
                  entryResult = await human.clearHumanVerification(target, options);
                  if (recover) {
                    await target.evaluate((html) => {
                      setTimeout(() => {
                        document.querySelector('main').innerHTML = html;
                      }, 600);
                    }, chat);
                  }
                  return entryResult;
                }
              }
            }
          });
          page.goto = async () => page.setContent(`<main>${chat}</main>`);
          try {
            const bootstrap = f.api.bootstrapChatGptSession(page, JSON.stringify(f.session), {
              cookieVerified: true,
              deadlineAt: performance.now() + 18000
            });
            if (recover) {
              const result = await bootstrap;
              assert.equal(result.email, f.session.user.email);
              assert.equal(
                await page.getByRole('button', { name: 'Log in', exact: true }).count(),
                0
              );
            } else {
              await assert.rejects(
                bootstrap,
                (error) =>
                  error.code === 'SESSION_NOT_CONFIRMED' &&
                  error.bootstrapDiagnostics?.reason === 'visible_login_controls'
              );
            }
            assert.equal(entryResult?.code, 'SESSION_INVALID');
            assert.equal(entryResult?.sessionRequired, true);
            assert.equal(clears, 1);
          } finally {
            await page.close();
          }
        }
      );
    }
  } finally {
    await browser.close();
  }
});
async function authenticationQueryFixture(authError, phase = 'session_install') {
  const filename = path.resolve(__dirname, '../upstream/subscription-check.js');
  const module = { exports: {} };
  let mismatches = 0,
    resourcesClosed = 0;
  const page = { close: async () => {} };
  const context = {
    newPage: async () => page,
    close: async () => {
      resourcesClosed++;
    }
  };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module,
    exports: module.exports,
    process: { env: {} },
    Buffer,
    URL,
    AbortController,
    require: (name) => {
      if (name.startsWith('node:')) return require(name);
      if (name === 'playwright') return { request: {} };
      if (name === '../rpc.cjs') return { taskSignal: () => undefined, wasSubmitted: () => false };
      if (name === './session-auth')
        return {
          ...require('../upstream/session-auth'),
          extractProfileFromToken: () => ({ accountId: 'fixture-account' }),
          installChatGptSession: async () => {
            if (phase === 'session_bootstrap') return { sessionData: {}, cookieVerified: true };
            mismatches++;
            throw authError;
          },
          bootstrapChatGptSession: async () => {
            mismatches++;
            throw authError;
          }
        };
      if (name === './playwright-proxy')
        return {
          preparePlaywrightProxy: async () => ({
            cleanup: async () => {
              resourcesClosed++;
            }
          })
        };
      if (name === './browser-runtime')
        return {
          connectTaskBrowser: async () => ({
            browser: { newContext: async () => context },
            realUserAgent: 'Synthetic'
          }),
          closeTaskBrowser: async () => {
            resourcesClosed++;
          }
        };
      if (name === './human-verification')
        return { prepareVerificationPage: async () => {}, disposeVerificationPage: async () => {} };
      throw new Error('Synthetic authentication fixture forbids other dependencies');
    }
  });
  const options = { sessionRaw: 'synthetic-session', allowBrowserFallback: true };
  return {
    run: (operation) => module.exports[operation](sessionBearer(), options),
    calls: () => ({ mismatches, resourcesClosed })
  };
}
test('independent subscription and renewal preserve an authentication identity rejection', async () => {
  const f = await authenticationQueryFixture(
    Object.assign(new Error('Synthetic identity rejection'), { code: 'ACCOUNT_MISMATCH' })
  );
  for (const operation of ['querySubscriptionBySession', 'cancelAutoRenew', 'resumeAutoRenew']) {
    const result = await f.run(operation);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ACCOUNT_MISMATCH');
    assert.equal(result.statusCode, 409);
    assert.match(result.error, /身份|账号|用户/);
    assert.doesNotMatch(result.error, /网络|fixture-account|synthetic-session/);
    assert.notEqual(result.resultUnknown, true);
  }
  assert.deepEqual(f.calls(), { mismatches: 3, resourcesClosed: 9 });
});
test('bootstrap diagnostics keep controlled reasons and real booleans without credentials or page values', () => {
  const { safeBootstrapDiagnostics } = require('../upstream/session-auth');
  const diagnostic = {
    reason: 'visible_login_content',
    authApiVerified: true,
    visibleLogin: false,
    loggedInUi: true,
    redirectDetected: false,
    challengeDetected: false,
    pageClosed: false,
    accountCheckHttpStatus: 200,
    accountCheckHasAccountFacts: true,
    accountCheckIdentityMatches: false
  };
  assert.deepEqual(
    safeBootstrapDiagnostics({
      ...diagnostic,
      accessToken: 'PRIVATE_AUTH_VALUE',
      sessionToken: 'PRIVATE_AUTH_VALUE',
      cookieVerified: true,
      url: 'https://PRIVATE_AUTH_VALUE.invalid',
      inputValue: 'PRIVATE_AUTH_VALUE',
      unknown: 'PRIVATE_AUTH_VALUE'
    }),
    diagnostic
  );
  const filtered = safeBootstrapDiagnostics({
    reason: 'PRIVATE_AUTH_VALUE',
    authApiVerified: 'true',
    visibleLogin: 1,
    loggedInUi: 'PRIVATE_AUTH_VALUE',
    redirectDetected: null,
    challengeDetected: {},
    pageClosed: false,
    accountCheckHttpStatus: '200',
    accountCheckHasAccountFacts: 1,
    accountCheckIdentityMatches: 'true',
    unknown: true
  });
  assert.deepEqual(filtered, { pageClosed: false });
  assert.doesNotMatch(JSON.stringify(filtered), /PRIVATE_AUTH_VALUE|cookie|token|input/i);
  for (const input of [
    null,
    [],
    'PRIVATE_AUTH_VALUE',
    { reason: 'PRIVATE_AUTH_VALUE', visibleLogin: 'true' }
  ])
    assert.equal(safeBootstrapDiagnostics(input), undefined);
  for (const status of [100, 200, 401, 599])
    assert.deepEqual(safeBootstrapDiagnostics({ accountCheckHttpStatus: status }), {
      accountCheckHttpStatus: status
    });
  for (const status of [0, 99, 600, 200.5, NaN, Infinity, '200'])
    assert.equal(safeBootstrapDiagnostics({ accountCheckHttpStatus: status }), undefined);
});
test('bootstrap failure keeps its code and safe diagnostics through subscription and final confirmation', async () => {
  for (const code of ['SESSION_NOT_CONFIRMED', 'SESSION_BOOTSTRAP_FAILED']) {
    const diagnostic = {
      reason: code === 'SESSION_NOT_CONFIRMED' ? 'visible_login_content' : 'runtime_failed',
      authApiVerified: true,
      visibleLogin: true,
      loggedInUi: false,
      redirectDetected: false,
      challengeDetected: false,
      pageClosed: false,
      accountCheckHttpStatus: 401,
      accountCheckHasAccountFacts: false,
      accountCheckIdentityMatches: false
    };
    const f = await authenticationQueryFixture(
      Object.assign(new Error('PRIVATE_AUTH_VALUE'), {
        code,
        bootstrapDiagnostics: {
          ...diagnostic,
          token: 'PRIVATE_AUTH_VALUE',
          unknown: 'PRIVATE_AUTH_VALUE'
        }
      }),
      'session_bootstrap'
    );
    const result = await f.run('querySubscriptionBySession');
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, code);
    assert.deepEqual(JSON.parse(JSON.stringify(result.bootstrapDiagnostics)), diagnostic);
    assert.doesNotMatch(result.error, /PRIVATE_AUTH_VALUE|网络不可用/);
    const confirmation = evaluateSubscription('pro_20x', 'fixture-account', result);
    assert.equal(confirmation.verified, false);
    assert.equal(confirmation.queryErrorCode, code);
    assert.deepEqual(confirmation.queryBootstrapDiagnostics, diagnostic);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTH_VALUE|token|unknown/);
    assert.deepEqual(f.calls(), { mismatches: 1, resourcesClosed: 3 });
  }
});
test('authentication redirect never proves payment', () => {
  assert.equal(outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/auth/login'), false);
  assert.equal(
    outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/auth/login?redirect_status=succeeded'),
    false
  );
  assert.equal(
    outcomes.isVerifiedPaymentRedirect(
      'https://chatgpt.com.evil.invalid/?redirect_status=succeeded'
    ),
    false
  );
  assert.equal(
    outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/?redirect_status=succeeded'),
    true
  );
});
test('negative payment log and runtime error cannot override structured failure', () => {
  assert.deepEqual(
    outcomes.analyzeProcessOutput('尚未支付成功\n❌ [运行时错误]: synthetic_failure'),
    { status: 'failed', shouldRetry: false }
  );
  assert.deepEqual(outcomes.analyzeProcessOutput('PAYMENT_SUCCESS', { resultUnknown: true }), {
    status: 'result_unknown',
    shouldRetry: false
  });
});
test('provider unpaid and inactive are never terminal successes', () => {
  for (const status of ['unpaid', 'inactive', 'not succeeded', 'success_pending'])
    assert.equal(outcomes.isSuccessGptApiStatus(status), false);
  assert.equal(outcomes.isSuccessGptApiStatus(' SUCCESS '), true);
});
test('actual Stripe waiter does not accept a login redirect', async () => {
  process.env.PAYMENT_RESULT_TIMEOUT_MS = '20';
  process.env.CAPTCHA_OVERLAY_WAIT_MS = '20';
  const locator = {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    count: async () => 0,
    isVisible: async () => false,
    textContent: async () => 'Login'
  };
  let body = 'Login';
  const page = {
    url: () => 'https://chatgpt.com/auth/login',
    setDefaultTimeout() {},
    locator: () => locator,
    getByRole: () => locator,
    getByText: () => locator,
    frames: () => [],
    evaluate: async () => false,
    textContent: async () => body,
    waitForTimeout: async () => new Promise((r) => setTimeout(r, 25))
  };
  const stripe = require('../upstream/stripe-payment');
  const result = await stripe.waitForPaymentResult(page, 'Synthetic');
  assert.equal(result.success, false);
  assert.equal(result.resultUnknown, true);
  body = '尚未支付成功';
  const negative = await stripe.waitForPaymentResult(page, 'Synthetic');
  assert.equal(negative.success, false);
  assert.equal(negative.resultUnknown, true);
  const post = await stripe.handlePostSubmitPhase(page);
  assert.equal(post.action, 'continue');
});
test('same account and exact Pro variant required for confirmation', () => {
  const result = (rawPlan, account = 'acct-test') => ({
    ok: true,
    data: { rawPlan, upstreamAccountId: account, hasActiveSubscription: true }
  });
  assert.equal(
    evaluateSubscription('pro_5x', 'acct-test', result('chatgptprolite')).verified,
    true
  );
  assert.equal(
    evaluateSubscription('pro_20x', 'acct-test', result('chatgptprolite')).verified,
    false
  );
  assert.equal(evaluateSubscription('pro_20x', 'acct-test', result('pro')).verified, false);
  assert.equal(
    evaluateSubscription('pro_20x', 'acct-test', result('chatgptpro', 'other')).verified,
    false
  );
  assert.equal(
    evaluateSubscription('plus', 'acct-test', {
      ok: true,
      data: { accountId: 'acct-test', rawPlan: 'plus', hasActiveSubscription: true }
    }).verified,
    false
  );
});
test('RPC asset mutations retain UUID card and both leases', async () => {
  const t = task();
  rpc.configureTask(t);
  const calls = [];
  rpc.setTransportForTest(async (method, args) => {
    calls.push({ method, args });
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(t.id);
  await store.recordCardDecline(resource.id);
  await store.releaseCard(resource.id);
  const args = calls.find((c) => c.method === 'recordCardDecline').args;
  assert.equal(args.cardId, card().id);
  assert.equal(args.cardLeaseId, 'card-lease');
  assert.equal(args.cardLeaseVersion, 7);
  assert.equal(args.taskId, t.id);
  assert.equal(args.leaseId, t.leaseId);
  assert.equal(resource.card_cvc, null);
});
test('missing transient CVC waits rather than selecting another card', async () => {
  rpc.configureTask(task());
  let selections = 0;
  rpc.setTransportForTest(async (method) => {
    if (method === 'reserveCard') {
      selections++;
      return { ...card(), card_cvc: undefined };
    }
    return { ok: true };
  });
  credentialClient.setRequesterForTest(() => '');
  await assert.rejects(
    () => store.reserveCard(task().id),
    (e) => e.code === 'PENDING_CREDENTIALS'
  );
  assert.equal(selections, 1);
});
test('unknown submitted payment retains backend ownership and clears worker CVC', async () => {
  rpc.configureTask(task());
  const calls = [];
  rpc.setTransportForTest(async (method) => {
    calls.push(method);
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(task().id);
  let submitLease;
  rpc.setTransportForTest(async (method, args) => {
    calls.push(method);
    if (method === 'beforeExternalSubmit') submitLease = args;
    return { ok: true };
  });
  await rpc.beforeExternalSubmit();
  await store.releaseCard(resource.id);
  assert.equal(submitLease.cardId, resource.id);
  assert.equal(submitLease.cardLeaseId, 'card-lease');
  assert.equal(submitLease.cardLeaseVersion, 7);
  assert.equal(calls.includes('releaseCard'), false);
  assert.equal(resource.card_cvc, null);
});
test('billing RPC never contains PAN/CVC and unknown amount remains null', async () => {
  rpc.configureTask(task());
  let input;
  rpc.setTransportForTest(async (_, args) => {
    input = args;
    return { ok: true };
  });
  await store.createBillingRecord({
    card_number: card().card_number,
    card_cvc: '123',
    amount: null,
    currency: 'PHP'
  });
  assert.equal(input.card_number, undefined);
  assert.equal(input.card_cvc, undefined);
  assert.equal(input.amount, null);
  assert.equal(input.amountSource, 'unknown');
});
test('confirmed payment never releases backend card even if a usage RPC fails', async () => {
  rpc.configureTask(task());
  const calls = [];
  rpc.setTransportForTest(async (method) => {
    calls.push(method);
    if (method === 'recordCardUsage') throw new Error('synthetic write failure');
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(task().id);
  await assert.rejects(() => store.recordCardUsage(resource.id));
  await store.releaseCard(resource.id);
  assert.equal(calls.includes('releaseCard'), false);
  assert.equal(resource.card_cvc, null);
});
function thirdFixture(
  status,
  submit = { success: true, orderId: 'provider-order', taskId: 'provider-task' }
) {
  const calls = { submit: 0, reserve: 0, usage: 0, cancel: 0, billing: 0, request: null };
  const client = {
    inspectPay: async () => ({ success: true }),
    submitPay: async (_, input) => {
      calls.submit++;
      calls.request = { ...input, newCard: { ...input.newCard } };
      return submit;
    },
    queryTask: async () => ({
      success: true,
      rawStatus: status,
      data: { order_id: 'provider-order', task_id: 'provider-task', result: { ok: true } }
    }),
    queryOrder: async () => ({ success: true, rawStatus: status, data: {} })
  };
  const store = {
    reserveCard: async () => {
      calls.reserve++;
      return card();
    },
    getActiveProxy: async () => null,
    recordCardUsage: async () => {
      calls.usage++;
    },
    releaseCard: async () => {},
    recordCardDecline: async () => {}
  };
  return {
    calls,
    injected: {
      client,
      store,
      sleep: async () => {},
      beforeSubmit: async () => {},
      preflight: async () => ({ allowed: true }),
      confirm: async () => ({ verified: true, source: 'subscription', targetPlan: 'pro_5x' })
    }
  };
}
test('third party unknown/inactive polls once and never resubmits/rotates/cancels', async () => {
  const fixture = thirdFixture('inactive');
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.usage, 0);
  assert.equal(fixture.calls.cancel, 0);
  assert.equal(fixture.calls.billing, 0);
});
test('third party timeout after submit is never a retryable failure', async () => {
  const fixture = thirdFixture('', { success: false, error: 'synthetic timeout' });
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
});
test('third party conflict/throttle/timeout HTTP responses remain unknown and cannot release a code', async () => {
  for (const status of [408, 409, 429, 500]) {
    const fixture = thirdFixture('', { success: false, status });
    const result = await executeThirdParty(
      task(),
      { gptApi: {}, gptApiMaxPolls: 1 },
      fixture.injected
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(fixture.calls.submit, 1);
  }
  const disabled = thirdFixture('success');
  assert.equal(
    (await executeThirdParty(task(), { gptApi: { enabled: false } }, disabled.injected)).success,
    false
  );
  assert.equal(disabled.calls.submit, 0);
});
test('third party success requires confirmation and stable non-CDK task key', async () => {
  const fixture = thirdFixture('success');
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(fixture.calls.usage, 1);
  assert.equal(fixture.calls.request.idempotencyKey, 'task-synthetic-task');
  assert.equal(result.cardLast4, '4242');
  const uncertain = thirdFixture('paid');
  uncertain.injected.confirm = async () => ({ verified: false });
  const pending = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    uncertain.injected
  );
  assert.equal(pending.resultUnknown, true);
  assert.equal(uncertain.calls.usage, 0);
});
test('third party supplier response for another order stays unknown', async () => {
  const fixture = thirdFixture('success');
  fixture.injected.client.queryTask = async () => ({
    success: true,
    rawStatus: 'success',
    data: { order_id: 'other-order' }
  });
  assert.equal(
    (await executeThirdParty(task(), { gptApi: {}, gptApiMaxPolls: 1 }, fixture.injected))
      .resultUnknown,
    true
  );
  assert.equal(fixture.calls.usage, 0);
});
test('recheck performs only original order and subscription reads', async () => {
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.x`;
  const t = {
    ...task(),
    session: JSON.stringify({ accessToken: token }),
    payload: {
      recheckTaskId: 'original',
      originalProvider: 'third_party',
      providerOrderId: 'order',
      providerTaskId: 'provider-task',
      targetPlan: 'pro_5x'
    }
  };
  let reads = 0;
  const result = await recheck(
    t,
    {},
    {
      client: {
        queryTask: async (_, id) => {
          assert.equal(id, 'provider-task');
          reads++;
          return { success: true, rawStatus: 'success', data: { order_id: 'order', task_id: id } };
        }
      },
      query: async () => {
        reads++;
        return {
          ok: true,
          data: {
            upstreamAccountId: 'acct-test',
            rawPlan: 'chatgptprolite',
            hasActiveSubscription: true
          }
        };
      }
    }
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(reads, 2);
});
test('recheck generic Pro cannot release a code as conclusively failed', async () => {
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.x`;
  const t = {
    ...task(),
    session: JSON.stringify({ accessToken: token }),
    payload: {
      recheckTaskId: 'original',
      originalProvider: 'third_party',
      providerOrderId: 'order',
      providerTaskId: 'provider-task',
      targetPlan: 'pro_5x'
    }
  };
  const result = await recheck(
    t,
    {},
    {
      client: {
        queryTask: async () => ({
          success: true,
          rawStatus: 'failed',
          data: { order_id: 'order', task_id: 'provider-task' }
        })
      },
      query: async () => ({
        ok: true,
        data: { upstreamAccountId: 'acct-test', rawPlan: 'pro', hasActiveSubscription: true }
      })
    }
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(result.definitiveFailure, false);
});
test('log redaction hides dynamic secrets and protected debug URL only survives structured result', () => {
  security.rememberSecrets({
    card_cvc: '123',
    accessToken: 'synthetic-access-token',
    apiKey: 'synthetic-key'
  });
  const line = security.redactText(
    '123 synthetic-access-token synthetic-key 4242424242424242 https://chatgpt.com/checkout/abc?token=synthetic-secret'
  );
  assert.equal(
    /123|synthetic-access-token|synthetic-key|4242424242424242|synthetic-secret/.test(line),
    false
  );
  const result = security.sanitizeResult({
    debugOnly: true,
    checkoutUrl: 'https://chatgpt.com/checkout/abc?token=synthetic-secret'
  });
  assert.match(result.checkoutUrl, /token=/);
  assert.doesNotMatch(security.sanitize(result).checkoutUrl, /token=/);
  assert.equal(
    security.sanitizeResult({
      data: { billingPageUrl: 'https://chatgpt.com/#settings/Subscription' }
    }).data.billingPageUrl,
    'https://chatgpt.com/#settings/Subscription'
  );
  assert.doesNotMatch(
    security.sanitizeResult({ data: { billingPageUrl: 'https://chatgpt.com/#synthetic-secret' } })
      .data.billingPageUrl,
    /synthetic-secret/
  );
});
test('operational logs preserve business identity, full IP, amounts and durations', () => {
  const taskId = '12345678-1234-4567-8def-123456789012';
  security.rememberSecrets({ jobKey: taskId, card_cvc: '123', accessToken: 'synthetic-token' });
  const business = `${taskId} fixture@example.invalid 8.8.8.123 PHP 9990.00 Timeout 29983.123456789ms`;
  assert.equal(security.redactText(business), business);
  const credentials = security.redactText('cvc=123 token=synthetic-token 4242424242424242');
  assert.doesNotMatch(credentials, /123|synthetic-token|4242424242424242/);
});
test('worker concurrency uses runtime capacity and optional environment hard cap', () => {
  const { capacity, childEnvironment } = require('../worker.cjs');
  assert.equal(capacity({ maxConcurrent: 2 }, {}), 2);
  assert.equal(capacity({ maxConcurrent: 3 }, { ONLINE_RECHARGE_WORKER_CONCURRENCY: '2' }), 2);
  assert.equal(capacity({ maxConcurrent: 1 }, { ONLINE_RECHARGE_WORKER_CONCURRENCY: '5' }), 1);
  process.env.DATABASE_URL = 'synthetic-db-secret';
  const env = childEnvironment(task());
  delete process.env.DATABASE_URL;
  assert.equal(env.DATABASE_URL, undefined);
  assert.match(env.ONLINE_RECHARGE_MEDIA_DIR, /synthetic-task$/);
});
test('browser management validation failure does not become an unknown payment', async () => {
  let finish;
  rpc.setTransportForTest(async (method, args) => {
    if (method === 'failJob') finish = args;
    return { ok: true };
  });
  await require('../worker.cjs').runJob(
    {
      ...task(),
      operation: 'browser_manage',
      payload: { action: 'invalid' },
      leaseExpiresAt: new Date(Date.now() + 90000).toISOString()
    },
    { browserPool: { enabled: false, size: 2 } }
  );
  assert.equal(finish.status, 'failed');
  assert.equal(finish.result.resultUnknown, undefined);
});
test('runtime and media paths reject relative, foreign-project and traversal outputs', () => {
  const { resolveProjectPath } = require('../paths.cjs');
  const fallback = path.join(__dirname, '..', 'runtime');
  assert.equal(resolveProjectPath('', fallback), fallback);
  assert.throws(() => resolveProjectPath('runtime', fallback));
  assert.throws(() => resolveProjectPath('/tmp/foreign-project', fallback));
  assert.throws(() =>
    resolveProjectPath(
      path.join(__dirname, '..', '../../../../../../../../../../outside'),
      fallback
    )
  );
});
test('real-page screenshots require masks and never fall back to raw capture', async () => {
  const media = require('../safe-media.cjs');
  const dir = path.join(__dirname, '..', 'runtime', `media-test-${process.pid}`);
  process.env.ONLINE_RECHARGE_MEDIA_DIR = dir;
  process.env.ONLINE_RECHARGE_FFMPEG_PATH = '/nonexistent/synthetic-ffmpeg';
  let options;
  let captureCalls = 0;
  const page = {
    evaluate: async (callback) => (String(callback).includes('document.fonts') ? true : undefined),
    locator: (selector) => {
      assert.match(selector, /cc-number/);
      assert.doesNotMatch(selector, /input,textarea|iframe/);
      return { selector };
    },
    screenshot: async (input) => {
      captureCalls++;
      options = input;
      return Buffer.from('synthetic-redacted-image');
    }
  };
  await media.start();
  await media.screenshot(page);
  const files = await media.finish();
  assert.equal(options.path, undefined);
  assert.equal(options.mask.length, 1);
  assert.equal(files.length, 1);
  await media.start();
  const failure = {
    ...page,
    evaluate: async (callback) => {
      if (String(callback).includes('document.fonts')) return true;
      throw new Error('synthetic page unavailable');
    }
  };
  assert.equal(await media.screenshot(failure), null);
  assert.equal(captureCalls, 1, 'failed masking must never produce another raw or masked image');
  assert.deepEqual(await media.finish(), []);
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.ONLINE_RECHARGE_MEDIA_DIR;
  delete process.env.ONLINE_RECHARGE_FFMPEG_PATH;
});
test('private CVC service returns availability only, binds task ownership, clears on completion', async () => {
  const credentials = require('../credentials.cjs');
  const key = 'synthetic-internal-key-at-least-32-characters';
  const service = await credentials.start({ url: 'http://127.0.0.1:0', key });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = async (route, body, auth = key) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-online-recharge-worker': auth },
      body: JSON.stringify(body)
    });
  try {
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '123' }] }, 'wrong')).status,
      401
    );
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '123' }] })).status,
      200
    );
    const status = await (await post('/credentials/status', { ids: [card().id] })).json();
    assert.deepEqual(status, { availableIds: [card().id] });
    assert.equal(status.cvc, undefined);
    assert.equal(credentials.take(card().id, 'task-a'), '123');
    assert.equal(credentials.take(card().id, 'task-b'), '');
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '456' }] })).status,
      409
    );
    credentials.forgetTask('task-a');
    assert.deepEqual(await (await post('/credentials/status', { ids: [card().id] })).json(), {
      availableIds: []
    });
  } finally {
    await service.close();
  }
});

test('private CVC lasts 24 hours from the last save without extending task ownership', async () => {
  let now = Date.UTC(2026, 0, 1);
  const initial = now;
  const hour = 60 * 60 * 1000;
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../credentials.cjs'), 'utf8'), {
    module,
    require,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    URL,
    Buffer,
    process: { env: {} },
    setInterval,
    clearInterval
  });
  const credentials = module.exports;
  const key = 'synthetic-cvc-ttl-internal-key-32-characters';
  const service = await credentials.start({ url: 'http://127.0.0.1:0', key });
  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-online-recharge-worker': key },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const saved = await post('/credentials', {
      cards: [
        { id: 'primary', cvc: '123' },
        { id: 'refreshed', cvc: '456' }
      ]
    });
    assert.deepEqual(saved, { ok: true, expiresInSeconds: 86400 });
    now = initial + hour / 2;
    assert.equal(credentials.take('primary', 'task-a'), '123');
    assert.equal(credentials.take('primary', 'task-b'), '');
    now = initial + 23 * hour;
    await post('/credentials', { cards: [{ id: 'refreshed', cvc: '789' }] });
    now = initial + 24 * hour - 1;
    assert.equal(credentials.take('primary', 'task-a'), '123');
    now += 1;
    assert.equal(credentials.take('primary', 'task-a'), '');
    assert.deepEqual(await post('/credentials/status', { ids: ['primary', 'refreshed'] }), {
      availableIds: ['refreshed']
    });
    await post('/credentials', { cards: [{ id: 'primary', cvc: '123' }] });
    assert.equal(credentials.take('primary', 'task-b'), '123');
    credentials.forgetTask('task-b');
    assert.equal(credentials.take('primary', 'task-b'), '');
    now = initial + 47 * hour - 1;
    assert.equal(credentials.take('refreshed', 'task-a'), '789');
    now += 1;
    assert.equal(credentials.take('refreshed', 'task-a'), '');
    await post('/credentials', { cards: [{ id: 'close-check', cvc: '123' }] });
  } finally {
    await service.close();
  }
  assert.equal(credentials.take('close-check', 'task-a'), '');
});

for (const response of [
  { order_id: 'other-order', task_id: 'provider-task' },
  { order_id: 'provider-order', task_id: 'other-task' },
  {}
])
  test(`third party failed response must identify the original order: ${JSON.stringify(response)}`, async () => {
    rpc.configureTask(task());
    rpc.setTransportForTest(async () => ({ ok: true }));
    const fixture = thirdFixture('failed');
    let releases = 0;
    let declines = 0;
    fixture.injected.beforeSubmit = rpc.beforeExternalSubmit;
    fixture.injected.store.releaseCard = async () => {
      releases++;
    };
    fixture.injected.store.recordCardDecline = async () => {
      declines++;
    };
    fixture.injected.client.queryTask = async () => ({
      success: true,
      rawStatus: 'failed',
      data: { ...response, result: { ok: false, error: 'card_declined' } }
    });
    const result = await executeThirdParty(
      task(),
      { gptApi: {}, gptApiMaxPolls: 1 },
      fixture.injected
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(fixture.calls.submit, 1);
    assert.equal(fixture.calls.reserve, 1);
    assert.equal(fixture.calls.usage, 0);
    assert.equal(releases, 0);
    assert.equal(declines, 0);
    assert.equal(rpc.wasSubmitted(), true);
  });

test('a matching original supplier failure remains a definitive failure', async () => {
  const fixture = thirdFixture('failed');
  fixture.injected.client.queryTask = async () => ({
    success: true,
    rawStatus: 'failed',
    data: { order_id: 'provider-order', task_id: 'provider-task', result: { ok: false } }
  });
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.definitiveFailure, true);
  assert.notEqual(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
});

for (const data of [{}, { order_id: 'other-order' }, { task_id: 'other-task' }])
  test(`recheck cannot release an original order without matching identity: ${JSON.stringify(data)}`, async () => {
    const t = {
      ...task(),
      payload: {
        recheckTaskId: 'original',
        originalProvider: 'third_party',
        providerOrderId: 'original-order',
        providerTaskId: 'original-task'
      }
    };
    let subscriptionReads = 0;
    const result = await recheck(
      t,
      {},
      {
        client: { queryTask: async () => ({ success: true, rawStatus: 'failed', data }) },
        query: async () => {
          subscriptionReads++;
          return { ok: true, data: {} };
        }
      }
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(subscriptionReads, 0);
  });

for (const result of [
  { allowed: false, alreadyActive: true, error: 'Synthetic already active' },
  { allowed: false, alreadyActive: false, error: 'Synthetic account mismatch' }
])
  test(`third party cannot submit for failed subscription preflight: ${result.alreadyActive}`, async () => {
    const fixture = thirdFixture('success');
    fixture.injected.preflight = async () => result;
    const out = await executeThirdParty(task(), { gptApi: {} }, fixture.injected);
    assert.equal(out.success, false);
    assert.equal(out.submitted, false);
    assert.equal(out.alreadyActive, result.alreadyActive);
    assert.equal(fixture.calls.submit, 0);
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.billing, 0);
  });
