'use strict';
/* global window, document */
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const recovery = require('../checkout-recovery.cjs');

const origin = 'https://chatgpt.com';
const entity = 'openai_fixture';
const errorHtml =
  '<html><body><h2>Content failed to load</h2><button onclick="window.retried=true">Try again</button></body></html>';
const formHtml =
  '<html><body><input autocomplete="cc-number"><input autocomplete="cc-exp"><input autocomplete="cc-csc"></body></html>';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--site-per-process',
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
});
test.after(async () => browser?.close());

async function fixture(t, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const checkoutId = options.checkoutId || 'cs_test_reloadOriginal';
  const url = `${origin}/checkout/${entity}/${checkoutId}`;
  const accepted = [];
  let loads = 0;
  await context.route('**/*', async (route) => {
    const request = route.request();
    accepted.push({ method: request.method(), url: request.url() });
    if (request.isNavigationRequest() && request.url() === url) {
      loads += 1;
      if (loads > 1) await options.onReloadRequested?.();
      if (loads > 1 && options.delay) await pause(options.delay);
      if (loads > 1) options.onReload?.();
      if (loads > 1 && options.redirect)
        return route.fulfill({ status: 302, headers: { location: options.redirect } });
      return route
        .fulfill({
          contentType: 'text/html',
          body:
            loads === 1
              ? options.errorHtml || errorHtml
              : options.formHtml ||
                (options.frameUrl
                  ? formHtml.replace(
                      '</body>',
                      `<script>addEventListener('message',event=>{if(event.data==='fixture-done')window.fixtureDone=true})</script><iframe src="${options.frameUrl}"></iframe></body>`
                    )
                  : formHtml)
        })
        .catch(() => {});
    }
    if (options.frameUrl && request.url() === options.frameUrl)
      return route.fulfill({ contentType: 'text/html', body: options.frameHtml || formHtml });
    if (options.secondFrameUrl && request.url() === options.secondFrameUrl)
      return route.fulfill({ contentType: 'text/html', body: options.secondFrameHtml || formHtml });
    if (options.initRedirect && request.method() === 'POST' && /\/init$/.test(request.url()))
      return route.fulfill({
        status: 307,
        headers: {
          location: request.url().replace(/\/init$/, '/confirm'),
          'access-control-allow-origin': '*'
        }
      });
    if (options.writeRedirect && request.url() === origin + '/fixture/redirect-write')
      return route.fulfill({
        status: 307,
        headers: {
          location: origin + '/backend-api/payments/checkout',
          'access-control-allow-origin': '*'
        }
      });
    return route
      .fulfill({
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': '*'
        },
        body: '{}'
      })
      .catch(() => {});
  });
  const page = await context.newPage();
  await page.goto(url);
  if (options.childCommand) {
    const nativeSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await nativeSession(target);
      if (target === page) {
        const nativeSend = session.send.bind(session);
        session.send = async (method, params) => {
          if (method === 'Target.sendMessageToTarget') {
            let command = JSON.parse(params.message);
            while (command.method === 'Target.sendMessageToTarget')
              command = JSON.parse(command.params.message);
            await options.childCommand(command, { accepted, page, context });
          }
          return nativeSend(method, params);
        };
      }
      return session;
    };
  }
  if (options.source !== false)
    recovery.rememberOfficialCheckout(page, {
      kind: 'official_checkout_response',
      checkoutId,
      processorEntity: entity
    });
  return { page, context, checkoutId, url, accepted, loads: () => loads };
}
function scope(extra = {}) {
  return { deadlineAt: performance.now() + 5000, isSubmitted: () => false, ...extra };
}
function writes(checkoutId) {
  return [
    { url: origin + '/backend-api/payments/checkout', body: 'plan_name=chatgptpro' },
    {
      url: origin + '/backend-api/payments/checkout/confirm',
      body: 'checkout_session_id=' + checkoutId
    },
    { url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/confirm`, body: 'confirm=true' },
    { url: `https://api.stripe.com/v1/payment_methods`, body: 'type=card' },
    {
      url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/update`,
      body: 'billing=changed'
    },
    { url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/init`, body: 'billing=changed' },
    { url: 'https://api.stripe.com/v1/payment_pages/cs_test_wrongOriginal/init', body: '' },
    { url: `https://untrusted.invalid/v1/payment_pages/${checkoutId}/init`, body: '' }
  ];
}
async function attemptWrites(page, requests) {
  return page.evaluate(async (items) => {
    window.attemptedWrites = (window.attemptedWrites || 0) + items.length;
    await Promise.allSettled(items.map(({ url, body }) => fetch(url, { method: 'POST', body })));
  }, requests);
}
const acceptedWrites = (fixture) => fixture.accepted.filter((request) => request.method === 'POST');

test('only the same original is reloaded once and all real browser writes stay blocked until finish', async (t) => {
  const f = await fixture(t);
  const originalContext = f.page.context();
  const options = scope();
  assert.deepEqual(await recovery.reloadOriginalCheckout(f.page, options), {
    reloadAttempts: 1,
    blockedWrites: 0,
    code: 'CHECKOUT_RELOAD_READONLY'
  });
  assert.equal(f.page.context(), originalContext);
  assert.equal(f.page.url(), f.url);
  assert.equal(f.loads(), 2);
  assert.equal(await f.page.locator('input[autocomplete="cc-number"]').isVisible(), true);
  assert.equal(await f.page.evaluate(() => Boolean(window.retried)), false);
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 8);
  await attemptWrites(f.page, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture&browser_locale=en-US&redirect_type=url'
    }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
  assert.equal(f.loads(), 2);
  const finished = await recovery.finishOriginalCheckoutReload(f.page, options);
  assert.equal(finished.code, 'CHECKOUT_RELOAD_READY');
  await attemptWrites(f.page, [
    { url: origin + '/fixture/form-write', body: 'permitted=after-readiness' },
    { url: origin + '/backend-api/payments/checkout', body: 'must=remain-blocked' },
    { url: origin + '/backend-api/payments/checkout/?fixture=1', body: 'must=remain-blocked' }
  ]);
  assert.equal(
    acceptedWrites(f).filter((request) => request.url.endsWith('/fixture/form-write')).length,
    1
  );
  assert.equal(
    acceptedWrites(f).filter((request) => request.url.includes('/backend-api/payments/checkout'))
      .length,
    0
  );
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 10);
});

