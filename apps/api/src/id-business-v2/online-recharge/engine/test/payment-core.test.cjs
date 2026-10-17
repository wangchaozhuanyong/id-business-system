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
stripe.completeStripeCardPayment = async (_, cardInfo, _address, options) => {
  calls.paymentOptions = options;
  calls.cardId = cardInfo.id;
  calls.pay++;
  return responses.shift();
};
address.pickBillingAddressForCheckout = async () => {
  calls.addressSelection++;
  return {
    id: 'synthetic-address',
    line1: 'Synthetic street',
    city: 'Synthetic',
    state: 'DE'
  };
};
address.markAddressBound = async () => {
  calls.addressBound++;
};
store.getPaymentRegion = async () => 'PH';
store.getAppConfigValue = async () => null;
store.reserveCard = async (_, excluded, options) => {
  calls.requireCvc = options?.requireCvc;
  calls.reserve++;
  assert.equal(excluded.length, calls.reserve - 1);
  return {
    id: `synthetic-card-${calls.reserve}`,
    card_number: '4242424242424242',
    card_cvc: '123',
    card_expiry: '12/29'
  };
};
store.bindCardPaymentProfile = async () => {
  calls.profileBind++;
};
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
  calls = {
    reserve: 0,
    pay: 0,
    usage: 0,
    decline: 0,
    release: 0,
    bills: [],
    addressSelection: 0,
    addressBound: 0,
    profileBind: 0
  };
  rpc.configureTask({ id: 'synthetic-payment' });
});
test.afterEach(() => {
  rpc.setTransportForTest(null);
  rpc.clearTask();
});
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
    {
      success: true,
      dueAmount: '200.25',
      dueCurrency: 'PHP',
      paymentEvidence: { verified: true, amount: '200.25', currency: 'PHP' }
    }
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

