'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../upstream/subscription-check.js'), 'utf8');
const accountId = 'synthetic-account';
const token = 'synthetic-access-for-mocked-transport';
function account(enabled, account = accountId) {
  return {
    accounts: {
      default: {
        account: { account_id: account },
        entitlement: { has_active_subscription: true, subscription_plan: 'plus' },
        last_active_subscription: { will_renew: enabled, purchase_origin_platform: 'web' }
      }
    }
  };
}
function fixture({ reads, postStatus = 200, postThrows = false, guardThrows = false }) {
  let submitted = false;
  let known = 0;
  const posts = [];
  const prepared = [];
  const response = (status, data) => ({ status: () => status, json: async () => data });
  const rpc = {
    beforeExternalSubmit: async (detail) => {
      prepared.push(detail);
      if (guardThrows) throw new Error('synthetic lease rejected');
      submitted = true;
    },
    wasSubmitted: () => submitted,
    recordKnownOutcome: () => {
      known++;
      submitted = false;
    }
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'axios')
        return {
          get: async () => {
            throw new Error('No secondary transport');
          }
        };
      if (name === 'playwright')
        return {
          request: {
            newContext: async () => ({
              get: async () => {
                const next = reads.shift();
                assert.ok(next, 'Unexpected additional readback');
                return response(next.status ?? 200, next.data);
              },
              fetch: async (url, options) => {
                assert.equal(options.method, 'POST');
                posts.push({ url, options });
                if (postThrows) throw new Error('Synthetic response lost');
                return response(postStatus, {});
              },
              dispose: async () => {}
            })
          }
        };
      if (name === './session-auth')
        return { extractProfileFromToken: () => ({ accountId, email: 'fixture@example.invalid' }) };
      if (name === './playwright-proxy')
        return { preparePlaywrightProxy: async () => ({ cleanup: async () => {} }) };
      if (name === '../rpc.cjs') return rpc;
      if (name === '../plans.cjs') return require('../plans.cjs');
      throw new Error(`Unexpected import: ${name}`);
    },
    process: { env: {} },
    Buffer,
    console,
    URL,
    Date
  });
  return { api: module.exports, posts, prepared, submitted: () => submitted, known: () => known };
}

for (const [action, method, enabled] of [
  ['disable', 'cancelAutoRenew', false],
  ['enable', 'resumeAutoRenew', true]
]) {
  test(`${action}: one guarded POST and matching account target readback confirms success`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { data: account(enabled) }] });
    const result = await f.api[method](token);
    assert.equal(result.ok, true);
    assert.equal(result.data.accountId, accountId);
    assert.equal(result.data.autoRenewRaw, enabled);
    assert.equal(f.posts.length, 1);
    assert.equal(f.prepared[0].renewalAction, action);
    assert.equal(f.submitted(), false);
    assert.equal(f.known(), 1);
  });

  test(`${action}: POST 200 with unchanged readback remains unknown and cannot retry`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { data: account(!enabled) }] });
    const result = await f.api[method](token);
    assert.equal(result.ok, false);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.submitted(), true);
    assert.equal(f.known(), 0);
  });

  test(`${action}: readback from another account cannot confirm the mutation`, async () => {
    const f = fixture({
      reads: [{ data: account(!enabled) }, { data: account(enabled, 'other-account') }]
    });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.submitted(), true);
    assert.equal(f.posts.length, 1);
  });

  test(`${action}: unreadable post-submit state remains unknown`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { status: 401, data: {} }] });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.known(), 0);
  });

  test(`${action}: lost POST response never falls back to a second POST`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }], postThrows: true });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.submitted(), true);
  });

  test(`${action}: initial account mismatch and already-target state submit nothing`, async () => {
    const mismatch = fixture({ reads: [{ data: account(!enabled, 'other-account') }] });
    assert.equal((await mismatch.api[method](token)).ok, false);
    assert.equal(mismatch.posts.length, 0);
    assert.equal(mismatch.prepared.length, 0);
    const already = fixture({ reads: [{ data: account(enabled) }] });
    assert.equal((await already.api[method](token)).ok, true);
    assert.equal(already.posts.length, 0);
    assert.equal(already.prepared.length, 0);
  });

  test(`${action}: lease rejection stops before any external POST`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }], guardThrows: true });
    const result = await f.api[method](token);
    assert.equal(result.ok, false);
    assert.equal(Boolean(result.resultUnknown), false);
    assert.equal(f.posts.length, 0);
    assert.equal(f.submitted(), false);
  });

  for (const postStatus of [401, 403]) {
    test(`${action}: explicit ${postStatus} rejection is a known failure`, async () => {
      const f = fixture({ reads: [{ data: account(!enabled) }], postStatus });
      const result = await f.api[method](token);
      assert.equal(result.ok, false);
      assert.equal(result.definitiveFailure, true);
      assert.equal(result.renewalRejected, true);
      assert.equal(f.posts.length, 1);
      assert.equal(f.submitted(), false);
    });
  }
}

test('GET subscription query uses no external-submit guard', async () => {
  const f = fixture({ reads: [{ data: account(true) }] });
  assert.equal((await f.api.querySubscriptionBySession(token)).ok, true);
  assert.equal(f.posts.length, 0);
  assert.equal(f.prepared.length, 0);
});