test('concurrent recovery calls stop the page instead of reserving a second reload', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    recovery.reloadOriginalCheckout(f.page, scope()),
    recovery.reloadOriginalCheckout(f.page, scope())
  ]);
  assert.equal(
    results.every((result) => result.status === 'rejected'),
    true
  );
  assert.equal(
    results.every((result) => result.reason.code === 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED'),
    true
  );
  assert.equal(f.loads() <= 2, true);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).reloadAttempts, 1);
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

test('a second load failure after finish halts late scripts without reloading or writing again', async (t) => {
  const f = await fixture(t);
  await recovery.reloadOriginalCheckout(f.page, scope());
  await recovery.finishOriginalCheckoutReload(f.page, scope());
  await f.page.setContent(errorHtml);
  await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED'
  });
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
  assert.equal(f.loads(), 2);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).reloadAttempts, 1);
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED'
  });
});

test('the only reload uses a navigation timeout capped at ten seconds inside the original budget', async (t) => {
  const f = await fixture(t);
  const nativeReload = f.page.reload.bind(f.page);
  const calls = [];
  f.page.reload = async (options) => {
    calls.push(options);
    return nativeReload(options);
  };
  await recovery.reloadOriginalCheckout(f.page, scope({ deadlineAt: performance.now() + 60000 }));
  assert.deepEqual(calls, [{ waitUntil: 'domcontentloaded', timeout: 10000 }]);
});

