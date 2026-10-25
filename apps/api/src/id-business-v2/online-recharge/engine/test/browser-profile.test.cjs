'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('../upstream/node_modules/playwright');
const { binding, launchProfile } = require('../browser-profile.cjs');
const auth = require('../upstream/session-auth');
const base = path.join(__dirname, '..', 'runtime', 'verification', 'persistent-profile');
const raw = JSON.stringify({
  accessToken: 'synthetic-bearer-profile-fixture',
  account: { id: 'synthetic-account-profile' },
  user: { id: 'synthetic-user-profile' },
  sessionToken: 'synthetic-outdated-cookie-only'
});
const options = {
  sessionRaw: raw,
  proxyBinding: 'http://fixture:password@127.0.0.1:8080',
  launchOptions: {
    headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']
  }
};

async function fixture(
  root,
  { exit = '192.0.2.10', sessionStatus = 200, account = 'synthetic-account-profile' } = {}
) {
  let officialRequests = 0,
    manualCalls = 0;
  const native = {
    async launchPersistentContext(directory, config) {
      const context = await chromium.launchPersistentContext(directory, config);
      // All test network traffic is fulfilled locally; DNS is blocked at launch.
      context.request.get = async (url) => {
        assert.equal(url, 'http://api.ipify.org/?format=text');
        return { ok: () => true, text: async () => exit, dispose: async () => {} };
      };
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'chatgpt.com' && url.pathname === '/api/auth/session') {
          officialRequests++;
          return route.fulfill(
            sessionStatus === 403
              ? {
                  status: 403,
                  contentType: 'text/html',
                  headers: { 'cf-mitigated': 'challenge' },
                  body: '<html><body>Just a moment <script src="/cdn-cgi/challenge-platform/test"></script></body></html>'
                }
              : {
                  contentType: 'application/json',
                  body: JSON.stringify({
                    accessToken: 'synthetic-bearer-profile-fixture',
                    account: { id: account },
                    user: { id: 'synthetic-user-profile' },
                    expires: '2099-01-01T00:00:00Z'
                  })
                }
          );
        }
        if (url.pathname.startsWith('/backend-api/accounts/check/')) {
          officialRequests++;
          return route.fulfill({
            status: 403,
            contentType: 'text/html',
            headers: { 'cf-mitigated': 'challenge' },
            body: '<html>Just a moment</html>'
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body>synthetic profile fixture</body></html>'
        });
      });
      return context;
    }
  };
  const session = await launchProfile(native, { ...options, root });
  return {
    ...session,
    counts: () => ({ officialRequests, manualCalls }),
    manual: async () => {
      manualCalls++;
      return { completed: true };
    }
  };
}

test('profile key isolates account, user, upstream proxy and browser channel without plaintext', () => {
  const key = binding(raw, options.proxyBinding);
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const value of [
    JSON.stringify({ ...JSON.parse(raw), account: { id: 'another-account' } }),
    JSON.stringify({ ...JSON.parse(raw), user: { id: 'another-user' } })
  ])
    assert.notEqual(binding(value, options.proxyBinding), key);
  assert.notEqual(binding(raw, 'http://127.0.0.1:8081'), key);
  assert.notEqual(binding(raw, options.proxyBinding, 'chrome'), key);
  assert.throws(() => binding('{}', ''), { code: 'PROFILE_IDENTITY_MISSING' });
});

