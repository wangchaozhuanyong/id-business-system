'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const privateMarker = 'synthetic_PRIVATE_VALUE_never_project';
const checkoutId = 'cs_test_privateOriginalFixture';
const initUrl = `https://api.stripe.com/v1/payment_pages/${checkoutId}/init`;
const safeBody = 'key=pk_test_synthetic&browser_locale=en-US&redirect_type=iframe';
const plain = (value) => JSON.parse(JSON.stringify(value));
const request = (url, body = '', method = 'POST') => ({ url, body, method });
const requestView = (item, frame) => ({
  url: () => item.url,
  method: () => item.method,
  postData: () => item.body,
  frame: () => frame
});
async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'offline protocol branch did not complete');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
async function fixture(t, options = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../checkout-recovery.cjs'), 'utf8'), {
    module,
    URL,
    URLSearchParams,
    Buffer,
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './checkout-form.cjs') return { checkoutPageLoadFailed: async () => true };
      if (name === './checkout-initialization.cjs')
        return require('../checkout-initialization.cjs');
      throw new Error('Unexpected offline fixture import');
    }
  });
  const recovery = module.exports;
  const commands = [],
    routes = [],
    cdp = new EventEmitter(),
    page = new EventEmitter();
  const originalId = options.native ? 'oaics_privateOriginalFixture' : checkoutId;
  const originalUrl = `https://chatgpt.com/checkout/openai_fixture/${originalId}`;
  let currentUrl = originalUrl,
    closed = false,
    submitted = false,
    reloads = 0;
  const mainFrame = {},
    childFrame = { parentFrame: () => mainFrame };
  function deliver(sessionPath, message) {
    if (!sessionPath.length) return cdp.emit(message.method, message.params);
    let raw = JSON.stringify(message);
    for (let index = sessionPath.length - 1; index > 0; index--)
      raw = JSON.stringify({
        method: 'Target.receivedMessageFromTarget',
        params: { sessionId: sessionPath[index], message: raw }
      });
    cdp.emit('Target.receivedMessageFromTarget', { sessionId: sessionPath[0], message: raw });
  }
  function childCommand(sessionPath, command) {
    commands.push({ sessionPath, method: command.method, params: command.params });
    queueMicrotask(() => deliver(sessionPath, { id: command.id, result: {} }));
    if (command.method === 'Target.sendMessageToTarget')
      childCommand([...sessionPath, command.params.sessionId], JSON.parse(command.params.message));
  }
  cdp.send = async (method, params = {}) => {
    commands.push({ sessionPath: [], method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Target.sendMessageToTarget')
      childCommand([params.sessionId], JSON.parse(params.message));
    return {};
  };
  const context = {
    newCDPSession: async (target) => {
      if (target === page) return cdp;
      throw new Error(
        "browserContext.newCDPSession: This frame does not have a separate CDP session, it is a part of the parent frame's session"
      );
    }
  };
  Object.assign(page, {
    url: () => currentUrl,
    context: () => context,
    isClosed: () => closed,
    mainFrame: () => mainFrame,
    route: async (_pattern, handler) => routes.push(handler),
    reload: async () => {
      reloads++;
    }
  });
  t.after(() => {
    closed = true;
    page.emit('close');
  });
  if (!options.native)
    recovery.rememberOfficialCheckout(page, {
      kind: 'official_checkout_response',
      checkoutId,
      processorEntity: 'openai_fixture'
    });
  const scope = { deadlineAt: performance.now() + 30000, isSubmitted: () => submitted };
  assert.deepEqual(plain(await recovery.reloadOriginalCheckout(page, scope)), {
    reloadAttempts: 1,
    blockedWrites: 0,
    code: 'CHECKOUT_RELOAD_READONLY'
  });
  let sequence = 0;
  async function paused(item, sessionPath = []) {
    const requestId = 'offline-request-' + ++sequence;
    const raw = {
      url: item.url,
      method: item.method,
      ...(item.omittedBody
        ? { hasPostData: true }
        : { postData: item.body, hasPostData: Boolean(item.body) })
    };
    deliver(sessionPath, {
      method: 'Fetch.requestPaused',
      params: {
        requestId,
        request: raw,
        frameId: 'main-frame',
        resourceType: 'XHR'
      }
    });
    await until(() =>
      commands.some(
        (value) =>
          ['Fetch.failRequest', 'Fetch.continueRequest'].includes(value.method) &&
          value.params.requestId === requestId
      )
    );
    return commands.find(
      (value) =>
        ['Fetch.failRequest', 'Fetch.continueRequest'].includes(value.method) &&
        value.params.requestId === requestId
    ).method;
  }
  async function routed(item, frame = childFrame) {
    let action;
    await routes[0]({
      request: () => requestView(item, frame),
      abort: async (reason) => {
        assert.equal(reason, 'blockedbyclient');
        action = 'abort';
      },
      fallback: async () => {
        action = 'fallback';
      }
    });
    return action;
  }
  async function attach(sessionPath, sessionId, targetId, parentFrameId) {
    deliver(sessionPath, {
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        waitingForDebugger: true,
        targetInfo: { type: 'iframe', targetId, parentFrameId }
      }
    });
    const childPath = [...sessionPath, sessionId];
    await until(() =>
      commands.some(
        (value) =>
          value.method === 'Runtime.runIfWaitingForDebugger' &&
          JSON.stringify(value.sessionPath) === JSON.stringify(childPath)
      )
    );
    return childPath;
  }
  return {
    recovery,
    page,
    scope,
    paused,
    routed,
    attach,
    commands,
    diagnostics: () => plain(recovery.originalCheckoutReloadDiagnostics(page)),
    submitted: () => {
      submitted = true;
    },
    changeOriginal: () => {
      currentUrl = originalUrl.replace(originalId, 'cs_test_otherOriginal');
    },
    reloads: () => reloads
  };
}
function assertPrivateProjection(diagnostics) {
  const encoded = JSON.stringify(diagnostics);
  for (const forbidden of [
    privateMarker,
    checkoutId,
    'https://',
    'pk_test_',
    'browser_locale',
    'synthetic_unknown_parameter',
    'authorization',
    'postData',
    'headers',
    'body'
  ])
    assert.equal(encoded.includes(forbidden), false, 'request material escaped into diagnostics');
  const values = diagnostics.blockedRequestDiagnostics || [];
  assert.ok(values.length <= 16);
  for (const item of values) {
    assert.deepEqual(Object.keys(item).sort(), ['count', 'operation', 'reason']);
    assert.match(item.operation, /^[A-Z_]+$/);
    assert.match(item.reason, /^[A-Z_]+$/);
    assert.ok(Number.isInteger(item.count) && item.count >= 1 && item.count <= 10000);
  }
}