for (const [name, expected] of [
  ['TimeoutError', 'CHECKOUT_RELOAD_TIMEOUT'],
  ['Error', 'CHECKOUT_RELOAD_FAILED']
]) {
  test(`native reload ${name} keeps its exact failure and deny-write protection`, async (t) => {
    const f = await fixture(t);
    f.page.reload = async () => {
      throw Object.assign(new Error('SYNTHETIC_PRIVATE_NATIVE_RELOAD'), { name });
    };
    await assert.rejects(
      recovery.reloadOriginalCheckout(f.page, scope({ deadlineAt: performance.now() + 60000 })),
      (error) => {
        assert.equal(error.code, expected);
        assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
        return true;
      }
    );
    assert.equal(f.loads(), 1);
    assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).reloadAttempts, 1);
    await attemptWrites(f.page, writes(f.checkoutId));
    assert.equal(acceptedWrites(f).length, 0);
    await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
      code: expected
    });
  });
}

test('the existing native oaics original remains recoverable without inventing an embedded source', async (t) => {
  const f = await fixture(t, { checkoutId: 'oaics_nativeOriginal', source: false });
  await recovery.reloadOriginalCheckout(f.page, scope());
  assert.equal(f.loads(), 2);
  assert.equal(f.page.url(), f.url);
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
  await recovery.finishOriginalCheckoutReload(f.page, scope());
});

test('guard installation failure never starts a reload and cannot be finished later', async (t) => {
  const f = await fixture(t);
  const nativeSession = f.context.newCDPSession.bind(f.context);
  f.context.newCDPSession = async () => {
    throw new Error('synthetic unavailable CDP');
  };
  await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_GUARD_UNAVAILABLE'
  });
  f.context.newCDPSession = nativeSession;
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_GUARD_UNAVAILABLE'
  });
  assert.equal(f.loads(), 1);
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

for (const [name, html] of [
  ['hidden failure template', '<html><body><div hidden>Content failed to load</div></body></html>'],
  ['a quote shell with no explicit failure', '<html><body>Due today PHP 9990</body></html>']
]) {
  test(`${name} never authorizes reloading an original checkout`, async (t) => {
    const f = await fixture(t, { errorHtml: html });
    await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope()), {
      code: 'CHECKOUT_RELOAD_NOT_REQUIRED'
    });
    assert.equal(f.loads(), 1);
    assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).reloadAttempts, 0);
    assert.equal(acceptedWrites(f).length, 0);
  });
}

test('embedded sessions without the actual same-page official source fail before any reload', async (t) => {
  const f = await fixture(t, { source: false });
  await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope()), {
    code: 'CHECKOUT_RECOVERY_UNSUPPORTED'
  });
  assert.equal(f.loads(), 1);
});

test('missing, unknown and already-submitted payment states fail closed before reload', async (t) => {
  const f = await fixture(t);
  for (const callback of [undefined, () => undefined, () => Promise.resolve(false), () => true]) {
    await assert.rejects(
      recovery.reloadOriginalCheckout(f.page, scope({ isSubmitted: callback })),
      {
        code:
          callback?.() === true
            ? 'CHECKOUT_RELOAD_PAYMENT_STARTED'
            : 'CHECKOUT_RELOAD_STATE_UNAVAILABLE'
      }
    );
  }
  assert.equal(f.loads(), 1);
  assert.equal(acceptedWrites(f).length, 0);
});

test('a payment submission observed during reload never allows restoring normal writes', async (t) => {
  let submitted = false;
  const f = await fixture(t, {
    onReload: () => {
      submitted = true;
    }
  });
  const options = scope({ isSubmitted: () => submitted });
  await assert.rejects(recovery.reloadOriginalCheckout(f.page, options), {
    code: 'CHECKOUT_RELOAD_PAYMENT_STARTED'
  });
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_PAYMENT_STARTED'
  });
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

test('finish rechecks the original payment callback and cannot weaken a started payment to false', async (t) => {
  let submitted = false;
  const f = await fixture(t);
  await recovery.reloadOriginalCheckout(f.page, scope({ isSubmitted: () => submitted }));
  submitted = true;
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_PAYMENT_STARTED'
  });
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