test(
  'three isolated launches preserve HttpOnly cookie and storage; valid saved session is not overwritten',
  { timeout: 60000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'reuse-'));
    let current;
    try {
      for (let i = 0; i < 3; i++) {
        current = await fixture(root);
        const context = current.context;
        const page = await context.newPage();
        await page.goto('https://chatgpt.com/');
        if (i === 0) {
          await context.addCookies([
            {
              name: '__Secure-next-auth.session-token',
              value: 'synthetic-refreshed-cookie-only',
              url: 'https://chatgpt.com',
              httpOnly: true,
              secure: true,
              expires: Date.now() / 1000 + 3600
            }
          ]);
          await page.evaluate(() => localStorage.setItem('synthetic-restored', 'yes'));
        }
        const stored = (await context.storageState()).cookies.find(
          (c) => c.name === '__Secure-next-auth.session-token'
        );
        assert.equal(stored.httpOnly, true);
        assert.equal(stored.value, 'synthetic-refreshed-cookie-only');
        assert.equal(await page.evaluate(() => localStorage.getItem('synthetic-restored')), 'yes');
        assert.equal(
          await page.evaluate(() => document.cookie.includes('synthetic-refreshed-cookie-only')),
          false
        );
        const result = await auth.installChatGptSession(context, raw, {
          nativeSession: true,
          preserveStoredSession: true,
          onHumanVerification: current.manual
        });
        assert.equal(result.cookieVerified, true);
        assert.equal(current.counts().officialRequests, 1);
        assert.equal(
          (await context.cookies()).find((c) => c.name === stored.name).value,
          stored.value
        );
        await page.reload();
        assert.equal(
          await page.evaluate(() => window.__CHATGPT_BOOTSTRAP_SESSION__ === undefined),
          true
        );
        // Native automation properties remain native; no undefined-webdriver patch is installed.
        assert.equal(await page.evaluate(() => navigator.webdriver), true);
        const browser = context.browser();
        await current.close();
        assert.equal(browser.isConnected(), false);
        current = null;
      }
      const metadata = await fs.readFile(
        path.join(root, binding(raw, options.proxyBinding), '.exit-binding.json'),
        'utf8'
      );
      assert.ok(!metadata.includes('192.0.2.10') && !metadata.includes('password'));
      const prefs = JSON.parse(
        await fs.readFile(
          path.join(root, binding(raw, options.proxyBinding), 'Default', 'Preferences')
        )
      );
      assert.equal(prefs.autofill.credit_card_enabled, false);
      assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
    } finally {
      await current?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'exclusive profile rejects concurrent use and egress change before any official request',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'exclusive-'));
    let current;
    try {
      current = await fixture(root);
      await assert.rejects(fixture(root), { code: 'PROFILE_BUSY' });
      assert.equal(current.counts().officialRequests, 0);
      await current.close();
      current = null;
      await assert.rejects(fixture(root, { exit: '192.0.2.11' }), { code: 'PROFILE_EXIT_CHANGED' });
      current = await fixture(root);
      assert.equal(current.counts().officialRequests, 0);
    } finally {
      await current?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'native session challenge fails without human callback and releases browser/profile',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'challenge-'));
    let current;
    try {
      current = await fixture(root, { sessionStatus: 403 });
      await current.context.addCookies([
        {
          name: '__Secure-next-auth.session-token',
          value: 'synthetic-cookie',
          url: 'https://chatgpt.com',
          httpOnly: true,
          secure: true
        }
      ]);
      const started = Date.now();
      await assert.rejects(
        auth.installChatGptSession(current.context, raw, {
          nativeSession: true,
          preserveStoredSession: true,
          onHumanVerification: current.manual
        }),
        (error) =>
          error.code === 'CHALLENGE_BLOCKED' &&
          error.bootstrapDiagnostics.initialSessionProbe.classification === 'CF_CHALLENGE'
      );
      const browser = current.context.browser();
      await current.close();
      current = null;
      assert.ok(
        Date.now() - started < 5000,
        'synthetic challenge exit includes actual browser close'
      );
      assert.equal(browser.isConnected(), false);
      current = await fixture(root);
      assert.equal(current.counts().manualCalls, 0);
    } finally {
      await current?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test('stored account mismatch stops without replacing cookies', { timeout: 30000 }, async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'identity-'));
  const current = await fixture(root, { account: 'another-account' });
  try {
    await current.context.addCookies([
      {
        name: '__Secure-next-auth.session-token',
        value: 'synthetic-cookie',
        url: 'https://chatgpt.com',
        httpOnly: true,
        secure: true
      }
    ]);
    await assert.rejects(
      auth.installChatGptSession(current.context, raw, {
        nativeSession: true,
        preserveStoredSession: true
      }),
      { code: 'ACCOUNT_MISMATCH' }
    );
    assert.equal(
      (await current.context.cookies()).find((c) => c.name === '__Secure-next-auth.session-token')
        .value,
      'synthetic-cookie'
    );
  } finally {
    await current.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('worker profile root survives task temporary-directory cleanup', async () => {
  const { childEnvironment } = require('../worker.cjs');
  const { clearTransientRoot } = require('../paths.cjs');
  const env = childEnvironment({ id: 'synthetic-profile-path' });
  assert.ok(
    !env.ONLINE_RECHARGE_PROFILE_ROOT.startsWith(path.dirname(env.ONLINE_RECHARGE_RUNTIME_DIR))
  );
  clearTransientRoot();
  assert.match(env.ONLINE_RECHARGE_PROFILE_ROOT, /browser-profiles$/);
});

test(
  'same-page subscription challenge preserves response evidence and never calls manual verification',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'subscription-'));
    const current = await fixture(root);
    const previous = process.env.ONLINE_RECHARGE_PROFILE_ROOT;
    process.env.ONLINE_RECHARGE_PROFILE_ROOT = root;
    try {
      const page = await current.context.newPage();
      await page.goto('https://chatgpt.com/');
      const result = await require('../upstream/subscription-check').querySubscriptionBySession(
        'synthetic-bearer-profile-fixture',
        {
          page,
          browserContext: current.context,
          sessionRaw: raw,
          onHumanVerification: current.manual
        }
      );
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'CHALLENGE_BLOCKED');
      assert.equal(result.diagnostics.at(-1).responseFacts.classification, 'CF_CHALLENGE');
      assert.equal(current.counts().manualCalls, 0);
      assert.equal(current.counts().officialRequests, 1);
    } finally {
      if (previous === undefined) delete process.env.ONLINE_RECHARGE_PROFILE_ROOT;
      else process.env.ONLINE_RECHARGE_PROFILE_ROOT = previous;
      await current.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'owned persistent browser is terminated when graceful close stalls',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'close-'));
    const current = await fixture(root);
    const browser = current.context.browser();
    current.context.close = () => new Promise(() => {});
    try {
      const started = Date.now();
      await current.close();
      assert.equal(browser.isConnected(), false);
      assert.ok(Date.now() - started < 4000);
      const reopened = await fixture(root);
      await reopened.close();
    } finally {
      await current.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'native browser launcher returns its persistent context even when generic pool mode is configured',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'adapter-'));
    const original = chromium.launchPersistentContext;
    let session;
    chromium.launchPersistentContext = async function (directory, config) {
      assert.ok(!config.args.some((arg) => /AutomationControlled/.test(arg)));
      assert.equal(config.userAgent, undefined);
      assert.equal(config.extraHTTPHeaders, undefined);
      const context = await original.call(this, directory, {
        ...config,
        args: [
          ...config.args,
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND'
        ]
      });
      context.request.get = async () => ({
        ok: () => true,
        text: async () => '192.0.2.10',
        dispose: async () => {}
      });
      return context;
    };
    try {
      const runtime = require('../upstream/browser-runtime');
      session = await runtime.connectTaskBrowser({
        env: {
          ONLINE_RECHARGE_PROFILE_ROOT: root,
          CHATGPT_SESSION_JSON: raw,
          PROXY: options.proxyBinding,
          BROWSER_RUNTIME_MODE: 'pool',
          CDP_PORT: '0'
        }
      });
      assert.equal(session.mode, 'persistent');
      assert.equal(session.browser.contexts().length, 1);
      assert.equal(session.context, session.browser.contexts()[0]);
      assert.equal(await session.context.pages()[0].evaluate(() => navigator.webdriver), true);
      await runtime.closeTaskBrowser(session, session.browser);
      assert.equal(session.browser.isConnected(), false);
    } finally {
      chromium.launchPersistentContext = original;
      await session?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test('Chromium profile lock excludes a second worker process', { timeout: 30000 }, async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'process-lock-'));
  const current = await fixture(root);
  try {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const script = `
      const { chromium } = require(${JSON.stringify(require.resolve('../upstream/node_modules/playwright'))});
      const { launchProfile } = require(${JSON.stringify(require.resolve('../browser-profile.cjs'))});
      launchProfile(chromium, ${JSON.stringify({ ...options, root })}).then(async session => {
        await session.close(); process.exitCode = 2;
      }).catch(error => { process.exitCode = error.code === 'PROFILE_BUSY' ? 0 : 3; });
    `;
    await promisify(execFile)(process.execPath, ['-e', script], { timeout: 10000 });
    assert.equal(
      current.context.browser().isConnected(),
      true,
      'the first worker retains ownership'
    );
  } finally {
    await current.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fast evidence finish does not wait for a stalled capture or start video encoding', async () => {
  const media = require('../safe-media.cjs');
  let release;
  const page = {
    evaluate: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  };
  await media.start();
  const capture = media.screenshot(page);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(media.diagnostics(page).busy, true);
  const started = Date.now();
  assert.deepEqual(await media.finish({ fast: true }), []);
  assert.ok(Date.now() - started < 200);
  release(true);
  assert.equal(await capture, null, 'a stopped recorder does not write a late frame');
});

