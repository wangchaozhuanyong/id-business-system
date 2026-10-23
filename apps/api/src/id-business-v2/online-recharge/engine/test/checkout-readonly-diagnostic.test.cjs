'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { performance } = require('node:perf_hooks');
const runtime = require('../upstream/verification-runtime');
const { errorClass } = require('../checkout-await-diagnostics.cjs');
const realForm = require('../checkout-form.cjs');
const source = readFileSync(path.join(__dirname, '../checkout-readonly-diagnostic.cjs'), 'utf8');
const complete = {
  complete: true,
  timedOut: false,
  aborted: false,
  pageClosed: false,
  framesChecked: 2,
  framesSkipped: 13,
  framesFailed: 0,
  readAttempts: 1,
  readFailures: [],
  frameSkipCounts: { hidden: 13 },
  controlCounts: { scanned: 3, eligible: 0 }
};

function fixture(overrides = {}) {
  const calls = [],
    frame = {},
    module = { exports: {} };
  const snapshot = {
    elapsedMs: 50,
    events: Array.from({ length: 64 }, (_, n) => ({ n })),
    criticalEvents: Array.from({ length: 96 }, (_, n) => ({ n })),
    failureClasses: Array.from({ length: 32 }, (_, n) => ({ n })),
    truncated: true
  };
  const initialization = {
    dispose() {
      calls.push('freeze');
    },
    snapshot: () => snapshot
  };
  let closed = false;
  const page = {
    evaluate: async () => ({
      formTimeout: false,
      expired: false,
      challenge: false,
      configurePlan: true
    }),
    mainFrame: () => frame,
    isClosed: () => closed,
    close: async () => {
      calls.push('close');
      closed = true;
    }
  };
  const form = {
    async checkoutPageLoadFailed(_page, options) {
      calls.push('load');
      assert.ok(options.deadline - Date.now() > 2000);
      assert.notEqual(options.stopOnReadFailure, true);
      return false;
    },
    async inspectCardReadiness(_page, options) {
      calls.push('ready');
      assert.ok(options.deadline - Date.now() <= 2000);
      assert.notEqual(options.stopOnReadFailure, true);
      return { ready: true, code: 'CHECKOUT_CARD_READY', inspection: complete };
    },
    ...overrides.form
  };
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'node:perf_hooks') return { performance };
      if (name === './checkout-form.cjs') return form;
      if (name === './checkout-await-diagnostics.cjs') return { errorClass };
      if (name === './upstream/verification-runtime') return runtime;
      if (name === './upstream/stripe-payment')
        return {
          prepareCheckoutCardSection:
            overrides.prepare ||
            (async (_page, options) => {
              calls.push('prepare');
              options.onPreparation({
                complete: true,
                labelCount: 1,
                visibleLabelCount: 1,
                scrolled: true,
                operation: 'label_scroll'
              });
            })
        };
      throw Error('Unexpected import');
    }
  });
  return {
    page,
    frame,
    calls,
    snapshot,
    initialization,
    run: (options) => module.exports.inspectOriginalCheckout(page, { initialization, ...options })
  };
}

test('readonly sequence preserves the pre-check, preparation, readiness and final check', async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.stopStage, 'before_payment');
  assert.deepEqual(f.calls, ['load', 'prepare', 'ready', 'load', 'freeze']);
  assert.equal(result.paymentClicks, 0);
  assert.equal(result.cardFilled, false);
  assert.equal(result.newCheckout, false);
  assert.equal(f.page.isClosed(), false);
});

test('existing bounded network arrays survive without a second prefix truncation', async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(result.initialization, f.snapshot);
  assert.equal(result.initialization.events.length, 64);
  assert.equal(result.initialization.criticalEvents.length, 96);
  assert.equal(result.initialization.failureClasses.length, 32);
});