for (const destination of [
  `${origin}/checkout/${entity}/cs_test_differentOriginal`,
  'https://other.invalid/checkout/openai_fixture/cs_test_reloadOriginal'
]) {
  test(`a redirect away from the exact original is blocked before its HTTP handler: ${new URL(destination).hostname}`, async (t) => {
    const f = await fixture(t, { redirect: destination });
    await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope()), {
      code: 'CHECKOUT_RELOAD_ORIGINAL_CHANGED'
    });
    assert.equal(f.accepted.filter((request) => request.url === destination).length, 0);
    assert.equal(acceptedWrites(f).length, 0);
    await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
      code: 'CHECKOUT_RELOAD_ORIGINAL_CHANGED'
    });
  });
}

test('source mutation after reload prevents finishing and all subsequent writes remain blocked', async (t) => {
  const f = await fixture(t);
  await recovery.reloadOriginalCheckout(f.page, scope());
  recovery.rememberOfficialCheckout(f.page, {
    kind: 'official_checkout_response',
    checkoutId: 'cs_test_otherSource',
    processorEntity: entity
  });
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_ORIGINAL_CHANGED'
  });
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

test('a script navigation to another original is blocked while waiting for real card readiness', async (t) => {
  const f = await fixture(t);
  await recovery.reloadOriginalCheckout(f.page, scope());
  const destination = `${origin}/checkout/${entity}/cs_test_scriptOther`;
  await f.page
    .evaluate((url) => {
      window.location.href = url;
    }, destination)
    .catch(() => {});
  await assert.rejects(f.page.waitForURL(destination, { timeout: 200 }));
  assert.equal(f.accepted.filter((request) => request.url === destination).length, 0);
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_ORIGINAL_CHANGED'
  });
});

test('finish cannot replace an expired original budget with a fresh deadline', async (t) => {
  const f = await fixture(t);
  await recovery.reloadOriginalCheckout(f.page, scope({ deadlineAt: performance.now() + 500 }));
  await pause(550);
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'CHECKOUT_RELOAD_TIMEOUT'
  });
  await attemptWrites(f.page, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
});

test('the permanent new-checkout guard also blocks a redirected POST after form writes are restored', async (t) => {
  const f = await fixture(t, { writeRedirect: true });
  await recovery.reloadOriginalCheckout(f.page, scope());
  await recovery.finishOriginalCheckoutReload(f.page, scope());
  await attemptWrites(f.page, [
    { url: origin + '/fixture/redirect-write', body: 'synthetic=redirect' }
  ]);
  assert.deepEqual(acceptedWrites(f), [
    { method: 'POST', url: origin + '/fixture/redirect-write' }
  ]);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
});

async function cardFrame(f) {
  await f.page.frameLocator('iframe').locator('input[autocomplete="cc-number"]').waitFor();
  return f.page.frames().find((frame) => frame !== f.page.mainFrame());
}

function immediateInit(checkoutId) {
  return formHtml.replace(
    '</body>',
    `<script>
    fetch('https://api.stripe.com/v1/payment_pages/${checkoutId}/init',
      {method:'POST',body:'key=pk_test_fixture'}).catch(()=>{})
      .finally(()=>parent.postMessage('fixture-done','*'));
    </script></body>`
  );
}

