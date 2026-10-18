'use strict';
/* global window, XMLHttpRequest */

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const { prepareCheckoutCardSection } = require('../upstream/stripe-payment');
const { inspectCardReadiness } = require('../checkout-form.cjs');

const browserMode = process.env.SESSION_ROUTING_BROWSER_MODE || 'native';
const headful = process.env.SESSION_ROUTING_HEADFUL === '1';
assert.ok(['native', 'standalone', 'pool'].includes(browserMode), 'Unknown synthetic browser mode');

async function closeOwnedBrowser(browser) {
  await browser.close();
  assert.equal(browser.isConnected(), false);
}

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function launchFixtureBrowser(args) {
  if (browserMode === 'native') {
    const browser = await chromium.launch({ headless: !headful, args });
    return { browser, close: () => closeOwnedBrowser(browser) };
  }
  const { chromium: extraChromium } = require('../upstream/node_modules/playwright-extra');
  const method = browserMode === 'pool' ? 'launchPersistentContext' : 'launch';
  const original = extraChromium[method];
  // Execute the actual installed launcher and its plugins. This test-only
  // wrapper appends egress isolation; it does not substitute a native launcher.
  extraChromium[method] = function (...parameters) {
    const index = method === 'launch' ? 0 : 1;
    parameters[index] = {
      ...parameters[index],
      executablePath: chromium.executablePath(),
      args: [...parameters[index].args, ...args]
    };
    return original.apply(this, parameters);
  };
  let pool, slot, profile;
  const savedEnv = Object.fromEntries(
    ['BROWSER_POOL_BASE_PORT', 'HEADFUL', 'CHROMIUM_CHANNEL'].map((key) => [key, process.env[key]])
  );
  const closePool = async () => {
    try {
      if (slot) pool.releaseSlot(slot.slotId);
      await pool?.shutdownBrowserPool();
      if (pool) assert.equal(pool.getStats().size, 0);
    } finally {
      if (profile) {
        fs.rmSync(profile, { recursive: true, force: true });
        assert.equal(fs.existsSync(profile), false);
      }
    }
  };
  try {
    if (browserMode === 'standalone') {
      const session = await require('../upstream/browser-standalone').connectStandaloneBrowser({
        headful,
        cdpPort: '0'
      });
      assert.equal(session.mode, 'standalone');
      assert.equal(session.ownsBrowser, true);
      return { browser: session.browser, close: () => closeOwnedBrowser(session.browser) };
    }
    process.env.BROWSER_POOL_BASE_PORT = String(await unusedPort());
    process.env.HEADFUL = headful ? '1' : '0';
    process.env.CHROMIUM_CHANNEL = '';
    const poolPath = require.resolve('../upstream/browser-pool');
    delete require.cache[poolPath];
    pool = require(poolPath);
    const projectRuntime = path.resolve(__dirname, '../../../../../../../.runtime');
    fs.mkdirSync(projectRuntime, { recursive: true });
    profile = fs.mkdtempSync(path.join(projectRuntime, 'session-routing-pool-'));
    pool.setRuntimeProfileRoot(profile);
    pool.setRuntimePoolSize(1);
    pool.setRuntimeEnabled(true);
    const initialized = await pool.initBrowserPool();
    assert.equal(initialized.size, 1);
    slot = await pool.acquireSlot('synthetic-session-routing');
    assert.ok(slot);
    const session = await require('../upstream/browser-pool-client').connectPoolBrowser({
      poolCdpUrl: slot.cdpUrl,
      poolSlotId: slot.slotId
    });
    assert.equal(session.mode, 'pool');
    assert.equal(session.ownsBrowser, false);
    // The borrowed client never closes the browser. Its owner closes the
    // persistent context after the fixture's isolated task context is closed.
    return { browser: session.browser, close: closePool };
  } catch (error) {
    await closePool();
    throw error;
  } finally {
    extraChromium[method] = original;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const origin = 'https://chatgpt.com';
const accountId = 'synthetic-route-account';
const userId = 'synthetic-route-user';
const accessToken = `synthetic.${Buffer.from(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId },
    'https://api.openai.com/profile': { email: 'route@example.invalid' }
  })
).toString('base64url')}.synthetic`;
const sessionCookie = 'synthetic-route-cookie';
const session = {
  accessToken,
  account: { id: accountId },
  user: { id: userId, email: 'route@example.invalid' },
  cookies: [
    {
      name: '__Secure-next-auth.session-token',
      value: sessionCookie,
      domain: '.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true
    }
  ]
};

// Match the existing network-browser fixtures: an ephemeral test key stays in
// memory, and every permitted hostname maps directly to this loopback listener.
function certificate() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const cert = execFileSync(
    '/bin/sh',
    ['-c', 'cat | openssl req -new -x509 -key /dev/stdin -sha256 -days 1 -subj /CN=localhost'],
    { input: key, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
  );
  return { key, cert };
}
const tls = certificate();

const lazyCheckout = `<!doctype html><meta charset="utf-8"><main>
  <p id="auth-state">Waiting for synthetic identity</p>
  <div style="height:1800px"></div><section id="payment-method"></section>
  <script>
    window.mounts = 0;
    const request = new XMLHttpRequest();
    request.open('GET', '/api/auth/session?phase=checkout-initialization');
    request.onload = () => {
      const session = JSON.parse(request.responseText);
      if (session.transportResponse || session.user?.id !== '${userId}'
          || session.account?.id !== '${accountId}') return;
      document.getElementById('auth-state').textContent = 'Synthetic identity confirmed';
      const section = document.getElementById('payment-method');
      section.innerHTML = '<p id="card-label" aria-hidden="true">Card number</p>';
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting) && !window.mounts) {
          window.mounts++;
          section.insertAdjacentHTML('beforeend', '<input autocomplete="cc-number">');
          observer.disconnect();
        }
      });
      observer.observe(document.getElementById('card-label'));
    };
    request.send();
  </script></main>`;

async function fixture(t) {
  const transport = [];
  const requests = [];
  const logs = [];
  const server = https.createServer(tls, (request, response) => {
    const url = new URL(request.url, origin);
    transport.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      hasAuthorization: Boolean(request.headers.authorization)
    });
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      response.writeHead(409).end('{}');
    } else if (url.pathname === '/api/auth/session' && request.headers.host === 'chatgpt.com') {
      response.setHeader('content-type', 'application/json');
      // The installation's real Cookie probe is synthetic too. If a later
      // request misses its dedicated handler this marker exposes the transport.
      response.end(JSON.stringify({ ...session, transportResponse: true }));
    } else if (url.pathname === '/fixture/lazy-checkout') {
      response.setHeader('content-type', 'text/html');
      response.end(lazyCheckout);
    } else if ((url.pathname === '/' && !url.search) || url.pathname === '/fixture/page') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><meta charset="utf-8"><main>Synthetic route fixture</main>');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ transportResponse: true }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const names = [
    'chatgpt.com',
    'openai.com',
    'pay.openai.com',
    'api.chatgpt.com',
    'auth.openai.com',
    'third-party.invalid',
    'chatgpt.com.third-party.invalid',
    'accounts.google.com',
    'login.microsoftonline.com'
  ];
  const runtime = await launchFixtureBrowser([
    '--disable-background-networking',
    '--no-proxy-server',
    '--disable-features=BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks',
    `--host-resolver-rules=${names.map((name) => `MAP ${name} 127.0.0.1:${server.address().port}`).join(', ')}, MAP * ~NOTFOUND`
  ]);
  let context;
  t.after(async () => {
    try {
      await context?.close();
    } finally {
      await runtime.close();
    }
  });
  context = await runtime.browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  context.setDefaultTimeout(4000);
  context.on('request', (request) =>
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      hasAuthorization: Boolean(request.headers().authorization)
    })
  );
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  const filename = path.resolve(__dirname, '../upstream/session-auth.js');
  const module = { exports: {} };
  runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      Buffer,
      URL,
      performance,
      process: { env: {} },
      require: createRequire(filename),
      console: {
        log: (...values) => logs.push(values.join(' ')),
        warn: (...values) => logs.push(values.join(' '))
      }
    },
    { filename }
  );
  // Use the production installer with the real BrowserContext. No handler is
  // called by this fixture; Chromium and Playwright dispatch the complete chain.
  const installed = await module.exports.installChatGptSession(context, JSON.stringify(session));
  assert.equal(installed.cookieVerified, true);
  transport.length = 0;
  requests.length = 0;
  const page = await context.newPage();
  await page.goto(`${origin}/fixture/page`);
  return { page, context, transport, requests, logs };
}