test('a failed pre-check retains the frame operation and inspection and freezes before close', async () => {
  const f = fixture({
    form: {
      async checkoutPageLoadFailed(_page, options) {
        const finish = options.onRead(
          { readOperation: 'load_error_count', remainingMs: 300, attempt: 1 },
          f.frame
        );
        finish({
          state: 'read_failed',
          timedOut: true,
          errorClass: 'timeout',
          durationMs: 300,
          remainingMs: 0
        });
        throw Object.assign(new Error('secret must never leave'), {
          code: 'CHECKOUT_CONTROL_READ_FAILED',
          inspection: { ...complete, complete: false, framesFailed: 1 }
        });
      }
    }
  });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedProbe, 'load_precheck');
  assert.equal(result.failedRead.operation, 'load_error_count');
  assert.equal(result.failedRead.frameId, 1);
  assert.equal(result.failureInspection.framesFailed, 1);
  assert.deepEqual(f.calls, ['freeze', 'close']);
  assert.equal(result.pageCloseConfirmed, true);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('incomplete readiness stops without a final scan or another probe', async () => {
  const f = fixture({
    form: {
      async inspectCardReadiness() {
        f.calls.push('ready');
        return {
          ready: false,
          code: 'CHECKOUT_CONTROL_READ_FAILED',
          inspection: { ...complete, complete: false, framesFailed: 1 }
        };
      }
    }
  });
  const result = await f.run();
  assert.equal(result.failedProbe, 'readiness');
  assert.deepEqual(f.calls, ['load', 'prepare', 'ready', 'freeze', 'close']);
});

test('missing candidates in a complete observed scope can settle without asserting absence', async () => {
  let attempts = 0;
  const f = fixture({
    form: {
      async inspectCardReadiness() {
        f.calls.push('ready');
        return {
          ready: ++attempts === 2,
          code: attempts === 2 ? 'CHECKOUT_CARD_READY' : 'CHECKOUT_CARD_NOT_READY',
          inspection: complete
        };
      }
    }
  });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(result.cardReadiness.inspection.framesSkipped, 13);
});

test('official form timeout is a distinct observed result and does not start scanning', async () => {
  const f = fixture();
  f.page.evaluate = async () => ({ formTimeout: true });
  const result = await f.run();
  assert.equal(result.errorCode, 'PAYMENT_FORM_LOAD_TIMEOUT');
  assert.deepEqual(f.calls, ['freeze', 'close']);
});

test('optional preparation read failure stops this diagnostic', async () => {
  const f = fixture({
    prepare: async (_page, options) => {
      f.calls.push('prepare');
      options.onPreparation({
        complete: false,
        operation: 'label_visibility',
        errorClass: 'timeout'
      });
    }
  });
  const result = await f.run();
  assert.equal(result.failedProbe, 'prepare');
  assert.deepEqual(f.calls, ['load', 'prepare', 'freeze', 'close']);
});

test('owner abort freezes a pending probe, closes the owned page, and ignores late completion', async () => {
  let release;
  const owner = new AbortController();
  const f = fixture({
    form: {
      checkoutPageLoadFailed: () =>
        new Promise((resolve) => {
          release = resolve;
        })
    }
  });
  const running = f.run({ signal: owner.signal });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  owner.abort();
  const result = await running,
    before = JSON.stringify(result);
  release(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.errorCode, 'VERIFICATION_CANCELLED');
  assert.equal(result.pageCloseConfirmed, true);
  assert.equal(JSON.stringify(result), before);
  assert.deepEqual(f.calls, ['freeze', 'close']);
});

test('traced readiness retains the normal once-only pure-read retry', async () => {
  let count = 0,
    later = 0;
  const first = {
    parentFrame: () => null,
    getByText: () => ({
      count: async () => {
        count++;
        throw Error('private');
      }
    })
  };
  const second = {
    parentFrame: () => {
      later++;
      return null;
    }
  };
  const page = { isClosed: () => false, frames: () => [first, second] };
  const result = await realForm.inspectCardReadiness(page, {
    deadline: Date.now() + 3000,
    onRead: () => () => {}
  });
  assert.equal(result.code, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(result.inspection.readAttempts, 2);
  assert.equal(count, 2);
  assert.equal(later, 2);
});

test('readonly pre-check and final check recover once and retain both read attempts', async () => {
  let reads = 0;
  const frame = {
    parentFrame: () => null,
    getByText: () => ({
      count: async () => {
        if (++reads % 2 === 1) throw Object.assign(new Error('private'), { name: 'TimeoutError' });
        return 0;
      }
    })
  };
  const f = fixture({
    form: {
      async checkoutPageLoadFailed(page, options) {
        f.calls.push('load');
        return realForm.checkoutPageLoadFailed(page, options);
      }
    }
  });
  f.page.frames = () => [frame];
  f.page.mainFrame = () => frame;
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.stopStage, 'before_payment');
  assert.equal(reads, 4);
  assert.deepEqual(f.calls, ['load', 'prepare', 'ready', 'load', 'freeze']);
  const trace = Array.from(result.trace.reads);
  assert.deepEqual(
    trace.map((row) => row.attempt),
    [1, 2, 1, 2]
  );
  assert.deepEqual(
    trace.map((row) => row.state),
    ['read_failed', 'completed', 'read_failed', 'completed']
  );
  for (const row of trace) {
    assert.equal(row.operation, 'load_error_count');
    assert.ok(row.readBudgetMs > 0 && row.readBudgetMs <= (row.attempt === 1 ? 300 : 1200));
    if (row.attempt === 2) assert.ok(row.readBudgetMs > 300);
  }
  assert.equal(result.paymentClicks, 0);
  assert.equal(result.cardFilled, false);
  assert.equal(f.page.isClosed(), false);
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('readonly pre-check stops after the normal retry also fails', async () => {
  let reads = 0;
  const frame = {
    parentFrame: () => null,
    getByText: () => ({
      count: async () => {
        reads++;
        throw Object.assign(new Error('private'), { name: 'TimeoutError' });
      }
    })
  };
  const f = fixture({
    form: {
      async checkoutPageLoadFailed(page, options) {
        f.calls.push('load');
        return realForm.checkoutPageLoadFailed(page, options);
      }
    }
  });
  f.page.frames = () => [frame];
  f.page.mainFrame = () => frame;
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.failedProbe, 'load_precheck');
  assert.equal(result.errorCode, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(result.failureInspection.readAttempts, 2);
  assert.equal(result.failedRead.attempt, 2);
  assert.equal(reads, 2);
  assert.deepEqual(f.calls, ['load', 'freeze', 'close']);
  assert.equal(result.pageCloseConfirmed, true);
});