test('actual parent CDP rejection branches classify only safe enums and keep all admission decisions', async (t) => {
  const f = await fixture(t);
  for (const item of [request(initUrl), request(initUrl, safeBody), request(initUrl, '', 'GET')]) {
    assert.equal(f.recovery.readOnlyRecoveryRequest(requestView(item), { checkoutId }), true);
    assert.equal(await f.paused(item), 'Fetch.continueRequest');
  }
  const cases = [
    [
      request(initUrl, `synthetic_unknown_parameter=${privateMarker}`),
      'STRIPE_INIT_SAME_CHECKOUT',
      'UNKNOWN_PARAMETER'
    ],
    [
      request(initUrl + '?browser_locale=en-US', 'browser_locale=en-US'),
      'STRIPE_INIT_SAME_CHECKOUT',
      'DUPLICATE_PARAMETER'
    ],
    [
      request(initUrl, `key=${privateMarker}`),
      'STRIPE_INIT_SAME_CHECKOUT',
      'INVALID_PARAMETER_VALUE'
    ],
    [request(initUrl, privateMarker.repeat(1000)), 'STRIPE_INIT_SAME_CHECKOUT', 'BODY_TOO_LARGE'],
    [{ ...request(initUrl), omittedBody: true }, 'STRIPE_INIT_SAME_CHECKOUT', 'BODY_UNAVAILABLE'],
    [
      request(initUrl.replace(checkoutId, 'cs_test_otherFixture')),
      'STRIPE_INIT_OTHER_CHECKOUT',
      'ORIGINAL_CHECKOUT_MISMATCH'
    ],
    [
      request(initUrl.replace('/init', '/confirm'), privateMarker),
      'STRIPE_OTHER_WRITE',
      'NON_INITIALIZATION_OPERATION'
    ],
    [
      request('https://chatgpt.com/backend-api/payments/checkout', privateMarker),
      'CHECKOUT_CREATE',
      'NON_INITIALIZATION_OPERATION'
    ],
    [
      request('https://untrusted.invalid/private-operation', privateMarker),
      'OTHER_WRITE',
      'NON_INITIALIZATION_OPERATION'
    ]
  ];
  for (const [item] of cases) assert.equal(await f.paused(item), 'Fetch.failRequest');
  assert.deepEqual(
    f.diagnostics().blockedRequestDiagnostics,
    cases.map(([, operation, reason]) => ({ operation, reason, count: 1 }))
  );
  assert.equal(f.diagnostics().blockedWrites, cases.length);
  assertPrivateProjection(f.diagnostics());
});