async function xhr(page, url) {
  return page.evaluate(
    (target) =>
      new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('GET', target);
        request.onload = () =>
          resolve({ status: request.status, body: JSON.parse(request.responseText) });
        request.onerror = () => reject(new Error('Synthetic XHR was blocked'));
        request.send();
      }),
    url
  );
}

function noBusinessActions(f) {
  assert.equal(
    f.requests.some((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)),
    false
  );
  assert.equal(
    f.requests.some((request) => /^\/backend-api\/payments\//.test(request.path)),
    false
  );
  assert.equal(
    f.transport.some((request) => request.hasAuthorization),
    false
  );
  assert.equal(f.logs.join('\n').includes(accessToken), false);
  assert.equal(f.logs.join('\n').includes(sessionCookie), false);
}

test('official authentication requests reach dedicated handlers through the real route chain', async (t) => {
  const f = await fixture(t);
  for (const host of ['chatgpt.com', 'pay.openai.com', 'api.chatgpt.com']) {
    for (const query of ['', '?phase=synthetic&return=%2Ffixture%2Fpage']) {
      const auth = await xhr(f.page, `https://${host}/api/auth/session${query}`);
      assert.equal(auth.status, 200);
      assert.equal(auth.body.user?.id === userId, true);
      assert.equal(auth.body.account?.id === accountId, true);
      assert.equal(auth.body.accessToken === accessToken, true);
      assert.equal(auth.body.transportResponse === true, false);
      const csrf = await xhr(f.page, `https://${host}/api/auth/csrf${query}`);
      assert.equal(csrf.status, 200);
      assert.equal(csrf.body.csrfToken === 'bootstrap-csrf-token', true);
      assert.equal(csrf.body.transportResponse === true, false);
    }
  }
  for (const endpoint of ['session', 'csrf']) {
    const response = await f.page.goto(`${origin}/api/auth/${endpoint}?phase=document`);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).transportResponse === true, false);
  }
  assert.equal(
    f.transport.some((request) => /^\/api\/auth\/(?:session|csrf)$/.test(request.path)),
    false
  );
  noBusinessActions(f);
});