test('ambiguous page after charge is resolved from the original authenticated subscription once', async () => {
  responses = [
    {
      success: false,
      resultUnknown: true,
      error: 'Your plan change could not be completed. Please try again.'
    }
  ];
  let queries = 0;
  const confirmation = {
    verified: true,
    expectedAccountId: 'synthetic-account',
    accountId: 'synthetic-account',
    targetPlan: 'plus'
  };
  const result = await executePaymentWithRetry(
    {},
    {
      planType: 'plus',
      confirmPayment: async () => {
        queries++;
        return confirmation;
      }
    }
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(result.confirmation, confirmation);
  assert.equal(queries, 1);
  assert.equal(calls.reserve, 1);
  assert.equal(calls.pay, 1);
  assert.equal(calls.decline, 0);
  assert.deepEqual(
    calls.bills.map((bill) => bill.status),
    ['success']
  );
});

test('unconfirmed ambiguous original payment cannot release a card, write a failed bill or rotate', async () => {
  rpc.setTransportForTest(async () => ({ ok: true }));
  await rpc.beforeExternalSubmit({});
  responses = [{ success: false, resultUnknown: true, error: 'payment failed' }];
  try {
    await assert.rejects(
      () =>
        executePaymentWithRetry(
          {},
          {
            planType: 'plus',
            confirmPayment: async () => ({ verified: false, querySucceeded: true })
          }
        ),
      (error) => error.code === 'RESULT_UNKNOWN'
    );
    assert.equal(calls.reserve, 1);
    assert.equal(calls.pay, 1);
    assert.equal(calls.release, 0);
    assert.equal(calls.decline, 0);
    assert.equal(calls.bills.length, 0);
    assert.equal(rpc.wasSubmitted(), true);
  } finally {
    rpc.setTransportForTest(null);
  }
});

test('a page success without exact subscription confirmation never writes a successful bill', async () => {
  responses = [{ success: true, dueAmount: '10.25', dueCurrency: 'PHP' }];
  await assert.rejects(
    () =>
      executePaymentWithRetry(
        {},
        {
          planType: 'plus',
          confirmPayment: async () => ({ verified: false, querySucceeded: true })
        }
      ),
    (error) => error.code === 'RESULT_UNKNOWN'
  );
  assert.equal(calls.usage, 0);
  assert.equal(calls.bills.length, 0);
  assert.equal(calls.reserve, 1);
});

test('an account mismatch after a rejection stops rather than submitting another card', async () => {
  responses = [{ success: false, declined: true, error: 'card_declined' }];
  await assert.rejects(
    () =>
      executePaymentWithRetry(
        {},
        {
          planType: 'plus',
          confirmPayment: async () => ({
            verified: false,
            querySucceeded: true,
            accountId: 'other',
            expectedAccountId: 'original'
          })
        }
      ),
    (error) => error.code === 'RESULT_UNKNOWN'
  );
  assert.equal(calls.reserve, 1);
  assert.equal(calls.decline, 0);
});

test('authenticated subscription verification failure leaves an ambiguous payment pending', async () => {
  responses = [{ success: false, resultUnknown: true }];
  await assert.rejects(
    () =>
      executePaymentWithRetry(
        {},
        {
          planType: 'plus',
          confirmPayment: async () => {
            throw new Error('synthetic read timeout');
          }
        }
      ),
    (error) => error.code === 'RESULT_UNKNOWN'
  );
  assert.equal(calls.pay, 1);
  assert.equal(calls.bills.length, 0);
});

const exactUpgradeConfirmation = {
  verified: true,
  tierVerified: true,
  targetPlan: 'pro_500',
  accountId: 'synthetic-account',
  expectedAccountId: 'synthetic-account'
};
const exactUpgradePreflight = {
  allowed: true,
  kind: 'upgrade',
  sourcePlan: 'plus',
  targetPlan: 'pro_500',
  confirmation: exactUpgradeConfirmation
};
const upgradeEvidence = {
  kind: 'upgrade',
  sourcePlan: 'plus',
  targetPlan: 'pro_500',
  accountId: 'synthetic-account',
  cardId: 'synthetic-card-1',
  cardLast4: '4242',
  amount: '100.00',
  currency: 'PHP',
  source: 'subscription_change',
  quoteVerified: true,
  verified: false
};

test('priced upgrade with exact tier change but only a quote stays pending without a bill or card usage', async () => {
  rpc.setTransportForTest(async () => ({ ok: true }));
  await rpc.beforeExternalSubmit({ paymentContext: upgradeEvidence });
  responses = [
    {
      success: false,
      resultUnknown: true,
      dueAmount: '100.00',
      dueCurrency: 'PHP',
      paymentEvidence: upgradeEvidence
    }
  ];
  try {
    const result = await executePaymentWithRetry(
      {},
      {
        planType: 'pro_500',
        operation: 'upgrade',
        preflight: exactUpgradePreflight,
        expectedCurrency: 'PHP',
        confirmPayment: async () => exactUpgradeConfirmation
      }
    );
    assert.equal(result.resultUnknown, true);
    assert.equal(result.confirmedPaid, false);
    assert.equal(result.subscriptionChangedVerified, true);
    assert.equal(calls.usage, 0);
    assert.equal(calls.bills.length, 0);
    assert.equal(calls.pay, 1);
    assert.equal(calls.reserve, 1);
    assert.equal(calls.requireCvc, false);
    assert.equal(calls.paymentOptions.planType, 'pro_500');
    assert.equal(calls.cardId, 'synthetic-card-1');
  } finally {
    rpc.setTransportForTest(null);
  }
});

test('zero due upgrade confirms only subscription change and never creates a payment bill', async () => {
  rpc.setTransportForTest(async () => ({ ok: true }));
  await rpc.beforeExternalSubmit({});
  responses = [
    {
      success: false,
      resultUnknown: true,
      dueAmount: '0.00',
      dueCurrency: 'PHP',
      paymentEvidence: { ...upgradeEvidence, amount: '0.00', verified: true }
    }
  ];
  try {
    const result = await executePaymentWithRetry(
      {},
      {
        planType: 'pro_500',
        operation: 'upgrade',
        preflight: exactUpgradePreflight,
        expectedCurrency: 'PHP',
        confirmPayment: async () => exactUpgradeConfirmation
      }
    );
    assert.equal(result.success, true);
    assert.equal(result.confirmedPaid, false);
    assert.equal(result.subscriptionChangedVerified, true);
    assert.equal(calls.usage, 0);
    assert.equal(calls.bills.length, 0);
    assert.equal(calls.pay, 1);
    assert.equal(calls.decline, 0);
  } finally {
    rpc.setTransportForTest(null);
  }
});

test('new payment contract allows only one card even after an explicit decline', async () => {
  responses = [{ success: false, declined: true, error: 'card_declined' }, { success: true }];
  const result = await executePaymentWithRetry(
    {},
    {
      planType: 'plus',
      operation: 'initial',
      preflight: { allowed: true, kind: 'initial', sourcePlan: 'free', targetPlan: 'plus' },
      confirmPayment: async () => ({ verified: false, querySucceeded: true })
    }
  );
  assert.equal(result.success, false);
  assert.equal(calls.reserve, 1);
  assert.equal(calls.pay, 1);
  assert.equal(calls.requireCvc, true);
});

test('new payment without exact original-account confirmation is stopped before reserving a card', async () => {
  const result = await executePaymentWithRetry(
    {},
    { planType: 'pro_500', preflight: exactUpgradePreflight, operation: 'upgrade' }
  );
  assert.equal(result.submitted, false);
  assert.equal(calls.reserve, 0);
  assert.equal(calls.pay, 0);
});

test('pending paid receipt runs one bounded subscription query without losing payment evidence', async () => {
  rpc.setTransportForTest(async () => ({ ok: true }));
  await rpc.beforeExternalSubmit({});
  const proof = { ...upgradeEvidence, verified: true };
  responses = [{ success: false, resultUnknown: true, paymentEvidence: proof }];
  let queries = 0;
  const started = performance.now();
  const result = await executePaymentWithRetry(
    {},
    {
      planType: 'pro_500',
      operation: 'upgrade',
      preflight: exactUpgradePreflight,
      confirmPayment: async ({ deadlineAt }) => {
        queries++;
        assert.ok(deadlineAt >= started + 44000 && deadlineAt <= performance.now() + 45000);
        return { verified: false, querySucceeded: false, queryErrorCode: 'NETWORK_TIMEOUT' };
      }
    }
  );
  assert.equal(queries, 1);
  assert.equal(result.confirmedPaid, true);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.paymentEvidence, proof);
  assert.equal(calls.bills.length, 0);
  assert.equal(calls.usage, 0);
  assert.equal(calls.pay, 1);
  assert.equal(calls.release, 0);
});

