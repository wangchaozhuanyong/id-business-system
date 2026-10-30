'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('../upstream/node_modules/playwright');
const { binding, launchProfile, pruneRetiredProfiles } = require('../browser-profile.cjs');
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
    manualCalls = 0,
    launches = 0,
    probes = 0;
  const native = {
    async launchPersistentContext(directory, config) {
      launches++;
      const context = await chromium.launchPersistentContext(directory, config);
      // All test network traffic is fulfilled locally; DNS is blocked at launch.
      context.request.get = async (url) => {
        assert.equal(url, 'http://api.ipify.org/?format=text');
        probes++;
        return {
          ok: () => true,
          text: async () => (typeof exit === 'function' ? exit(probes) : exit),
          dispose: async () => {}
        };
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
                  status: sessionStatus,
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
    setSessionStatus(value) {
      sessionStatus = value;
    },
    counts: () => ({ officialRequests, manualCalls, launches, probes }),
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
  'exclusive profile rejects concurrent use across an egress partition change',
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
      current = await fixture(root, { exit: '192.0.2.11' });
      await assert.rejects(fixture(root), { code: 'PROFILE_BUSY' });
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
      current = await fixture(root);
      await current.close();
      current = await fixture(root, { sessionStatus: 403, exit: '192.0.2.11' });
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

for (const mode of ['cleared', 'disabled', 'no_actionable', 'still_blocked', 'timeout']) {
  test(
    `unpaid persistent session attempts original-page automatic handling: ${mode}`,
    { timeout: 30000 },
    async () => {
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, 'automatic-'));
      const validation = require('../unpaid-validation.cjs');
      const human = require('../upstream/human-verification');
      const manual = require('../human-verification.cjs');
      const originalClear = human.clearHumanVerification;
      const originalActionable = manual.hasActionableHumanVerification;
      const originalEnabled = process.env.HCAPTCHA_SOLVER_ENABLED;
      let current,
        solverCalls = 0;
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
        process.env.HCAPTCHA_SOLVER_ENABLED = mode === 'disabled' ? '0' : '1';
        manual.hasActionableHumanVerification = async () => mode !== 'no_actionable';
        human.clearHumanVerification = async (page) => {
          solverCalls++;
          assert.equal(page.context(), current.context);
          assert.equal(page.url(), 'https://chatgpt.com/api/auth/session');
          if (mode === 'timeout') return new Promise(() => {});
          if (mode === 'cleared') current.setSessionStatus(200);
          return { cleared: true };
        };
        const pending = auth.installChatGptSession(current.context, raw, {
          nativeSession: true,
          preserveStoredSession: true,
          deadlineAt: performance.now() + (mode === 'timeout' ? 2000 : 5000),
          onHumanVerification: validation.automaticVerification
        });
        if (mode === 'cleared') {
          const result = await pending;
          assert.equal(result.cookieVerified, true);
          assert.equal(result.initialSessionProbe.httpStatus, 403);
          assert.equal(result.initialSessionProbe.automaticCompleted, true);
          assert.equal(result.initialSessionProbe.automaticResult, 'cleared');
        } else {
          await assert.rejects(pending, (error) => {
            assert.equal(error.code, 'CHALLENGE_BLOCKED');
            assert.equal(error.bootstrapDiagnostics.initialSessionProbe.httpStatus, 403);
            assert.equal(
              error.bootstrapDiagnostics.initialSessionProbe.automaticResult,
              {
                disabled: 'solver_disabled',
                no_actionable: 'not_actionable',
                still_blocked: 'failed',
                timeout: 'timeout'
              }[mode]
            );
            return true;
          });
        }
        assert.equal(solverCalls, ['disabled', 'no_actionable'].includes(mode) ? 0 : 1);
        assert.equal(
          current.counts().officialRequests,
          ['cleared', 'still_blocked'].includes(mode) ? 2 : 1
        );
        assert.equal(current.counts().manualCalls, 0);
        assert.equal(current.context.pages().length, 1);
      } finally {
        human.clearHumanVerification = originalClear;
        manual.hasActionableHumanVerification = originalActionable;
        if (originalEnabled === undefined) delete process.env.HCAPTCHA_SOLVER_ENABLED;
        else process.env.HCAPTCHA_SOLVER_ENABLED = originalEnabled;
        await current?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );
}

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

for (const [region, locale, timezoneId] of [
  ['PH', 'en-PH', 'Asia/Manila'],
  ['CL', 'en-CL', 'America/Santiago']
])
  test(
    `${region}: native query and recharge launches reuse the profile with the same real language and timezone`,
    { timeout: 30000 },
    async () => {
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, 'region-'));
      const original = chromium.launchPersistentContext;
      const runtime = require('../upstream/browser-runtime');
      let current, key;
      chromium.launchPersistentContext = async function (directory, config) {
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
        await context.route('**/*', (route) =>
          route.fulfill(
            new URL(route.request().url()).pathname === '/api/auth/session'
              ? {
                  contentType: 'application/json',
                  body: JSON.stringify({ user: { id: 'synthetic-user-profile' } })
                }
              : { contentType: 'text/html', body: '<html>synthetic region fixture</html>' }
          )
        );
        return context;
      };
      try {
        const env = {
          ONLINE_RECHARGE_PROFILE_ROOT: root,
          CHATGPT_SESSION_JSON: raw,
          PROXY: options.proxyBinding,
          PAYMENT_REGION_OVERRIDE: region,
          CDP_PORT: '0'
        };
        for (const contextOptions of [undefined, { locale: 'en-US', timezoneId: 'UTC' }]) {
          current = await runtime.connectTaskBrowser({ env, contextOptions });
          if (key) assert.equal(current.profileKey, key);
          key = current.profileKey;
          if (contextOptions === undefined)
            await current.context.addCookies([
              {
                name: '__Secure-next-auth.session-token',
                value: 'synthetic-region-reuse-only',
                url: 'https://chatgpt.com',
                secure: true,
                httpOnly: true,
                expires: Date.now() / 1000 + 3600
              }
            ]);
          else
            assert.equal(
              (await current.context.cookies('https://chatgpt.com')).find(
                (c) => c.name === '__Secure-next-auth.session-token'
              )?.value,
              'synthetic-region-reuse-only'
            );
          const events = [];
          const observer = require('../subscription-diagnostics.cjs').observeSessionRequests(
            current.context,
            (event) => events.push(event)
          );
          const page = await current.context.newPage();
          await page.goto('https://chatgpt.com/api/auth/session');
          await page.goto('https://chatgpt.com/');
          await page.evaluate(async () => (await fetch('/api/auth/session')).json());
          assert.deepEqual(
            await page.evaluate(() => ({
              language: navigator.language,
              timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone
            })),
            { language: locale, timezoneId }
          );
          const headers = events.filter((e) => e.event === 'request_headers');
          assert.equal(headers.length, 2);
          assert.ok(headers.every((e) => e.complete && e.sessionCookieSent));
          assert.equal(events.find((e) => e.event === 'request').resourceType, 'document');
          assert.ok(events.some((e) => e.event === 'request' && e.resourceType === 'fetch'));
          assert.ok(!JSON.stringify(events).includes('synthetic-region-reuse-only'));
          observer.dispose();
          await runtime.closeTaskBrowser(current, current.browser);
          assert.equal(current.browser.isConnected(), false);
        }
      } finally {
        if (current) await current.close();
        chromium.launchPersistentContext = original;
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
  let current = await fixture(root);
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
    await current.close();
    current = await fixture(root, { exit: '192.0.2.11' });
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

test('persistent proxy rechecks a fresh partition and shares five request attempts across restart', async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'proxy-evidence-'));
  let calls = 0;
  let connected = false;
  let launches = 0;
  let onLaunch = async () => {};
  let probe = async () => '192.0.2.10';
  const native = {
    async launchPersistentContext() {
      launches++;
      await onLaunch();
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
    const fresh = await launchProfile(native, { ...options, root });
    assert.equal(calls, 3, 'one failed probe, a new exit, and a fresh-browser confirmation');
    await fresh.close();
    assert.equal(connected, false);
    calls = 0;
    probe = async () => (calls === 1 ? '192.0.2.12' : '192.0.2.13');
    const beforeLaunches = launches;
    const rotating = await launchProfile(native, { ...options, root });
    assert.equal(calls, 2, 'a second exit observation does not need another probe');
    assert.equal(launches - beforeLaunches, 2, 'only one fresh partition is started');
    const directory = path.join(root, binding(raw, options.proxyBinding));
    const selectionFile = path.join(directory, '.active-profile.json');
    const rotated = JSON.parse(await fs.readFile(selectionFile, 'utf8'));
    assert.equal(
      JSON.parse(await fs.readFile(path.join(directory, rotated.profile, '.exit-binding.json')))
        .exitHash,
      require('node:crypto').createHash('sha256').update('192.0.2.13').digest('hex'),
      'the receipt is the fresh partition observation, not proof of authentication'
    );
    await rotating.close();
    assert.equal(connected, false);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => /^Exit-[a-f0-9]{32}$/.test(name)),
      [rotated.profile],
      'repeated rotations retain only the selected generation after closing'
    );
    calls = 0;
    probe = async () => {
      if (calls === 1) return '192.0.2.14';
      throw new Error('synthetic connection reset');
    };
    await assert.rejects(launchProfile(native, { ...options, root }), {
      code: 'PROXY_CONNECTION_FAILED'
    });
    assert.equal(calls, 5, 'the fresh-browser probe cannot reset the five-attempt counter');
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
    const selected = JSON.parse(await fs.readFile(selectionFile, 'utf8'));
    calls = launches = 0;
    onLaunch = async () => {
      await fs.writeFile(
        path.join(directory, selected.profile, '.exit-binding.json'),
        JSON.stringify({
          version: 1,
          exitHash: require('node:crypto').createHash('sha256').update('192.0.2.15').digest('hex')
        })
      );
    };
    probe = async () => '192.0.2.15';
    const latest = await launchProfile(native, { ...options, root });
    assert.equal(
      launches,
      1,
      'receipt is re-read after the native lock instead of using a stale hash'
    );
    await latest.close();
    calls = launches = 0;
    onLaunch = async () =>
      fs.writeFile(
        selectionFile,
        JSON.stringify({ version: 1, profile: `Exit-${'f'.repeat(32)}` })
      );
    await assert.rejects(launchProfile(native, { ...options, root }), { code: 'PROFILE_BUSY' });
    assert.equal(calls, 0, 'a stale selection cannot reach a probe or official request');
    assert.equal(connected, false);
    await fs.writeFile(selectionFile, JSON.stringify(selected));
    calls = launches = 0;
    const controller = new AbortController();
    onLaunch = async () => {
      if (launches === 2) controller.abort();
    };
    probe = async () => '192.0.2.16';
    await assert.rejects(launchProfile(native, { ...options, root, signal: controller.signal }), {
      name: 'AbortError'
    });
    assert.equal(calls, 1, 'cancelled fresh browser does not start another probe');
    assert.equal(connected, false);
    calls = launches = 0;
    onLaunch = async () => {};
    probe = async () => {
      if (calls < 5) throw new Error('synthetic connection reset');
      return '192.0.2.17';
    };
    await assert.rejects(launchProfile(native, { ...options, root }), {
      code: 'PROXY_CONNECTION_FAILED'
    });
    assert.equal(calls, 5);
    assert.equal(launches, 1, 'cannot restart without a remaining confirmation attempt');
    assert.equal(connected, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  'egress change isolates state, retires old data after closing, and reuses the selected partition',
  { timeout: 60000 },
  async () => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'egress-partition-'));
    const directory = path.join(root, binding(raw, options.proxyBinding));
    let current;
    try {
      current = await fixture(root);
      await current.context.addCookies([
        {
          name: 'cf_clearance',
          value: 'synthetic-old-clearance',
          url: 'https://chatgpt.com',
          httpOnly: true,
          secure: true,
          expires: Date.now() / 1000 + 3600
        },
        {
          name: '__Secure-next-auth.session-token',
          value: 'synthetic-old-session',
          url: 'https://chatgpt.com',
          httpOnly: true,
          secure: true,
          expires: Date.now() / 1000 + 3600
        }
      ]);
      let page = await current.context.newPage();
      await page.goto('https://chatgpt.com/');
      await page.evaluate(() => localStorage.setItem('old-partition', 'synthetic-private-state'));
      await current.close();
      current = await fixture(root, {
        exit: (probe) => (probe === 1 ? '192.0.2.11' : '192.0.2.12')
      });
      assert.equal(current.counts().launches, 2);
      assert.equal(current.counts().probes, 2);
      assert.equal(current.counts().officialRequests, 0, 'IP probes never imply official login');
      assert.deepEqual(await current.context.cookies('https://chatgpt.com'), []);
      page = await current.context.newPage();
      await page.goto('https://chatgpt.com/');
      assert.equal(await page.evaluate(() => localStorage.getItem('old-partition')), null);
      const installed = await auth.installChatGptSession(current.context, raw, {
        nativeSession: true,
        preserveStoredSession: true,
        onHumanVerification: current.manual
      });
      assert.equal(installed.cookieVerified, true);
      assert.equal(installed.initialSessionProbe.matchesTargetAccount, true);
      assert.equal(
        current.counts().officialRequests,
        1,
        'the fresh partition still verifies the real Session endpoint'
      );
      assert.equal(current.counts().manualCalls, 0);
      await page.evaluate(() => localStorage.setItem('new-partition', 'synthetic-new-state'));
      const selected = JSON.parse(
        await fs.readFile(path.join(directory, '.active-profile.json'), 'utf8')
      );
      assert.match(selected.profile, /^Exit-[a-f0-9]{32}$/);
      const prefs = JSON.parse(
        await fs.readFile(path.join(directory, selected.profile, 'Preferences'), 'utf8')
      );
      assert.equal(prefs.autofill.credit_card_enabled, false);
      assert.equal(
        (await fs.stat(path.join(directory, '.active-profile.json'))).mode & 0o777,
        0o600
      );
      assert.ok(
        (await fs.stat(path.join(directory, 'Default'))).isDirectory(),
        'do not remove generations while the owned browser is still open'
      );
      await current.close();
      await assert.rejects(fs.stat(path.join(directory, 'Default')), { code: 'ENOENT' });
      assert.ok((await fs.stat(path.join(directory, selected.profile))).isDirectory());
      current = await fixture(root, { exit: '192.0.2.12' });
      assert.equal(current.counts().launches, 1, 'reuse the latest observed partition');
      page = await current.context.newPage();
      await page.goto('https://chatgpt.com/');
      assert.equal(
        await page.evaluate(() => localStorage.getItem('new-partition')),
        'synthetic-new-state'
      );
      assert.deepEqual(
        JSON.parse(await fs.readFile(path.join(directory, '.active-profile.json'), 'utf8')),
        selected
      );
      await current.close();
      current = null;
      await assert.rejects(fs.stat(path.join(directory, 'Default')), { code: 'ENOENT' });
    } finally {
      await current?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

test('retirement respects native locks, selected identity, symlinks and unrelated files', async () => {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'retirement-'));
  const selected = `Exit-${'a'.repeat(32)}`;
  const retired = `Exit-${'b'.repeat(32)}`;
  const linked = `Exit-${'c'.repeat(32)}`;
  try {
    for (const name of [selected, retired, 'Default', 'unrelated'])
      await fs.mkdir(path.join(root, name));
    await fs.writeFile(
      path.join(root, '.active-profile.json'),
      JSON.stringify({ version: 1, profile: selected })
    );
    await fs.writeFile(path.join(root, selected, 'synthetic-state'), 'keep-selected-state');
    await fs.writeFile(path.join(root, 'unrelated', 'keep'), 'unrelated-data');
    await fs.symlink(path.join(root, 'unrelated'), path.join(root, linked));
    await fs.symlink('synthetic-live-owner', path.join(root, 'SingletonLock'));
    assert.deepEqual(await pruneRetiredProfiles(root), { removed: 0, deferred: true });
    assert.ok((await fs.stat(path.join(root, retired))).isDirectory());
    await fs.unlink(path.join(root, 'SingletonLock'));
    assert.deepEqual(await pruneRetiredProfiles(root), { removed: 2, deferred: false });
    assert.equal(
      await fs.readFile(path.join(root, selected, 'synthetic-state'), 'utf8'),
      'keep-selected-state'
    );
    assert.equal(await fs.readFile(path.join(root, 'unrelated', 'keep'), 'utf8'), 'unrelated-data');
    assert.ok((await fs.lstat(path.join(root, linked))).isSymbolicLink());
    assert.deepEqual(await pruneRetiredProfiles(root), { removed: 0, deferred: false });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('invalid or missing selected generation refuses retirement without deleting other data', async () => {
  await fs.mkdir(base, { recursive: true });
  for (const profile of ['../outside', `Exit-${'f'.repeat(32)}`]) {
    const root = await fs.mkdtemp(path.join(base, 'retirement-invalid-'));
    try {
      await fs.mkdir(path.join(root, 'Default'));
      await fs.writeFile(
        path.join(root, '.active-profile.json'),
        JSON.stringify({ version: 1, profile })
      );
      await assert.rejects(pruneRetiredProfiles(root));
      assert.ok((await fs.stat(path.join(root, 'Default'))).isDirectory());
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

for (const mode of [
  'session_invalid',
  'account_mismatch',
  'session_challenge',
  'subscription_challenge'
])
  test(
    `a rotating fresh partition retains official verification: ${mode}`,
    { timeout: 30000 },
    async () => {
      await fs.mkdir(base, { recursive: true });
      const root = await fs.mkdtemp(path.join(base, 'fresh-verification-'));
      const previousRoot = process.env.ONLINE_RECHARGE_PROFILE_ROOT;
      let current;
      try {
        current = await fixture(root);
        await current.close();
        current = await fixture(root, {
          exit: (probe) => (probe === 1 ? '192.0.2.21' : '192.0.2.22'),
          sessionStatus:
            mode === 'session_invalid' ? 401 : mode === 'session_challenge' ? 403 : 200,
          account: mode === 'account_mismatch' ? 'another-account' : 'synthetic-account-profile'
        });
        assert.equal(current.counts().launches, 2);
        assert.equal(current.counts().probes, 2);
        assert.deepEqual(await current.context.cookies('https://chatgpt.com'), []);
        const installed = auth.installChatGptSession(current.context, raw, {
          nativeSession: true,
          preserveStoredSession: true,
          onHumanVerification: current.manual
        });
        if (mode === 'subscription_challenge') {
          assert.equal((await installed).cookieVerified, true);
          process.env.ONLINE_RECHARGE_PROFILE_ROOT = root;
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
        } else {
          await assert.rejects(installed, {
            code: {
              session_invalid: 'SESSION_INVALID',
              account_mismatch: 'ACCOUNT_MISMATCH',
              session_challenge: 'CHALLENGE_BLOCKED'
            }[mode]
          });
        }
        assert.equal(current.counts().officialRequests, mode === 'subscription_challenge' ? 2 : 1);
        assert.equal(current.counts().manualCalls, 0);
        const browser = current.context.browser();
        await current.close();
        assert.equal(browser.isConnected(), false);
      } finally {
        if (previousRoot === undefined) delete process.env.ONLINE_RECHARGE_PROFILE_ROOT;
        else process.env.ONLINE_RECHARGE_PROFILE_ROOT = previousRoot;
        await current?.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  );

test('invalid binding metadata fails before browser launch or network and is not overwritten', async () => {
  await fs.mkdir(base, { recursive: true });
  for (const [file, value] of [
    ['.exit-binding.json', {}],
    ['.exit-binding.json', { version: 1, exitHash: 'not-a-hash' }],
    ['.active-profile.json', { version: 1, profile: '../another-profile' }],
    ['.active-profile.json', { version: 1, profile: `Exit-${'a'.repeat(32)}` }]
  ]) {
    const root = await fs.mkdtemp(path.join(base, 'invalid-binding-'));
    try {
      const directory = path.join(root, binding(raw, options.proxyBinding));
      await fs.mkdir(directory);
      const serialized = JSON.stringify(value);
      await fs.writeFile(path.join(directory, file), serialized);
      await assert.rejects(
        launchProfile(
          { launchPersistentContext: () => assert.fail('must not launch') },
          { ...options, root }
        ),
        {
          code: 'PROFILE_BINDING_INVALID'
        }
      );
      assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), serialized);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
