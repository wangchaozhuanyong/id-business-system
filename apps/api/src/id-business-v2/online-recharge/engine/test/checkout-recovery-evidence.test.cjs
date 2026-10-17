'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const recovery = require('../checkout-recovery.cjs');
const checkoutId = 'cs_test_evidenceOriginal';
const checkoutUrl = `https://chatgpt.com/checkout/openai_fixture/${checkoutId}`;
const source = {
  kind: 'official_checkout_response',
  checkoutId,
  processorEntity: 'openai_fixture'
};
const context = {
  kind: 'initial',
  sourcePlan: 'free',
  targetPlan: 'pro_20x',
  accountId: 'account-fixture',
  cardId: 'card-fixture',
  cardLast4: '4242',
  amount: '8919.64',
  currency: 'PHP',
  quoteId: recovery.quoteIdForUrl(checkoutUrl, source)
};
const original = recovery.buildCheckoutRecovery(checkoutUrl, context, source);
const init = { url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/init`, method: 'POST' };
const intentRead = {
  url: 'https://api.stripe.com/v1/payment_intents/pi_evidenceOriginal',
  method: 'GET'
};
const paidIntent = () => ({
  object: 'payment_intent',
  id: 'pi_evidenceOriginal',
  status: 'succeeded',
  amount_received: 891964,
  currency: 'php'
});
const receipt = () => ({
  object: 'checkout.session',
  id: 'opaque-object-id',
  session_id: checkoutId,
  status: 'complete',
  payment_status: 'paid',
  amount_total: 891964,
  total_summary: { due: 891964 },
  currency: 'php',
  payment_intent: paidIntent()
});
const observer = () =>
  recovery.observePayment(new EventEmitter(), original, { alreadySubmitted: true });

for (const [name, change] of [
  ['checkout amount_total', { amount_total: 891965 }],
  ['checkout amount_total null', { amount_total: null }],
  ['checkout amount_total string', { amount_total: '891964' }],
  ['checkout summary due', { total_summary: { due: 891965 } }],
  ['checkout summary null due', { total_summary: { due: null } }],
  ['checkout summary string due', { total_summary: { due: '891964' } }],
  ['checkout currency', { currency: 'USD' }],
  ['checkout null currency', { currency: null }],
  [
    'nested intent received amount',
    { payment_intent: { ...paidIntent(), amount_received: 891965 } }
  ],
  [
    'nested intent string amount',
    { payment_intent: { ...paidIntent(), amount_received: '891964' } }
  ],
  ['nested intent null amount', { payment_intent: { ...paidIntent(), amount_received: null } }],
  ['nested intent currency', { payment_intent: { ...paidIntent(), currency: 'USD' } }]
]) {
  test(`a valid nested intent cannot override an explicit conflict in ${name}`, async () => {
    const current = observer();
    try {
      await current.accept({ ...receipt(), ...change }, init);
      assert.equal(current.evidence(), null);
      // Neither another same-checkout receipt nor a later intent read can erase this conflict.
      await current.accept(paidIntent(), intentRead);
      await current.accept(receipt(), init);
      assert.equal(current.evidence(), null);
    } finally {
      await current.dispose();
    }
  });
}

test('fully consistent checkout and nested intent evidence remains valid and deduplicated', async () => {
  const current = observer();
  try {
    await current.accept(receipt(), init);
    const first = current.evidence();
    assert.equal(first.verified, true);
    assert.equal(first.amount, '8919.64');
    assert.equal(first.currency, 'PHP');
    await current.accept(receipt(), init);
    assert.equal(current.evidence(), first);
  } finally {
    await current.dispose();
  }
});

test('a linked pending intent with no received payment is not a contradictory paid receipt', async () => {
  const current = observer();
  try {
    await current.accept(
      {
        session_id: checkoutId,
        payment_intent: { ...paidIntent(), status: 'requires_action', amount_received: 0 }
      },
      init
    );
    assert.equal(current.evidence(), null);
    await current.accept(paidIntent(), intentRead);
    assert.equal(current.evidence().verified, true);
  } finally {
    await current.dispose();
  }
});

test('missing monetary facts do not poison a linked intent before its completed receipt', async () => {
  const current = observer();
  try {
    await current.accept({ session_id: checkoutId, payment_intent: 'pi_evidenceOriginal' }, init);
    await current.accept(
      {
        ...paidIntent(),
        amount_received: undefined,
        amount_total: undefined,
        total_summary: { due: undefined },
        currency: undefined
      },
      intentRead
    );
    assert.equal(current.evidence(), null);
    await current.accept(paidIntent(), intentRead);
    assert.equal(current.evidence().verified, true);
  } finally {
    await current.dispose();
  }
});

test('a conflict after an earlier clean intent link still blocks a later matching intent GET', async () => {
  const current = observer();
  try {
    await current.accept({ session_id: checkoutId, payment_intent: 'pi_evidenceOriginal' }, init);
    await current.accept({ ...receipt(), amount_total: 891965 }, init);
    await current.accept(paidIntent(), intentRead);
    assert.equal(current.evidence(), null);
  } finally {
    await current.dispose();
  }
});

test('wrong original sessions and unrelated hosts cannot poison the correct checkout', async () => {
  const current = observer();
  try {
    await current.accept(
      { ...receipt(), session_id: 'cs_test_anotherOriginal', currency: 'usd' },
      init
    );
    await current.accept(
      { ...receipt(), currency: 'usd' },
      { ...init, url: init.url.replace('api.stripe.com', 'evil.invalid') }
    );
    await current.accept(receipt(), init);
    assert.equal(current.evidence().verified, true);
  } finally {
    await current.dispose();
  }
});

for (const id of ['cs_test_anotherOriginal', null]) {
  test(`a checkout object with an explicit wrong fallback id ${id} cannot poison the original`, async () => {
    const current = observer();
    try {
      const unrelated = { ...receipt(), id, amount_total: 891965, currency: 'usd' };
      delete unrelated.session_id;
      await current.accept(unrelated, init);
      assert.equal(current.evidence(), null);
      await current.accept(receipt(), init);
      assert.equal(current.evidence().verified, true);
    } finally {
      await current.dispose();
    }
  });
}

test('a different intent response cannot poison a previously linked correct intent', async () => {
  const current = observer();
  try {
    await current.accept({ session_id: checkoutId, payment_intent: 'pi_evidenceOriginal' }, init);
    await current.accept({ ...paidIntent(), id: 'pi_other', currency: 'usd' }, intentRead);
    await current.accept(
      { ...receipt(), payment_intent: { ...paidIntent(), id: 'pi_other', currency: 'usd' } },
      init
    );
    await current.accept(paidIntent(), intentRead);
    assert.equal(current.evidence().verified, true);
  } finally {
    await current.dispose();
  }
});

test('a later trusted same-checkout monetary conflict invalidates this observation window', async () => {
  const current = observer();
  try {
    await current.accept(receipt(), init);
    assert.equal(current.evidence().verified, true);
    await current.accept({ ...receipt(), currency: 'usd' }, init);
    assert.equal(current.evidence(), null);
    await current.accept(receipt(), init);
    assert.equal(current.evidence(), null);
  } finally {
    await current.dispose();
  }
});

for (const change of [{ amount_total: 891965 }, { currency: 'usd' }]) {
  test(`a different nested intent cannot hide the original checkout conflict ${JSON.stringify(change)}`, async () => {
    const current = observer();
    try {
      await current.accept({ session_id: checkoutId, payment_intent: 'pi_evidenceOriginal' }, init);
      await current.accept(
        { ...receipt(), ...change, payment_intent: { ...paidIntent(), id: 'pi_other' } },
        init
      );
      await current.accept(paidIntent(), intentRead);
      await current.accept(receipt(), init);
      assert.equal(current.evidence(), null);
    } finally {
      await current.dispose();
    }
  });
}