test('actual child route fallback rejects the same bodies without exposing names or values', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.routed(request(initUrl, safeBody)), 'fallback');
  for (const item of [
    request(initUrl, `synthetic_unknown_parameter=${privateMarker}`),
    request(initUrl, 'browser_locale=en-US&browser_locale=en-US'),
    request(initUrl, `key=${privateMarker}`),
    request(initUrl.replace('/init', '/confirm'), privateMarker)
  ])
    assert.equal(await f.routed(item), 'abort');
  assert.deepEqual(
    f.diagnostics().blockedRequestDiagnostics.map((item) => item.reason),
    [
      'UNKNOWN_PARAMETER',
      'DUPLICATE_PARAMETER',
      'INVALID_PARAMETER_VALUE',
      'NON_INITIALIZATION_OPERATION'
    ]
  );
  assert.equal(f.diagnostics().blockedWrites, 4);
  assertPrivateProjection(f.diagnostics());
});

test('recursive CDP child channels count denied initialization and still admit the original safe init', async (t) => {
  const f = await fixture(t);
  const child = await f.attach([], 'child-session', 'child-frame', 'main-frame');
  const nested = await f.attach(child, 'nested-session', 'nested-frame', 'child-frame');
  assert.equal(await f.paused(request(initUrl, safeBody), nested), 'Fetch.continueRequest');
  assert.equal(
    await f.paused(request(initUrl, `synthetic_unknown_parameter=${privateMarker}`), nested),
    'Fetch.failRequest'
  );
  assert.deepEqual(f.diagnostics().blockedRequestDiagnostics, [
    { operation: 'STRIPE_INIT_SAME_CHECKOUT', reason: 'UNKNOWN_PARAMETER', count: 1 }
  ]);
  assert.equal(f.diagnostics().blockedWrites, 1);
  assertPrivateProjection(f.diagnostics());
});

test('native oaics originals remain unbound to Stripe init in both route and CDP branches', async (t) => {
  const f = await fixture(t, { native: true });
  assert.equal(await f.routed(request(initUrl, safeBody)), 'abort');
  assert.equal(await f.paused(request(initUrl, safeBody)), 'Fetch.failRequest');
  assert.deepEqual(f.diagnostics().blockedRequestDiagnostics, [
    { operation: 'STRIPE_INIT_NATIVE_UNBOUND', reason: 'NATIVE_CHECKOUT_UNBOUND', count: 2 }
  ]);
  assertPrivateProjection(f.diagnostics());
});