for (const [installDelay, nested] of [
  [0, false],
  [600, false],
  [600, true]
]) {
  test(`OOPIF scripts wait for their exact guard before first init: delay=${installDelay}, nested=${nested}`, async (t) => {
    const checkoutId = `cs_test_firstInit${installDelay}${nested ? 'Nested' : 'Single'}`;
    const secondFrameUrl = 'https://card-fixture.invalid/fixture-inner';
    let installationCommands = 0;
    const f = await fixture(t, {
      checkoutId,
      frameUrl: 'https://js.stripe.com/fixture-card',
      frameHtml: nested
        ? formHtml.replace(
            '</body>',
            `<script>addEventListener('message',()=>parent.postMessage('fixture-done','*'))</script><iframe src="${secondFrameUrl}"></iframe></body>`
          )
        : immediateInit(checkoutId),
      secondFrameUrl,
      secondFrameHtml: immediateInit(checkoutId),
      initRedirect: true,
      childCommand: async (command, { accepted }) => {
        if (command.method !== 'Fetch.enable') return;
        installationCommands += 1;
        assert.equal(accepted.filter((item) => item.method === 'POST').length, 0);
        await pause(installDelay);
        assert.equal(accepted.filter((item) => item.method === 'POST').length, 0);
      }
    });
    await recovery.reloadOriginalCheckout(f.page, scope());
    await f.page.waitForFunction(() => window.fixtureDone === true);
    assert.equal(installationCommands, nested ? 2 : 1);
    assert.equal(acceptedWrites(f).length, 1);
    assert.match(acceptedWrites(f)[0].url, /\/init$/);
    assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
  });
}

test('a same-process middle frame retains exact ownership of its nested OOPIF', async (t) => {
  const checkoutId = 'cs_test_middleFrameOriginal';
  const secondFrameUrl = 'https://js.stripe.com/fixture-inner';
  const f = await fixture(t, {
    checkoutId,
    frameUrl: origin + '/fixture-middle',
    frameHtml: formHtml.replace(
      '</body>',
      `<script>addEventListener('message',()=>parent.postMessage('fixture-done','*'))</script><iframe src="${secondFrameUrl}"></iframe></body>`
    ),
    secondFrameUrl,
    secondFrameHtml: immediateInit(checkoutId),
    initRedirect: true
  });
  await recovery.reloadOriginalCheckout(f.page, scope());
  await f.page.waitForFunction(() => window.fixtureDone === true);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
});

test('a running leftover OOPIF is never resumed or made writable before reload replaces it', async (t) => {
  const frameUrl = 'https://js.stripe.com/fixture-card';
  let resumes = 0;
  const f = await fixture(t, {
    frameUrl,
    errorHtml: errorHtml.replace('</body>', `<iframe src="${frameUrl}"></iframe></body>`),
    childCommand: async (command) => {
      if (command.method === 'Runtime.runIfWaitingForDebugger') resumes += 1;
    }
  });
  const previousFrame = await cardFrame(f);
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  assert.notEqual(frame, previousFrame);
  await attemptWrites(frame, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture'
    }
  ]);
  assert.equal(resumes, 1);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
});

for (const stop of ['lease', 'deadline', 'protocol']) {
  test(`an OOPIF remains paused when ${stop} fails its guard installation`, async (t) => {
    const controller = new AbortController();
    const checkoutId = `cs_test_installStop${stop}`;
    let resumeCommands = 0;
    let started;
    const installationStarted = new Promise((resolve) => {
      started = resolve;
    });
    const f = await fixture(t, {
      checkoutId,
      frameUrl: 'https://js.stripe.com/fixture-card',
      frameHtml: immediateInit(checkoutId),
      childCommand: async (command) => {
        if (command.method === 'Runtime.runIfWaitingForDebugger') resumeCommands += 1;
        if (command.method !== 'Fetch.enable') return;
        started();
        if (stop === 'lease') controller.abort();
        if (stop === 'protocol') throw new Error('synthetic guard rejection');
        await pause(350);
      }
    });
    const options = scope({
      signal: controller.signal,
      deadlineAt: performance.now() + (stop === 'deadline' ? 220 : 5000)
    });
    await recovery.reloadOriginalCheckout(f.page, options).catch((error) => {
      assert.equal(['LEASE_LOST', 'CHECKOUT_RELOAD_TIMEOUT'].includes(error.code), true);
    });
    await installationStarted;
    await pause(450);
    assert.equal(acceptedWrites(f).length, 0);
    assert.equal(resumeCommands, 0);
    const expectedCode =
      stop === 'lease'
        ? 'LEASE_LOST'
        : stop === 'deadline'
          ? 'CHECKOUT_RELOAD_TIMEOUT'
          : 'CHECKOUT_RELOAD_GUARD_UNAVAILABLE';
    assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).code, expectedCode);
    await f.page.close({ runBeforeUnload: false });
    assert.equal(acceptedWrites(f).length, 0);
  });
}

