'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recheck } = require('../confirmation.cjs');
const accountId = '11111111-1111-4111-8111-111111111111';
const token =
  'fixture.' +
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId }
    })
  ).toString('base64url') +
  '.unused';
const context = {
  kind: 'initial',
  sourcePlan: 'free',
  targetPlan: 'pro_20x',
  accountId,
  cardId: '22222222-2222-4222-8222-222222222222',
  cardLast4: '4242',
  amount: '8919.64',
  currency: 'PHP',
  quoteId: 'quote:00000000000000000000000000000000'
};
const evidence = { ...context, source: 'checkout', quoteVerified: true, verified: true };
function task(extra = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    operation: 'subscription',
    plan: 'pro_20x',
    provider: 'local',
    session: JSON.stringify({ accessToken: token }),
    payload: {
      recheckTaskId: '44444444-4444-4444-8444-444444444444',
      originalProvider: 'local',
      originalOperation: 'recharge',
      paymentContext: context,
      ...extra
    }
  };
}
function paidPlan() {
  return {
    ok: true,
    data: {
      upstreamAccountId: accountId,
      rawPlan: 'pro_20x',
      hasActiveSubscription: true,
      queriedAt: '2026-10-17T00:00:00Z',
      currency: 'PHP'
    }
  };
}
test('query failure takes precedence over missing receipt and never claims that the subscription was checked', async () => {
  const result = await recheck(
    task(),
    {},
    {
      getCheckoutRecovery: async () => ({ checkoutRecovery: null }),
      query: async () => ({
        ok: false,
        errorCode: 'NETWORK_UNAVAILABLE',
        error: '订阅查询网络不可用，本次未取得账号订阅结果'
      })
    }
  );
  assert.equal(result.reconciliationReason, 'SUBSCRIPTION_QUERY_FAILED');
  assert.equal(result.confirmation.querySucceeded, false);
  assert.equal(result.confirmation.queryErrorCode, 'NETWORK_UNAVAILABLE');
  assert.match(result.error, /未取得账号订阅结果/);
  assert.doesNotMatch(result.error, /已核对订阅/);
  assert.equal(result.confirmedPaid, false);
  assert.equal(result.resultUnknown, true);
});
test('a target subscription without original payment evidence never resolves a legacy original payment', async () => {
  const result = await recheck(
    task(),
    {},
    { getCheckoutRecovery: async () => ({ checkoutRecovery: null }), query: paidPlan }
  );
  assert.equal(result.confirmation.verified, true);
  assert.equal(result.reconciliationReason, 'LEGACY_ORIGINAL_IDENTITY_MISSING');
  assert.equal(result.confirmedPaid, false);
  assert.equal(result.success, false);
  assert.equal(result.resultUnknown, true);
});
test('original recovery uses only the lease-bound RPC and the frozen payment context', async () => {
  let reads = 0,
    recoveries = 0;
  const recoveryFixture = { version: 1, syntheticFixture: true };
  const result = await recheck(
    task(),
    {},
    {
      getCheckoutRecovery: async (...args) => {
        assert.equal(args.length, 0);
        reads++;
        return { checkoutRecovery: recoveryFixture };
      },
      recoverOriginalPayment: async (value, options) => {
        recoveries++;
        assert.equal(value, recoveryFixture);
        assert.equal(options.paymentContext, context);
        assert.equal(typeof options.deadlineAt, 'number');
        return { paymentEvidence: evidence, reason: null };
      },
      query: paidPlan
    }
  );
  assert.equal(reads, 1);
  assert.equal(recoveries, 1);
  assert.equal(result.confirmedPaid, true);
  assert.equal(result.success, true);
  assert.equal(result.resultUnknown, false);
});
test('verified payment facts survive while exact target activation is still unknown', async () => {
  const result = await recheck(
    task(),
    {},
    {
      getCheckoutRecovery: async () => ({}),
      recoverOriginalPayment: async () => ({ paymentEvidence: evidence }),
      query: async () => ({ ok: false, errorCode: 'NETWORK_TIMEOUT', error: '查询超时' })
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.confirmedPaid, true);
  assert.equal(result.paymentEvidence, evidence);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.reconciliationReason, 'SUBSCRIPTION_QUERY_FAILED');
});
test('a stale amount, quote, card or currency cannot confirm the original payment', async () => {
  for (const changed of [
    { amount: '9990' },
    { currency: 'USD' },
    { cardId: 'other-card' },
    { quoteId: 'quote:11111111111111111111111111111111' },
    { accountId: 'other-account' }
  ]) {
    const result = await recheck(
      task(),
      {},
      {
        getCheckoutRecovery: async () => ({}),
        recoverOriginalPayment: async () => ({ paymentEvidence: { ...evidence, ...changed } }),
        query: paidPlan
      }
    );
    assert.equal(result.success, false);
    assert.equal(result.confirmedPaid, false);
    assert.equal(result.resultUnknown, true);
  }
});
test('already verified original receipt is reused without another checkout read or external write', async () => {
  const result = await recheck(
    task({ originalPaymentEvidence: evidence }),
    {},
    {
      getCheckoutRecovery: async () => assert.fail('Existing receipt must not be discarded'),
      query: paidPlan
    }
  );
  assert.equal(result.success, true);
  assert.equal(result.confirmedPaid, true);
});
test('free/open state is not a conclusive non-charge result after one payment submission', async () => {
  const result = await recheck(
    task(),
    {},
    {
      getCheckoutRecovery: async () => null,
      query: async () => ({
        ok: true,
        data: {
          upstreamAccountId: accountId,
          rawPlan: 'chatgptfreeplan',
          hasActiveSubscription: false
        }
      })
    }
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(result.success, false);
  assert.equal(result.confirmedPaid, false);
  assert.equal(result.definitiveFailure, undefined);
});
test('lease loss during original recovery is propagated and never followed by a query or payment', async () => {
  await assert.rejects(
    () =>
      recheck(
        task(),
        {},
        {
          getCheckoutRecovery: async () => {
            throw Object.assign(new Error('stopped'), { code: 'LEASE_LOST' });
          },
          query: async () => assert.fail('Lost lease must stop the entire recovery')
        }
      ),
    { code: 'LEASE_LOST' }
  );
});
test('original automatic verification failure retains its exact code without launching a second login', async () => {
  const result = await recheck(
    task(),
    {},
    {
      getCheckoutRecovery: async () => ({}),
      recoverOriginalPayment: async () => ({
        reason: 'VERIFICATION_UNSUPPORTED',
        paymentEvidence: null,
        queryFailure: {
          ok: false,
          errorCode: 'VERIFICATION_UNSUPPORTED',
          error: '原单读取所需的自动验证未完成',
          verificationDiagnostics: { state: 'unsupported', solverCode: 'UNSUPPORTED' }
        }
      }),
      query: async () =>
        assert.fail('A failed automatic challenge must not start another browser login')
    }
  );
  assert.equal(result.confirmation.querySucceeded, false);
  assert.equal(result.confirmation.queryErrorCode, 'VERIFICATION_UNSUPPORTED');
  assert.equal(result.confirmation.verificationDiagnostics.solverCode, 'UNSUPPORTED');
  assert.equal(result.resultUnknown, true);
  assert.equal(result.confirmedPaid, false);
});