test('verified paid upgrade preserves the existing saved-card billing profile and address', async () => {
  responses = [
    {
      success: false,
      resultUnknown: true,
      dueAmount: '100.00',
      dueCurrency: 'PHP',
      paymentEvidence: { ...upgradeEvidence, verified: true }
    }
  ];
  const result = await executePaymentWithRetry(
    {},
    {
      planType: 'pro_500',
      operation: 'upgrade',
      preflight: exactUpgradePreflight,
      expectedCurrency: 'PHP',
      confirmPayment: async () => exactUpgradeConfirmation
    }
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(calls.usage, 1);
  assert.equal(calls.bills.length, 1);
  assert.equal(calls.addressSelection, 0);
  assert.equal(calls.profileBind, 0);
  assert.equal(calls.addressBound, 0);
});

test('upgrade new-card checkout surface, CVC and address reach the actual Stripe adapter options', async () => {
  const originalCvc = store.requireCardCvc;
  store.requireCardCvc = async () => '123';
  responses = [{ success: false, error: 'synthetic no submit', canRetryCard: false }];
  try {
    const result = await executePaymentWithRetry(
      {},
      {
        planType: 'pro_500',
        operation: 'upgrade',
        checkoutKind: 'checkout',
        preflight: exactUpgradePreflight,
        expectedCurrency: 'PHP',
        confirmPayment: async () => exactUpgradeConfirmation
      }
    );
    assert.equal(result.success, false);
    assert.equal(calls.paymentOptions.checkoutKind, 'checkout');
    assert.equal(calls.addressSelection, 1);
    assert.equal(calls.requireCvc, false);
  } finally {
    store.requireCardCvc = originalCvc;
  }
});

for (const failure of ['recordCardUsage', 'createBillingRecord'])
  test(`proved new upgrade retains complete reconciliation evidence after ${failure} failure`, async () => {
    const original = store[failure];
    store[failure] = async () => {
      throw new Error('synthetic accounting failure');
    };
    const proof = { ...upgradeEvidence, verified: true };
    responses = [
      {
        success: false,
        resultUnknown: true,
        dueAmount: '100.00',
        dueCurrency: 'PHP',
        paymentEvidence: proof
      }
    ];
    try {
      const result = await executePaymentWithRetry(
        {},
        {
          planType: 'pro_500',
          operation: 'upgrade',
          preflight: exactUpgradePreflight,
          expectedCurrency: 'PHP',
          confirmPayment: async () => exactUpgradeConfirmation
        }
      );
      assert.equal(result.success, false);
      assert.equal(result.resultUnknown, true);
      assert.equal(result.confirmedPaid, true);
      assert.equal(result.localAccountingPending, true);
      assert.equal(result.paymentEvidence, proof);
      assert.equal(result.confirmation, exactUpgradeConfirmation);
      assert.equal(calls.release, 0);
      assert.equal(calls.pay, 1);
    } finally {
      store[failure] = original;
    }
  });
