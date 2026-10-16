'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recheck } = require('../confirmation.cjs');
const accountId = 'synthetic-renewal-account';
const token = `fixture.${Buffer.from(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId }
  })
).toString('base64url')}.unused`;
const task = (action) => ({
  id: 'synthetic-recheck',
  operation: 'subscription',
  plan: 'plus',
  provider: 'local',
  session: JSON.stringify({ accessToken: token }),
  payload: {
    recheckTaskId: 'synthetic-original',
    originalOperation: 'renewal',
    renewalAction: action
  }
});

for (const action of ['enable', 'disable']) {
  test(`${action}: original renewal recheck only reads same-account renewal state`, async () => {
    let reads = 0;
    const result = await recheck(
      task(action),
      {},
      {
        query: async (accessToken, options) => {
          reads++;
          assert.equal(accessToken, token);
          assert.equal(options.timezoneOffsetMin, 480);
          return {
            ok: true,
            data: {
              upstreamAccountId: accountId,
              autoRenewRaw: action === 'enable',
              rawPlan: 'plus',
              hasActiveSubscription: true
            }
          };
        },
        client: new Proxy(
          {},
          {
            get() {
              assert.fail('Renewal recheck cannot query or submit provider orders');
            }
          }
        )
      }
    );
    assert.equal(reads, 1);
    assert.equal(result.success, true);
    assert.equal(result.renewalVerified, true);
    assert.equal(result.confirmedPaid, false);
    assert.equal(result.recheckTaskId, 'synthetic-original');
    assert.equal(result.confirmation, undefined);
  });

  test(`${action}: existing target plan alone, fallback account and wrong renewal state remain unknown`, async () => {
    for (const response of [
      {
        ok: true,
        data: {
          accountId,
          autoRenewRaw: action === 'enable',
          rawPlan: 'plus',
          hasActiveSubscription: true
        }
      },
      { ok: true, data: { upstreamAccountId: 'other-account', autoRenewRaw: action === 'enable' } },
      {
        ok: true,
        data: {
          upstreamAccountId: accountId,
          autoRenewRaw: action !== 'enable',
          rawPlan: 'plus',
          hasActiveSubscription: true
        }
      },
      {
        ok: true,
        data: { upstreamAccountId: accountId, rawPlan: 'plus', hasActiveSubscription: true }
      },
      { ok: false, data: { upstreamAccountId: accountId, autoRenewRaw: action === 'enable' } }
    ]) {
      const result = await recheck(task(action), {}, { query: async () => response });
      assert.equal(result.success, false);
      assert.equal(result.resultUnknown, true);
      assert.equal(result.confirmedPaid, false);
      assert.equal(result.renewalVerified, false);
    }
  });
}

test('invalid original renewal action cannot query or mutate the account', async () => {
  const result = await recheck(
    task('check'),
    {},
    { query: async () => assert.fail('Invalid action must not query') }
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(result.confirmedPaid, false);
});

test('read transport error leaves original renewal unknown and never retries POST', async () => {
  let reads = 0;
  const result = await recheck(
    task('disable'),
    {},
    {
      query: async () => {
        reads++;
        throw new Error('Synthetic transport loss');
      }
    }
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(result.confirmedPaid, false);
  assert.equal(reads, 1);
});

test('lease loss is preserved for the task runner to stop immediately', async () => {
  await assert.rejects(
    () =>
      recheck(
        task('disable'),
        {},
        {
          query: async () => {
            throw Object.assign(new Error('Synthetic lost lease'), { code: 'LEASE_LOST' });
          }
        }
      ),
    { code: 'LEASE_LOST' }
  );
});