test('a payment submission still halts the original and cannot create another reload', async (t) => {
  const f = await fixture(t);
  f.submitted();
  assert.equal(await f.paused(request(initUrl, safeBody)), 'Fetch.failRequest');
  assert.deepEqual(f.diagnostics().blockedRequestDiagnostics, [
    { operation: 'STRIPE_INIT_SAME_CHECKOUT', reason: 'PAYMENT_ALREADY_STARTED', count: 1 }
  ]);
  await assert.rejects(f.recovery.finishOriginalCheckoutReload(f.page, f.scope), {
    code: 'CHECKOUT_RELOAD_PAYMENT_STARTED'
  });
  await assert.rejects(f.recovery.reloadOriginalCheckout(f.page, f.scope));
  assert.equal(f.reloads(), 1);
  assertPrivateProjection(f.diagnostics());
});

test('diagnostic counters saturate while the original blocked-write count and refusal remain unchanged', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 10001; index++)
    assert.equal(
      await f.paused(request(initUrl, `synthetic_unknown_parameter=${privateMarker}`)),
      'Fetch.failRequest'
    );
  assert.deepEqual(f.diagnostics().blockedRequestDiagnostics, [
    { operation: 'STRIPE_INIT_SAME_CHECKOUT', reason: 'UNKNOWN_PARAMETER', count: 10000 }
  ]);
  assert.equal(f.diagnostics().blockedWrites, 10001);
  const snapshot = f.recovery.originalCheckoutReloadDiagnostics(f.page);
  snapshot.blockedRequestDiagnostics[0].reason = privateMarker;
  assert.equal(f.diagnostics().blockedRequestDiagnostics[0].reason, 'UNKNOWN_PARAMETER');
  assertPrivateProjection(f.diagnostics());
});

test('distinct classifications use one bounded overflow bucket without retaining request material', async (t) => {
  const f = await fixture(t);
  const otherInit = initUrl.replace(checkoutId, 'cs_test_otherFixture');
  const otherStripe = initUrl.replace('/init', '/confirm');
  const otherWrite = 'https://untrusted.invalid/private-operation';
  const cases = [
    request(initUrl, `synthetic_unknown_parameter=${privateMarker}`),
    request(initUrl, 'browser_locale=en-US&browser_locale=en-US'),
    request(initUrl, `key=${privateMarker}`),
    request(initUrl, privateMarker.repeat(1000)),
    { ...request(initUrl), omittedBody: true },
    request(otherInit),
    { ...request(otherInit), omittedBody: true },
    request(otherStripe),
    { ...request(otherStripe), omittedBody: true },
    request(initUrl.replace('https://', `https://synthetic:${privateMarker}@`)),
    request(otherWrite),
    { ...request(otherWrite), omittedBody: true },
    request('https://chatgpt.com/backend-api/payments/checkout')
  ];
  for (const item of cases) assert.equal(await f.paused(item), 'Fetch.failRequest');
  f.changeOriginal();
  for (const item of [
    request(initUrl, '', 'GET'),
    request(initUrl, safeBody),
    request(otherInit),
    request(otherStripe),
    request(otherWrite)
  ])
    assert.equal(await f.paused(item), 'Fetch.failRequest');
  const diagnostics = f.diagnostics();
  assert.equal(diagnostics.blockedRequestDiagnostics.length, 16);
  assert.deepEqual(diagnostics.blockedRequestDiagnostics.at(-1), {
    operation: 'OTHER_REQUEST',
    reason: 'DIAGNOSTIC_LIMIT',
    count: 3
  });
  assert.equal(diagnostics.blockedWrites, cases.length + 4);
  assertPrivateProjection(diagnostics);
});