test(
  'native homepage challenge exits before actionable checks, solver or human callback',
  { timeout: 30000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'homepage-'));
    const current = await fixture(root);
    const human = require('../upstream/human-verification');
    const manual = require('../human-verification.cjs');
    const originalVisible = human.isBlockingHumanVerificationVisible;
    const originalSolver = human.clearHumanVerification;
    const originalActionable = manual.hasActionableHumanVerification;
    let solverCalls = 0,
      actionableCalls = 0;
    human.isBlockingHumanVerificationVisible = async () => true;
    human.clearHumanVerification = async () => {
      solverCalls++;
      return { cleared: false };
    };
    manual.hasActionableHumanVerification = async () => {
      actionableCalls++;
      return false;
    };
    try {
      const page = await current.context.newPage();
      await assert.rejects(
        auth.bootstrapChatGptSession(page, raw, {
          nativeSession: true,
          cookieVerified: true,
          onHumanVerification: current.manual,
          deadlineAt: performance.now() + 10000
        }),
        (error) =>
          error.code === 'CHALLENGE_BLOCKED' &&
          error.bootstrapDiagnostics.challengeDetected === true
      );
      assert.equal(solverCalls, 0);
      assert.equal(actionableCalls, 0);
      assert.equal(current.counts().manualCalls, 0);
    } finally {
      human.isBlockingHumanVerificationVisible = originalVisible;
      human.clearHumanVerification = originalSolver;
      manual.hasActionableHumanVerification = originalActionable;
      await current.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test('persistent proxy keeps five request retries but stops an established exit mismatch immediately', async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'proxy-evidence-'));
  let calls = 0;
  let connected = false;
  let probe = async () => '192.0.2.10';
  const native = {
    async launchPersistentContext() {
      connected = true;
      const browser = {
        isConnected: () => connected,
        newBrowserCDPSession: async () => ({
          send: async () => ({ arguments: [] }),
          detach: async () => {}
        })
      };
      return {
        browser: () => browser,
        close: async () => {
          connected = false;
        },
        request: {
          get: async () => {
            calls++;
            const ip = await probe();
            return { ok: () => true, text: async () => ip, dispose: async () => {} };
          }
        }
      };
    }
  };
  try {
    const first = await launchProfile(native, { ...options, root });
    await first.close();
    calls = 0;
    probe = async () => {
      if (calls === 1) throw new Error('synthetic connection reset');
      return '192.0.2.11';
    };
    await assert.rejects(launchProfile(native, { ...options, root }), {
      code: 'PROFILE_EXIT_CHANGED'
    });
    assert.equal(
      calls,
      2,
      'a successful second probe with changed exit stops before attempt three'
    );
    assert.equal(connected, false);
    calls = 0;
    probe = async () => {
      throw new Error('synthetic connection reset');
    };
    await assert.rejects(launchProfile(native, { ...options, root }), {
      code: 'PROXY_CONNECTION_FAILED'
    });
    assert.equal(calls, 5, 'connection errors still receive all five attempts');
    assert.equal(connected, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
