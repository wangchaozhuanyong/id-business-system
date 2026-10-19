'use strict';
/* global document */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const authPage = require('../upstream/auth-page-detect');
const human = require('../upstream/human-verification');
const source = fs.readFileSync(path.join(__dirname, '../upstream/session-auth.js'), 'utf8');

const origin = 'https://chatgpt.com';
const guest =
  '<!doctype html><main><button>Log in</button><button>Sign up for free</button></main>';
const ready =
  '<!doctype html><main><button>New chat</button><textarea id="prompt-textarea"></textarea></main>';
const challenge =
  '<!doctype html><main><h1>Verify you are human</h1><p>Cloudflare security check</p><input type="checkbox"></main>';
const session = {
  accessToken: 'synthetic-session-transition-access-token',
  user: { id: 'synthetic-session-transition-user', email: 'transition@example.invalid' },
  sessionToken: 'synthetic-session-transition-cookie'
};
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']
  });
});
test.after(async () => browser?.close());

async function fixture(t, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.addCookies([
    {
      name: '__Secure-next-auth.session-token',
      value: session.sessionToken,
      domain: '.chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true
    }
  ]);
  const state = {
    homeLoads: 0,
    reloads: 0,
    verificationCalls: 0,
    writes: 0,
    unknownRequests: 0,
    uiReadsAfterCancel: 0,
    lateReloadReturns: 0,
    cookiePresent: []
  };
  let activeSignal, signalReloadStarted, releaseReload, signalLateResponse, signalLateReload;
  const reloadStarted = new Promise((resolve) => {
    signalReloadStarted = resolve;
  });
  const reloadGate = new Promise((resolve) => {
    releaseReload = resolve;
  });
  const lateResponse = new Promise((resolve) => {
    signalLateResponse = resolve;
  });
  const lateReload = new Promise((resolve) => {
    signalLateReload = resolve;
  });
  t.after(releaseReload);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      state.writes++;
      return route.abort();
    }
    if (url.origin === origin && url.pathname === '/api/auth/session')
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(session) });
    if (url.origin === origin && url.pathname === '/') {
      state.homeLoads++;
      state.cookiePresent.push(
        Boolean(request.headers().cookie?.includes('__Secure-next-auth.session-token='))
      );
      if (options.destination)
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><script>location.replace(${JSON.stringify(options.destination)})</script>`
        });
      if (state.homeLoads > 1 && options.holdReload) {
        signalReloadStarted();
        await reloadGate;
      }
      const body =
        options.challengeInitially && state.homeLoads === 1
          ? challenge
          : state.homeLoads > 1
            ? options.challengeAfterReload
              ? challenge
              : options.stillGuest
                ? guest
                : options.emptyAfterReload
                  ? '<!doctype html><main></main>'
                  : ready
            : guest;
      try {
        return await route.fulfill({ contentType: 'text/html', body });
      } catch (error) {
        if (!options.holdReload || !activeSignal?.aborted) throw error;
      } finally {
        if (state.homeLoads > 1 && options.holdReload) signalLateResponse();
      }
    }
    if (options.destination && url.href === options.destination)
      return route.fulfill({ contentType: 'text/html', body: guest });
    state.unknownRequests++;
    return route.abort();
  });
  const page = await context.newPage();
  const reload = page.reload.bind(page);
  page.reload = async (reloadOptions) => {
    state.reloads++;
    assert.equal(page.url(), `${origin}/`);
    assert.ok(reloadOptions.timeout > 0 && reloadOptions.timeout <= 90000);
    try {
      return await reload(reloadOptions);
    } catch (error) {
      if (!options.lateReloadResolve) throw error;
      await reloadGate;
      state.lateReloadReturns++;
    } finally {
      if (options.lateReloadResolve) signalLateReload();
    }
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    console: { log() {}, warn() {} },
    process: { env: {} },
    Buffer,
    URL,
    Date,
    performance,
    require(name) {
      if (name === './auth-page-detect')
        return {
          ...authPage,
          waitForLoggedInChatUi: (...args) => {
            if (activeSignal?.aborted) state.uiReadsAfterCancel++;
            return authPage.waitForLoggedInChatUi(...args);
          },
          hasLoggedInSessionApi: (...args) => {
            if (activeSignal?.aborted) state.uiReadsAfterCancel++;
            return authPage.hasLoggedInSessionApi(...args);
          }
        };
      if (name === './human-verification')
        return {
          isBlockingHumanVerificationVisible: human.isBlockingHumanVerificationVisible,
          clearHumanVerification: async (...args) => {
            state.verificationCalls++;
            if (options.verify) return options.verify(...args);
            return options.cleared
              ? { cleared: true }
              : { cleared: false, code: 'SESSION_INVALID', sessionRequired: true };
          }
        };
      if (name === './verification-runtime') return require('../upstream/verification-runtime');
      throw Error('Unexpected synthetic dependency');
    }
  });
  const run = (overrides = {}) => {
    activeSignal = overrides.signal;
    return module.exports.bootstrapChatGptSession(page, JSON.stringify(session), {
      sessionData: session,
      cookieVerified: false,
      deadlineAt: performance.now() + 60000,
      ...overrides
    });
  };
  return { page, context, state, run, reloadStarted, releaseReload, lateResponse, lateReload };
}

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Synthetic operation exceeded its bound')),
          timeoutMs
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function noBusinessActions(f) {
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.unknownRequests, 0);
  assert.equal(f.page.context(), f.context);
  assert.ok(f.state.cookiePresent.every(Boolean));
}

test('a guest homepage becomes authenticated after exactly one same-page reload', async (t) => {
  const f = await fixture(t, { cleared: true });
  const result = await f.run();
  assert.equal(result.email, session.user.email);
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.homeLoads, 2);
  assert.equal(f.state.verificationCalls, 1);
  assert.equal(await authPage.hasLoggedInChatUi(f.page), true);
  noBusinessActions(f);
});

test('the frozen upstream reload transition reaches login in the same synthetic context', async (t) => {
  const f = await fixture(t);
  await f.page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(await authPage.hasVisibleLoginChrome(f.page), true);
  // Fixed ba6cf963 session-auth.js:711–714: retain the original page and
  // context, reload once when its ordinary guest controls remain, then read UI.
  await f.page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  assert.equal(await authPage.hasVisibleLoginChrome(f.page), false);
  assert.equal(await authPage.waitForLoggedInChatUi(f.page, 2000), true);
  assert.equal(f.state.reloads, 1);
  noBusinessActions(f);
});

test('the existing SESSION_INVALID guest transition can recover without running verification twice', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.email, session.user.email);
  assert.equal(f.state.verificationCalls, 1);
  assert.equal(f.state.reloads, 1);
  noBusinessActions(f);
});

test('a homepage still showing guest controls after reload stops with login diagnostics', async (t) => {
  const f = await fixture(t, { stillGuest: true });
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 'SESSION_NOT_CONFIRMED');
    assert.equal(error.bootstrapDiagnostics.visibleLogin, true);
    assert.equal(error.bootstrapDiagnostics.loggedInUi, false);
    return true;
  });
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.homeLoads, 2);
  assert.equal(f.state.verificationCalls, 1);
  noBusinessActions(f);
});

test('a verified Cookie cannot replace logged-in UI after the single homepage refresh', async (t) => {
  const f = await fixture(t, { cleared: true, emptyAfterReload: true });
  await assert.rejects(f.run({ cookieVerified: true }), (error) => {
    assert.equal(error.code, 'SESSION_NOT_CONFIRMED');
    assert.equal(error.bootstrapDiagnostics.authApiVerified, true);
    assert.equal(error.bootstrapDiagnostics.loggedInUi, false);
    return true;
  });
  assert.equal(f.state.reloads, 1);
  noBusinessActions(f);
});

test('a verified Cookie and real logged-in UI recover through one homepage refresh', async (t) => {
  const f = await fixture(t, { cleared: true });
  const result = await f.run({ cookieVerified: true });
  assert.equal(result.email, session.user.email);
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.verificationCalls, 1);
  noBusinessActions(f);
});

test('cancelling a pending reload closes only its task Page and ignores late completion', async (t) => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('Synthetic reload lease lost'), { code: 'LEASE_LOST' });
  const f = await fixture(t, { holdReload: true, lateReloadResolve: true });
  let outcome;
  const done = f.run({ signal: controller.signal }).then(
    (result) => {
      outcome = { result };
      return null;
    },
    (error) => {
      outcome = { error };
      return error;
    }
  );
  await within(f.reloadStarted, 20000);
  const closed = f.page.waitForEvent('close', { timeout: 5000 });
  controller.abort(reason);
  assert.equal(await within(done, 1500), reason);
  await closed;
  assert.equal(f.page.isClosed(), true);
  assert.equal(f.context.pages().length, 0);
  f.releaseReload();
  await within(Promise.all([f.lateReload, f.lateResponse]), 5000);
  assert.equal(outcome.error, reason);
  assert.equal(outcome.result, undefined);
  assert.equal(f.state.lateReloadReturns, 1);
  assert.equal(f.state.uiReadsAfterCancel, 0);
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.verificationCalls, 1);
  noBusinessActions(f);
});

test('expired and cancelled bootstrap budgets never refresh the guest homepage', async (t) => {
  await t.test('deadline already expired', async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run({ deadlineAt: performance.now() - 1 }), { code: 'NETWORK_TIMEOUT' });
    assert.equal(f.state.reloads, 0);
    assert.equal(f.state.homeLoads, 0);
    noBusinessActions(f);
  });
  await t.test('lease lost after the one verification result', async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, {
      verify: async () => {
        controller.abort(Object.assign(new Error('Synthetic lease lost'), { code: 'LEASE_LOST' }));
        return { cleared: false, code: 'SESSION_INVALID', sessionRequired: true };
      }
    });
    await assert.rejects(f.run({ signal: controller.signal }), { code: 'LEASE_LOST' });
    assert.equal(f.state.reloads, 0);
    assert.equal(f.state.verificationCalls, 1);
    noBusinessActions(f);
  });
});

test('an actual challenge is not reloaded or sent into another verification run', async (t) => {
  const f = await fixture(t, { challengeInitially: true });
  await assert.rejects(f.run({ manualVerification: true }), (error) => {
    assert.equal(error.code, 'HUMAN_VERIFICATION_REQUIRED');
    assert.equal(error.bootstrapDiagnostics.challengeDetected, true);
    return true;
  });
  assert.equal(f.state.reloads, 0);
  assert.equal(f.state.verificationCalls, 0);
  noBusinessActions(f);
});

test('a completed verification may recover the remaining ordinary guest UI once', async (t) => {
  const f = await fixture(t, {
    challengeInitially: true,
    verify: async (page) => {
      await page.evaluate((body) => {
        document.body.innerHTML = body;
      }, guest);
      return { cleared: true };
    }
  });
  const result = await f.run();
  assert.equal(result.email, session.user.email);
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.verificationCalls, 1);
  noBusinessActions(f);
});

test('a challenge after the single guest reload stops instead of restarting verification', async (t) => {
  const f = await fixture(t, { challengeAfterReload: true });
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.code, 'HUMAN_VERIFICATION_REQUIRED');
    assert.equal(error.bootstrapDiagnostics.challengeDetected, true);
    return true;
  });
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.verificationCalls, 1);
  noBusinessActions(f);
});

test('checkout and third-party guest pages are never refreshed as the official homepage', async (t) => {
  for (const destination of [`${origin}/checkout/synthetic`, 'https://third-party.invalid/']) {
    await t.test(
      destination.includes('/checkout/') ? 'checkout page' : 'third-party page',
      async (t) => {
        const f = await fixture(t, { destination });
        await assert.rejects(f.run(), { code: 'SESSION_NOT_CONFIRMED' });
        assert.equal(f.state.reloads, 0);
        noBusinessActions(f);
      }
    );
  }
});
