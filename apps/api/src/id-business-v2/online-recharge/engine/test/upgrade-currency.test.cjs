'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateSubscription, resolvePaymentCurrency } = require('../confirmation.cjs');
const { parseUpgradeQuote } = require('../upstream/upgrade-checkout');
const observation = (currency = 'USD', account = 'account-one') =>
  evaluateSubscription('pro_500', 'account-one', {
    ok: true,
    data: { rawPlan: 'plus', upstreamAccountId: account, hasActiveSubscription: true, currency }
  });
const upgrade = (confirmation = observation()) => ({
  allowed: true,
  kind: 'upgrade',
  confirmation
});
test('initial purchases keep configured currency; verified upgrades inherit subscription currency', () => {
  assert.equal(resolvePaymentCurrency({ allowed: true, kind: 'initial' }, 'PHP'), 'PHP');
  assert.equal(resolvePaymentCurrency(upgrade(), 'PHP'), 'USD');
  assert.equal(observation(' usd ').currency, 'USD');
});
test('missing or foreign-account subscription currency cannot authorize an upgrade', () => {
  for (const confirmation of [
    observation(''),
    observation('—'),
    observation('USD', 'other-account'),
    { ...observation(), querySucceeded: false }
  ]) {
    assert.throws(() => resolvePaymentCurrency(upgrade(confirmation), 'PHP'), /原订阅币种/);
    assert.equal(resolvePaymentCurrency(upgrade(confirmation), 'PHP', { debugOnly: true }), null);
  }
  assert.throws(
    () => resolvePaymentCurrency({ allowed: false, kind: 'upgrade' }, 'PHP'),
    /核验未通过/
  );
});
test('the final upgrade dialog must still match the inherited currency and exact tier', () => {
  const currency = resolvePaymentCurrency(upgrade(), 'PHP');
  const text = 'Confirm plan change\nChatGPT Pro 500\nUSD 500.00\nDue today USD 480.00';
  assert.equal(parseUpgradeQuote(text, 'pro_500', currency).amount, '480.00');
  assert.throws(
    () => parseUpgradeQuote(text.replaceAll('USD', 'PHP'), 'pro_500', currency),
    /币种/
  );
  assert.throws(
    () => parseUpgradeQuote(text.replaceAll('Pro 500', 'Pro 200'), 'pro_500', currency),
    /目标档位/
  );
});
