'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');
const runtime = require('../upstream/verification-runtime');
const auth = require('../upstream/session-auth');
const source = fs.readFileSync(path.join(__dirname, '../upstream/human-verification.js'), 'utf8');
function human(form) {
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(name) {
      if (name === '../checkout-form.cjs') return form;
      if (name === './verification-runtime') return runtime;
      return {};
    }
  });
  return module.exports;
}
const complete = {
  complete: true,
  framesFailed: 0,
  timedOut: false,
  aborted: false,
  pageClosed: false,
  contentLoadFailed: false
};

test('card readiness uses one full read and keeps its boolean contract and owner budget', async () => {
  const owner = new AbortController();
  let reads = 0,
    snapshot;
  const deadline = Date.now() + 12000;
  const h = human({
    checkoutPageLoadFailed() {
      throw Error('Duplicate scan');
    },
    inspectCardReadiness: async (_page, options) => {
      reads++;
      assert.equal(options.deadline, deadline);
      assert.equal(options.signal, owner.signal);
      return { ready: true, inspection: complete };
    }
  });
  assert.equal(
    await h.isCheckoutPaymentReady(
      {},
      {
        deadline,
        signal: owner.signal,
        onInspection: (value) => {
          snapshot = value;
        }
      }
    ),
    true
  );
  assert.equal(reads, 1);
  assert.equal(snapshot.inspection, complete);
});
for (const [flag, code] of [
  ['framesFailed', 'CHECKOUT_CONTROL_READ_FAILED'],
  ['timedOut', 'CHECKOUT_FORM_TIMEOUT'],
  ['aborted', 'CHECKOUT_FORM_ABORTED'],
  ['pageClosed', 'CHECKOUT_PAGE_CLOSED']
]) {
  test(`an incomplete ${flag} read still refuses readiness and carries inspection`, async () => {
    const inspection = {
      ...complete,
      complete: false,
      [flag]: flag === 'framesFailed' ? 1 : true,
      readPhase: 'frame_scan'
    };
    const h = human({
      inspectCardReadiness: async () => ({ ready: false, code, inspection, missing: ['number'] })
    });
    await assert.rejects(
      h.isCheckoutPaymentReady({}),
      (error) => error.code === code && error.inspection === inspection
    );
  });
}
test('visible load failure and missing controls remain false, never a truthy result object', async () => {
  for (const inspection of [complete, { ...complete, contentLoadFailed: true }]) {
    const h = human({ inspectCardReadiness: async () => ({ ready: false, inspection }) });
    assert.equal(await h.isCheckoutPaymentReady({}), false);
  }
});

test('cancelled budget does not invoke a factory or extend its deadline', async () => {
  const owner = new AbortController();
  const budget = runtime.createVerificationBudget({ signal: owner.signal });
  owner.abort();
  let calls = 0;
  try {
    await assert.rejects(
      budget.run(() => {
        calls++;
      }),
      { code: 'VERIFICATION_CANCELLED' }
    );
  } finally {
    budget.dispose();
  }
  assert.equal(calls, 0);
});
test('in-flight work is rejected at deadline and late completion is observed safely', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const budget = runtime.createVerificationBudget({ deadlineAt: performance.now() + 20 });
  let continued = false;
  try {
    await assert.rejects(
      budget
        .run(() => pending)
        .then(() => {
          continued = true;
        }),
      { code: 'VERIFICATION_TIMEOUT' }
    );
    release('late');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(continued, false);
  } finally {
    clearTimeout(keepAlive);
    budget.dispose();
  }
});
test('page close has a separate bounded cleanup window', async () => {
  assert.equal(
    await runtime.closeVerificationPage(
      { close: () => new Promise(() => {}), isClosed: () => false },
      10
    ),
    false
  );
});
test('bootstrap cancellation interrupts a never-returning navigation and ignores its late response', async () => {
  const controller = new AbortController();
  let entered;
  const navigation = new Promise((resolve) => {
    entered = resolve;
  });
  let closed = false,
    release,
    calls = 0;
  const page = {
    on() {},
    url: () => 'https://chatgpt.com/',
    isClosed: () => closed,
    close: async () => {
      closed = true;
    },
    goto: () => {
      calls++;
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }
  };
  const session = JSON.stringify({
    accessToken: 'synthetic-access',
    user: { id: 'synthetic-user' }
  });
  const result = auth.bootstrapChatGptSession(page, session, { signal: controller.signal });
  const stopped = assert.rejects(
    result,
    (error) => error.code === 'LEASE_LOST' && error.bootstrapDiagnostics.lastAwait === 'navigation'
  );
  await navigation;
  controller.abort(Object.assign(new Error('Synthetic lease lost'), { code: 'LEASE_LOST' }));
  await stopped;
  assert.equal(closed, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('pool cleanup confirms every owned context closed before reporting success', async () => {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../upstream/browser-pool.js'), 'utf8');
  runInNewContext(source + '\nmodule.exports.fixtureSlot = slot => { slots = [slot]; };', {
    module,
    process: { env: {} },
    setTimeout,
    clearTimeout,
    require(name) {
      if (name === 'fs') return fs;
      if (name === 'path') return path;
      if (name === 'playwright') return { chromium: {} };
      throw Error(`Unexpected module ${name}`);
    }
  });
  const pool = module.exports;
  let contexts;
  const browser = { contexts: () => contexts };
  const persistent = { browser: () => browser };
  pool.fixtureSlot({ slotId: 1, persistentContext: persistent });
  const owned = {
    close: async () => {
      contexts = [persistent];
    }
  };
  contexts = [persistent, owned];
  assert.equal(await pool.clearTaskContexts(1), true);
  contexts = [persistent, { close: async () => {} }];
  assert.equal(await pool.clearTaskContexts(1), false);
  contexts = [
    persistent,
    {
      close: async () => {
        throw Error('synthetic close failed');
      }
    }
  ];
  assert.equal(await pool.clearTaskContexts(1), false);
  assert.equal(await pool.clearTaskContexts(2), false);
});

test('a shorter verification timeout keeps its own cause while the login budget remains', async () => {
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../upstream/session-auth.js'), 'utf8'), {
    module,
    Buffer,
    URL,
    Date,
    performance,
    process: { env: {} },
    console: { log() {}, warn() {} },
    require(name) {
      if (name === './verification-runtime')
        return {
          ...runtime,
          createVerificationBudget: (options) => {
            const budget = runtime.createVerificationBudget(options);
            return { ...budget, wait: async () => {} };
          }
        };
      if (name === './auth-page-detect') return { hasVisibleLoginChrome: async () => false };
      if (name === '../unpaid-validation.cjs') return require('../unpaid-validation.cjs');
      if (name === './human-verification')
        return {
          isBlockingHumanVerificationVisible: async () => true,
          clearHumanVerification: async () => ({ cleared: false, code: 'VERIFICATION_TIMEOUT' })
        };
      throw Error(`Unexpected module ${name}`);
    }
  });
  let closed = false;
  const page = {
    on() {},
    goto: async () => {},
    url: () => 'https://chatgpt.com/',
    close: async () => {
      closed = true;
    },
    isClosed: () => closed
  };
  await assert.rejects(
    module.exports.bootstrapChatGptSession(
      page,
      JSON.stringify({ accessToken: 'synthetic-access', user: { id: 'synthetic-user' } })
    ),
    (error) =>
      error.code === 'VERIFICATION_TIMEOUT' &&
      error.bootstrapDiagnostics.reason === 'verification_failed'
  );
  assert.equal(closed, false);
});