test('the exported reload projection only rebuilds bounded known diagnostics after one reload', () => {
  const {
    sanitizeOriginalCheckoutReloadDiagnostics: sanitize
  } = require('../checkout-recovery.cjs');
  const row = { operation: 'STRIPE_INIT_SAME_CHECKOUT', reason: 'UNKNOWN_PARAMETER', count: 2 };
  const value = {
    reloadAttempts: 1,
    blockedWrites: 2,
    blockedRequestDiagnostics: [row],
    code: 'CHECKOUT_RELOAD_READONLY',
    secret: privateMarker
  };
  assert.equal(
    sanitize({ reloadAttempts: 0, blockedWrites: 0, code: 'CHECKOUT_RELOAD_NOT_ATTEMPTED' }),
    undefined
  );
  assert.deepEqual(sanitize(value), {
    reloadAttempts: 1,
    blockedWrites: 2,
    blockedRequestDiagnostics: [{ ...row }],
    code: 'CHECKOUT_RELOAD_READONLY'
  });
  assertPrivateProjection(sanitize(value));
  const copy = sanitize(value);
  copy.blockedRequestDiagnostics[0].count = 10000;
  assert.equal(row.count, 2);
  assert.deepEqual(
    sanitize({ reloadAttempts: 1, blockedWrites: 0, code: 'CHECKOUT_RELOAD_READY' }),
    { reloadAttempts: 1, blockedWrites: 0, code: 'CHECKOUT_RELOAD_READY' }
  );
  for (const changed of [
    null,
    [],
    { ...value, reloadAttempts: true },
    { ...value, reloadAttempts: 2 },
    { ...value, blockedWrites: -1 },
    { ...value, blockedWrites: 10001 },
    { ...value, blockedWrites: 1.5 },
    { ...value, blockedWrites: true },
    { ...value, code: privateMarker },
    { ...value, blockedRequestDiagnostics: {} },
    { ...value, blockedRequestDiagnostics: [row, row] },
    { ...value, blockedRequestDiagnostics: Array(17).fill(row) }
  ])
    assert.equal(sanitize(changed), undefined);
  for (const changed of [
    { ...row, operation: privateMarker },
    { ...row, reason: privateMarker },
    { ...row, count: 0 },
    { ...row, count: 10001 },
    { ...row, count: true },
    { ...row, count: 0.5 },
    { ...row, secret: privateMarker }
  ])
    assert.equal(sanitize({ ...value, blockedRequestDiagnostics: [changed] }), undefined);
});

test('projection snapshots validated values once so getters cannot substitute sensitive output', () => {
  const {
    sanitizeOriginalCheckoutReloadDiagnostics: sanitize
  } = require('../checkout-recovery.cjs');
  const reads = {};
  const once = (name, value) => ({
    enumerable: true,
    get() {
      reads[name] = (reads[name] || 0) + 1;
      return reads[name] === 1 ? value : privateMarker;
    }
  });
  const row = Object.defineProperties(
    {},
    {
      operation: once('operation', 'STRIPE_INIT_SAME_CHECKOUT'),
      reason: once('reason', 'UNKNOWN_PARAMETER'),
      count: once('count', 1)
    }
  );
  const raw = Object.defineProperties(
    { reloadAttempts: 1, blockedRequestDiagnostics: [row] },
    {
      blockedWrites: once('blockedWrites', 1),
      code: once('code', 'CHECKOUT_RELOAD_READONLY')
    }
  );
  const result = sanitize(raw);
  assert.deepEqual(result, {
    reloadAttempts: 1,
    blockedWrites: 1,
    blockedRequestDiagnostics: [
      { operation: 'STRIPE_INIT_SAME_CHECKOUT', reason: 'UNKNOWN_PARAMETER', count: 1 }
    ],
    code: 'CHECKOUT_RELOAD_READONLY'
  });
  assert.deepEqual(Object.values(reads), [1, 1, 1, 1, 1]);
  assertPrivateProjection(result);
});
