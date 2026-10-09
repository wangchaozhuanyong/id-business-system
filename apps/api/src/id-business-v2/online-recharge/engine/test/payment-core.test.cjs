'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rpc = require('../rpc.cjs');
const store = require('../upstream/mysql-store');
const stripe = require('../upstream/stripe-payment');
const address = require('../upstream/tax-free-address');
let responses, calls;
stripe.readCheckoutDueAmount = async () => null;
stripe.estimateTaxFreeAmount = () => {
  throw new Error('estimate must never become billing fact');
};
stripe.completeStripeCardPayment = async () => {
  calls.pay++;
  return responses.shift();
};
address.pickBillingAddressForCheckout = async () => ({
  id: 'synthetic-address',
  line1: 'Synthetic street',
  city: 'Synthetic',
  state: 'DE'
});
address.markAddressBound = async () => {};
store.getPaymentRegion = async () => 'PH';
store.getAppConfigValue = async () => null;
store.reserveCard = async (_, excluded) => {
  calls.reserve++;
  assert.equal(excluded.length, calls.reserve - 1);
  return {
    id: `synthetic-card-${calls.reserve}`,
    card_number: '4242424242424242',
    card_cvc: '123',
    card_expiry: '12/29'
  };
};
store.bindCardPaymentProfile = async () => {};
store.recordCardUsage = async () => {
  calls.usage++;
  return { exhausted: false };
};
store.recordCardDecline = async () => {
  calls.decline++;
  return { declineCount: calls.decline };
};
store.createBillingRecord = async (input) => {
  calls.bills.push(input);
};
store.releaseCard = async () => {
  calls.release++;
};
const { executePaymentWithRetry } = require('../upstream/payment-retry');
test.beforeEach(() => {
  calls = { reserve: 0, pay: 0, usage: 0, decline: 0, release: 0, bills: [] };
  rpc.configureTask({ id: 'synthetic-payment' });
});
test.afterEach(() => rpc.clearTask());
test('actual local core never rotates cards after an unknown payment result', async () => {
  responses = [
    { success: false, resultUnknown: true, error: 'synthetic timeout' },
    { success: true }
  ];
  await assert.rejects(
    () => executePaymentWithRetry({}, { planType: 'plus' }),
    (e) => e.code === 'RESULT_UNKNOWN'
  );
  assert.equal(calls.reserve, 1);
  assert.equal(calls.pay, 1);
  assert.equal(calls.decline, 0);
  assert.equal(calls.bills.length, 0);
});
test('actual local core retains original max-three decline card rotation', async () => {
  responses = [
    { success: false, declined: true, error: 'card_declined' },
    { success: false, declined: true, error: 'card_declined' },
    { success: true, dueAmount: '200.25', dueCurrency: 'PHP' }
  ];
  const result = await executePaymentWithRetry({}, { planType: 'plus' });
  assert.equal(result.success, true);
  assert.equal(calls.reserve, 3);
  assert.equal(calls.pay, 3);
  assert.equal(calls.decline, 2);
  assert.equal(calls.usage, 1);
  assert.equal(calls.bills.at(-1).amount, '200.25');
});
test('actual local core writes an unknown amount without any tax estimate', async () => {
  responses = [{ success: true }];
  const result = await executePaymentWithRetry({}, { planType: 'plus' });
  assert.equal(result.success, true);
  assert.equal(calls.bills.at(-1).amount, null);
  assert.equal(calls.bills.at(-1).amountSource, 'unknown');
});
test('confirmed payment followed by internal write failure remains protected from retry', async () => {
  responses = [{ success: true, dueAmount: '10.00' }];
  const original = store.bindCardPaymentProfile;
  store.bindCardPaymentProfile = async () => {
    throw new Error('synthetic write failure');
  };
  try {
    await assert.rejects(() => executePaymentWithRetry({}, { planType: 'plus' }));
    assert.equal(rpc.wasPaymentConfirmed(), true);
    assert.equal(calls.pay, 1);
    assert.equal(calls.release, 0);
  } finally {
    store.bindCardPaymentProfile = original;
  }
});
for (const failure of ['recordCardUsage', 'createBillingRecord'])
  test(`confirmed payment retains card after ${failure} fails`, async () => {
    responses = [{ success: true, dueAmount: '10.00' }];
    const original = store[failure];
    store[failure] = async () => {
      throw new Error('synthetic write failure');
    };
    try {
      await assert.rejects(() => executePaymentWithRetry({}, { planType: 'plus' }));
      assert.equal(rpc.wasPaymentConfirmed(), true);
      assert.equal(calls.pay, 1);
      assert.equal(calls.release, 0);
    } finally {
      store[failure] = original;
    }
  });
