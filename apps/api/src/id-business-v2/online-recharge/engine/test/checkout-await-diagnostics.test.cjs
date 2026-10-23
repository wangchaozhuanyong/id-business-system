'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../checkout-await-diagnostics.cjs');
const auth = require('../upstream/auth-page-detect');

test('frozen in-flight probe evidence remains unchanged when the actual operation later fails', async () => {
  let reject;
  const trace = diagnostics.create({ assert() {}, remaining: () => 100 });
  const read = trace.run(
    'login_button',
    () =>
      new Promise((resolve, fail) => {
        reject = fail;
      })
  );
  const frozen = trace.freeze();
  assert.equal(frozen.steps[0].state, 'pending');
  reject(new Error('Target closed after frozen evidence'));
  await assert.rejects(read);
  assert.equal(frozen.steps[0].state, 'pending');
  assert.equal(frozen.steps[0].endedMs, undefined);
});

test('diagnostics store controlled classes and strip content, URLs, titles, and raw errors', async () => {
  const trace = diagnostics.create({ assert() {}, remaining: () => 120 });
  await assert.rejects(
    trace.run('login_link', async () => {
      throw new Error('Execution context was destroyed PRIVATE_SENTINEL');
    })
  );
  const value = trace.freeze();
  const clean = diagnostics.sanitize({
    ...value,
    url: 'PRIVATE_URL',
    title: 'PRIVATE_TITLE',
    steps: value.steps.map((row) => ({ ...row, text: 'PRIVATE_TEXT', error: 'PRIVATE_ERROR' })),
    media: { available: true, busy: true, phase: 'fonts', chainPending: true, url: 'PRIVATE_MEDIA' }
  });
  assert.equal(clean.steps[0].errorClass, 'context_destroyed');
  assert.equal(clean.steps[0].state, 'read_failed');
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE/);
  assert.equal(
    diagnostics.sanitize({ ...value, steps: [{ ...value.steps[0], step: 'PRIVATE_STEP' }] }),
    undefined
  );
});

test('an expired budget starts no underlying operation', async () => {
  let calls = 0;
  const trace = diagnostics.create({
    assert() {
      throw new Error('Expired');
    },
    remaining: () => 0
  });
  await assert.rejects(
    trace.run('navigation', () => {
      calls++;
    })
  );
  assert.equal(calls, 0);
});

test('observed probes keep the same order and matching options without enabling deep text traversal', async () => {
  const labels = [],
    optionsSeen = [];
  const locator = {
    evaluateAll: async (_, options) => {
      optionsSeen.push(options);
      return false;
    }
  };
  const page = {
    url: () => 'https://chatgpt.com/checkout/openai_fixture/cs_test_probe',
    getByRole: () => locator,
    getByText: () => locator,
    isClosed: () => false
  };
  const options = {
    readProbe: async (label, operation) => {
      labels.push(label);
      return operation();
    }
  };
  assert.equal(await auth.isCheckoutLoginGate(page, options), false);
  assert.equal(await auth.hasVisibleLoginChrome(page, options), false);
  assert.equal(labels.length, 13);
  assert.deepEqual(labels.slice(0, 7), [
    'login_button',
    'login_link',
    'signup_button',
    'signup_link',
    'signup_text',
    'tailored_text',
    'login_text'
  ]);
  assert.ok(
    optionsSeen.every(
      (value) => value.excludeConversation === true && value.loginContent === undefined
    )
  );
});

test('observed read failures propagate while unobserved bootstrap callers retain their existing behavior', async () => {
  let calls = 0;
  const page = {
    isClosed: () => false,
    getByRole: () => ({
      evaluateAll: async () => {
        calls++;
        throw new Error('Synthetic read failure');
      }
    }),
    getByText: () => ({
      evaluateAll: async () => {
        calls++;
        throw new Error('Synthetic read failure');
      }
    })
  };
  await assert.rejects(
    auth.hasVisibleLoginChrome(page, { readProbe: (_, operation) => operation() })
  );
  assert.equal(calls, 1);
  assert.equal(await auth.hasVisibleLoginChrome(page), false);
  assert.equal(calls, 7);
});