test('a finished page guards a new OOPIF after the old loading deadline without reopening that budget', async (t) => {
  const loading = new AbortController();
  const owner = new AbortController();
  const frameUrl = 'https://js.stripe.com/fixture-card';
  const f = await fixture(t, { frameUrl, writeRedirect: true, formHtml });
  const options = scope({
    signal: loading.signal,
    ownerSignal: owner.signal,
    deadlineAt: performance.now() + 500
  });
  await recovery.reloadOriginalCheckout(f.page, options);
  await recovery.finishOriginalCheckoutReload(f.page, options);
  loading.abort();
  await pause(550);
  await f.page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.appendChild(frame);
  }, frameUrl);
  const frame = await cardFrame(f);
  await attemptWrites(frame, [
    { url: origin + '/fixture/redirect-write', body: 'synthetic=after-deadline' }
  ]);
  assert.deepEqual(acceptedWrites(f), [
    { method: 'POST', url: origin + '/fixture/redirect-write' }
  ]);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).code, 'CHECKOUT_RELOAD_READY');
  owner.abort();
  await attemptWrites(frame, [
    { url: origin + '/fixture/after-owner-stop', body: 'must=be-blocked' }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).code, 'LEASE_LOST');
});

test('page-scoped OOPIF attachment leaves another page and another task context writable', async (t) => {
  const f = await fixture(t, { frameUrl: 'https://js.stripe.com/fixture-card' });
  const other = await fixture(t, { checkoutId: 'cs_test_otherContext' });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const sameContext = await f.context.newPage();
  await sameContext.goto(origin + '/fixture-other-page');
  await attemptWrites(sameContext, [
    { url: origin + '/fixture/same-context-write', body: 'synthetic=allowed' }
  ]);
  await attemptWrites(other.page, [
    { url: origin + '/fixture/other-context-write', body: 'synthetic=allowed' }
  ]);
  assert.deepEqual(acceptedWrites(f), [
    { method: 'POST', url: origin + '/fixture/same-context-write' }
  ]);
  assert.deepEqual(acceptedWrites(other), [
    { method: 'POST', url: origin + '/fixture/other-context-write' }
  ]);
  const frame = await cardFrame(f);
  await attemptWrites(frame, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 1);
});

test('a real Stripe OOPIF initializes only its guarded original without sending a payment or billing write', async (t) => {
  const frameUrl = 'https://js.stripe.com/fixture-card';
  const f = await fixture(t, { frameUrl });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  const inspection = await browser.newBrowserCDPSession();
  t.after(() => inspection.detach());
  const targets = await inspection.send('Target.getTargets');
  assert.equal(
    targets.targetInfos.some((item) => item.type === 'iframe' && item.url === frameUrl),
    true
  );
  await attemptWrites(frame, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 8);
  await attemptWrites(frame, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture&browser_locale=en-US'
    }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
  await attemptWrites(frame, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 1);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 16);
});

test('an OOPIF original init cannot redirect into an unguarded confirmation', async (t) => {
  const f = await fixture(t, {
    frameUrl: 'https://js.stripe.com/fixture-card',
    initRedirect: true
  });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  await attemptWrites(frame, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture'
    }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
});

test('an OOPIF read resource and later init remain bound to the guard installed before scripts ran', async (t) => {
  const frameUrl = 'https://js.stripe.com/fixture-card';
  const resourceUrl = 'https://js.stripe.com/fixture-resource';
  const f = await fixture(t, {
    frameUrl,
    frameHtml: formHtml.replace('</body>', `<img src="${resourceUrl}"></body>`)
  });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  await frame.waitForFunction(() => document.querySelector('img').complete);
  assert.equal(
    f.accepted.some((request) => request.url === resourceUrl),
    true
  );
  await attemptWrites(frame, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture'
    }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 0);
});

