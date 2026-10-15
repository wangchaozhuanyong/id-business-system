'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recheck } = require('../confirmation.cjs');

const accountId = 'synthetic-order-sync-account';
const accessToken = `fixture.${Buffer.from(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId }
  })
).toString('base64url')}.unused`;
const original = {
  id: 'synthetic-review',
  operation: 'subscription',
  plan: 'plus',
  provider: 'third_party',
  session: JSON.stringify({ accessToken }),
  payload: {
    originalOperation: 'recharge',
    originalProvider: 'third_party',
    recheckTaskId: 'synthetic-original',
    providerOrderId: 'provider-order-1',
    providerTaskId: 'provider-task-1'
  }
};
const receipt = {
  order_id: 'provider-order-1',
  task_id: 'provider-task-1',
  status: 'success',
  result: { ok: true },
  api_key: 'synthetic-secret',
  card_number: 'synthetic-card',
  card: { number: 4111111111111111 },
  payment: { actual_paid_amount: '250.1250', paid_currency: 'PHP', private_metadata: 'unused' },
  session: { token: 'synthetic-token' }
};
function injected(data = receipt, observedAccountId = accountId) {
  return {
    client: {
      queryTask: async () => ({ success: true, rawStatus: 'success', data }),
      queryOrder: async () => assert.fail('Original task query already has a final result'),
      submitOrder: async () => assert.fail('Read-only recheck cannot submit payment')
    },
    query: async () => ({
      ok: true,
      data: { upstreamAccountId: observedAccountId, rawPlan: 'plus', hasActiveSubscription: true }
    })
  };
}

test('successful original provider recheck retains sanitized receipt for order synchronization', async () => {
  const result = await recheck(original, {}, injected());
  assert.equal(result.success, true);
  assert.equal(result.recheckTaskId, original.payload.recheckTaskId);
  assert.equal(result.providerResult.order_id, receipt.order_id);
  assert.equal(result.providerResult.task_id, receipt.task_id);
  assert.equal(result.providerResult.status, 'success');
  assert.equal(result.providerResult.actual_paid_amount, '250.1250');
  assert.equal(result.providerResult.paid_currency, 'PHP');
  assert.deepEqual(Object.keys(result.providerResult).sort(), [
    'actual_paid_amount',
    'order_id',
    'paid_currency',
    'result',
    'status',
    'task_id'
  ]);
});

test('wrong original provider identity cannot become an order receipt', async () => {
  const result = await recheck(original, {}, injected({ ...receipt, order_id: 'another-order' }));
  assert.equal(result.success, false);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.providerResult, undefined);
});

test('wrong account confirmation cannot publish the provider receipt as success', async () => {
  const result = await recheck(original, {}, injected(receipt, 'another-account'));
  assert.equal(result.success, false);
  assert.equal(result.confirmedPaid, false);
  assert.equal(result.providerResult, undefined);
});