test('third-party and noncanonical authentication lookalikes retain native transport without credentials', async (t) => {
  const f = await fixture(t);
  for (const url of [
    'https://third-party.invalid/api/auth/session',
    'https://third-party.invalid/api/auth/csrf?phase=synthetic',
    'https://chatgpt.com.third-party.invalid/api/auth/session',
    'https://third-party.invalid/?return=https://chatgpt.com/api/auth/session',
    `${origin}/prefix/api/auth/session`,
    `${origin}/api/auth/session/`,
    `${origin}/api/auth/session-extra`,
    `${origin}/?return=/api/auth/session`
  ]) {
    const result = await xhr(f.page, url);
    assert.equal(result.status, 200);
    assert.equal(result.body.transportResponse, true);
    assert.equal(Boolean(result.body.accessToken || result.body.csrfToken), false);
  }
  const ordinary = await xhr(f.page, `${origin}/fixture/ordinary-get`);
  assert.equal(ordinary.body.transportResponse, true);
  noBusinessActions(f);
});

test('login navigation remains blocked while ordinary requests keep their native headers', async (t) => {
  const f = await fixture(t);
  const allowed = await xhr(f.page, `${origin}/auth/login?phase=xhr`);
  assert.equal(allowed.body.transportResponse, true);
  const blocked = [
    `${origin}/auth/login`,
    `${origin}/auth/signin`,
    `${origin}/auth/error`,
    'https://auth.openai.com/auth/login',
    'https://accounts.google.com/fixture',
    'https://login.microsoftonline.com/fixture'
  ];
  const baseline = f.transport.length;
  for (const url of blocked) await assert.rejects(f.page.goto(url), /net::ERR_/);
  assert.equal(f.transport.length, baseline);
  noBusinessActions(f);
});

test('authenticated XHR initialization precedes physical ARIA card preparation and real readiness', async (t) => {
  const f = await fixture(t);
  await f.page.goto(`${origin}/fixture/lazy-checkout`);
  await f.page.getByText('Synthetic identity confirmed', { exact: true }).waitFor();
  assert.equal(await f.page.locator('input[autocomplete="cc-number"]').count(), 0);
  assert.equal(await f.page.evaluate(() => window.mounts), 0);
  const before = await inspectCardReadiness(f.page, { deadline: Date.now() + 2000 });
  assert.equal(before.ready, false);
  await prepareCheckoutCardSection(f.page, { maxWaitMs: 2000 });
  await f.page.locator('input[autocomplete="cc-number"]').waitFor();
  const after = await inspectCardReadiness(f.page, { deadline: Date.now() + 4000 });
  assert.equal(after.ready, true);
  assert.equal(await f.page.evaluate(() => window.mounts), 1);
  assert.equal(
    f.transport.some((request) => request.path === '/api/auth/session'),
    false
  );
  noBusinessActions(f);
});