test('an OOPIF redirected POST cannot create a checkout after form writes are restored', async (t) => {
  const f = await fixture(t, {
    frameUrl: 'https://js.stripe.com/fixture-card',
    writeRedirect: true
  });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  await recovery.finishOriginalCheckoutReload(f.page, scope());
  await attemptWrites(frame, [
    { url: origin + '/fixture/redirect-write', body: 'synthetic=redirect' }
  ]);
  assert.deepEqual(acceptedWrites(f), [
    { method: 'POST', url: origin + '/fixture/redirect-write' }
  ]);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
});

test('a same-process child uses the parent redirect guard without counting blocked writes twice', async (t) => {
  const f = await fixture(t, { frameUrl: origin + '/fixture-card', initRedirect: true });
  await recovery.reloadOriginalCheckout(f.page, scope());
  const frame = await cardFrame(f);
  await attemptWrites(frame, [
    {
      url: `https://api.stripe.com/v1/payment_pages/${f.checkoutId}/init`,
      body: 'key=pk_test_fixture'
    }
  ]);
  assert.equal(acceptedWrites(f).length, 1);
  assert.match(acceptedWrites(f)[0].url, /\/init$/);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites, 1);
});

test('lease loss after finish halts parent and OOPIF writes again without restoring the page', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { frameUrl: 'https://js.stripe.com/fixture-card' });
  await recovery.reloadOriginalCheckout(f.page, scope({ signal: controller.signal }));
  const frame = await cardFrame(f);
  await recovery.finishOriginalCheckoutReload(f.page, scope());
  controller.abort();
  await attemptWrites(f.page, writes(f.checkoutId));
  await attemptWrites(frame, writes(f.checkoutId));
  assert.equal(acceptedWrites(f).length, 0);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(f.page).code, 'LEASE_LOST');
  await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
    code: 'LEASE_LOST'
  });
});

test('expired deadlines and pre-aborted leases never start a reload', async (t) => {
  const f = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(recovery.reloadOriginalCheckout(f.page, scope({ signal: abort.signal })), {
    code: 'LEASE_LOST'
  });
  await assert.rejects(
    recovery.reloadOriginalCheckout(f.page, scope({ deadlineAt: performance.now() - 1 })),
    { code: 'CHECKOUT_RELOAD_TIMEOUT' }
  );
  assert.equal(f.loads(), 1);
});

for (const stop of ['lease', 'deadline', 'incomplete']) {
  test(`an ${stop} load probe cannot start a reload and preserves its controlled failure`, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const frame = f.page.mainFrame(),
      getByText = frame.getByText;
    let entered,
      reads = 0;
    const reading = new Promise((resolve) => (entered = resolve));
    frame.getByText = function (text, ...options) {
      const result = getByText.call(this, text, ...options);
      if (text === 'Content failed to load')
        result.count = () => {
          reads++;
          entered();
          return new Promise(() => {});
        };
      return result;
    };
    t.after(() => {
      frame.getByText = getByText;
    });
    const pending = recovery.reloadOriginalCheckout(
      f.page,
      scope({
        signal: controller.signal,
        deadlineAt: performance.now() + (stop === 'deadline' ? 250 : 3000)
      })
    );
    const rejected = assert.rejects(pending, {
      code:
        stop === 'lease'
          ? 'LEASE_LOST'
          : stop === 'deadline'
            ? 'CHECKOUT_RELOAD_TIMEOUT'
            : 'CHECKOUT_RELOAD_FAILED'
    });
    await Promise.race([reading, pending]);
    if (stop === 'lease') controller.abort();
    await rejected;
    assert.equal(reads, stop === 'incomplete' ? 2 : 1);
    assert.equal(f.loads(), 1);
    assert.equal(
      recovery.originalCheckoutReloadDiagnostics(f.page).code,
      'CHECKOUT_RELOAD_NOT_ATTEMPTED'
    );
  });
}

for (const stop of ['lease', 'deadline']) {
  test(`${stop} loss keeps real late page scripts protected after the reload promise has failed`, async (t) => {
    const controller = new AbortController();
    const checkoutId = 'cs_test_lateReload' + stop;
    const attempted = writes(checkoutId);
    let onReloadRequested, deadlineAt;
    const reloadAccepted = new Promise((resolve) => (onReloadRequested = resolve));
    const f = await fixture(t, {
      checkoutId,
      onReloadRequested: async () => {
        onReloadRequested();
        if (stop === 'deadline') await pause(Math.max(0, deadlineAt - performance.now()) + 100);
      },
      delay: stop === 'lease' ? 250 : 0,
      formHtml: formHtml.replace(
        '</body>',
        `<script>
        window.attemptedWrites=${attempted.length};
        window.lateWrites=Promise.allSettled(${JSON.stringify(attempted)}.map(({url,body})=>fetch(url,{method:'POST',body})));
      </script></body>`
      )
    });
    const options = scope({
      signal: controller.signal,
      deadlineAt: performance.now() + 3000
    });
    deadlineAt = options.deadlineAt;
    const pending = recovery.reloadOriginalCheckout(f.page, options);
    const rejected = assert.rejects(pending, {
      code: stop === 'lease' ? 'LEASE_LOST' : 'CHECKOUT_RELOAD_TIMEOUT'
    });
    // Cancellation must follow the accepted second navigation, not guard setup.
    await Promise.race([reloadAccepted, pending]);
    if (stop === 'lease') controller.abort();
    await rejected;
    // The browser may still finish the already accepted navigation after cancellation.
    // Its real POST attempts must continue to hit our retained page guard.
    await f.page.waitForFunction(() => window.attemptedWrites > 0, null, { timeout: 2000 });
    await f.page.evaluate(() => window.lateWrites);
    assert.equal(await f.page.evaluate(() => window.attemptedWrites), attempted.length);
    assert.equal(acceptedWrites(f).length, 0);
    assert.equal(
      recovery.originalCheckoutReloadDiagnostics(f.page).blockedWrites,
      attempted.length
    );
    await assert.rejects(recovery.finishOriginalCheckoutReload(f.page, scope()), {
      code: stop === 'lease' ? 'LEASE_LOST' : 'CHECKOUT_RELOAD_TIMEOUT'
    });
  });
}

test('two task pages keep their source, single-reload budget and restoration state isolated', async (t) => {
  const first = await fixture(t, { checkoutId: 'cs_test_isolatedFirst' });
  const second = await fixture(t, { checkoutId: 'cs_test_isolatedSecond' });
  await Promise.all([
    recovery.reloadOriginalCheckout(first.page, scope()),
    recovery.reloadOriginalCheckout(second.page, scope())
  ]);
  await recovery.finishOriginalCheckoutReload(first.page, scope());
  await attemptWrites(first.page, [{ url: origin + '/fixture/form-write', body: 'first=ready' }]);
  await attemptWrites(second.page, [
    { url: origin + '/fixture/form-write', body: 'second=readonly' }
  ]);
  assert.equal(acceptedWrites(first).length, 1);
  assert.equal(acceptedWrites(second).length, 0);
  assert.equal(
    recovery.originalCheckoutReloadDiagnostics(first.page).code,
    'CHECKOUT_RELOAD_READY'
  );
  assert.equal(
    recovery.originalCheckoutReloadDiagnostics(second.page).code,
    'CHECKOUT_RELOAD_READONLY'
  );
  assert.equal(first.loads(), 2);
  assert.equal(second.loads(), 2);
  assert.deepEqual(Object.keys(recovery.originalCheckoutReloadDiagnostics(first.page)).sort(), [
    'blockedWrites',
    'code',
    'reloadAttempts'
  ]);
});
