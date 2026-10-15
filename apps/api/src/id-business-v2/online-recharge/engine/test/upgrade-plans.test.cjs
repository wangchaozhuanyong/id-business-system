'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const plans = require('../plans.cjs');
const { evaluateSubscription, preflightPayment } = require('../confirmation.cjs');
const { parseAccountCheckResponse } = require('../upstream/subscription-check');
const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.x`;
const query =
  (rawPlan, active = true, account = 'synthetic-account') =>
  async () => ({
    ok: true,
    data: { upstreamAccountId: account, rawPlan, hasActiveSubscription: active }
  });
test('unknown targets never fall back to Plus; Pro500 API identity is not guessed', () => {
  assert.throws(() => plans.resolveApiPlanName('pro_500'), /尚未核实/);
  assert.throws(() => plans.resolveApiPlanName('future-plan'), /不支持/);
  assert.equal(plans.resolveApiPlanName('pro_5x'), 'chatgptprolite');
});
for (const [source, target] of [
  ['plus', 'pro_5x'],
  ['plus', 'pro_20x'],
  ['plus', 'pro_500'],
  ['pro_5x', 'pro_20x'],
  ['pro_5x', 'pro_500'],
  ['pro_20x', 'pro_500']
]) {
  test(`${source} -> ${target} is explicitly classified as upgrade`, async () => {
    const result = await preflightPayment(target, token, {
      query: query(source),
      pro500Name: 'synthetic-verified-product'
    });
    assert.equal(result.allowed, true);
    assert.equal(result.kind, 'upgrade');
    assert.equal(result.sourcePlan, source);
    assert.equal(result.targetPlan, target);
  });
}
test('free account can start Pro500 only with an explicit verified identity mapping', async () => {
  const result = await preflightPayment('pro_500', token, {
    query: query('', false),
    pro500Name: 'synthetic-verified-product'
  });
  assert.equal(result.allowed, true);
  assert.equal(result.kind, 'initial');
});
test('the observed official free-plan identifier allows an initial Pro500 preview after account checks', async () => {
  const data = parseAccountCheckResponse({
    accounts: {
      default: {
        account: { account_id: 'synthetic-account' },
        entitlement: { subscription_plan: 'chatgptfreeplan', has_active_subscription: false }
      }
    }
  });
  const result = await preflightPayment('pro_500', token, {
    allowUnverifiedTarget: true,
    query: async () => ({ ok: true, data })
  });
  assert.equal(result.allowed, true);
  assert.equal(result.kind, 'initial');
  assert.equal(result.sourcePlan, 'free');
  assert.equal(result.confirmation.observedPlan, 'chatgptfreeplan');
});
test('free-plan alias does not admit active, foreign-account or unknown free-like states', async () => {
  for (const [raw, active, account] of [
    ['chatgptfreeplan', true, 'synthetic-account'],
    ['chatgptfreeplan', null, 'synthetic-account'],
    ['free', true, 'synthetic-account'],
    ['chatgptfreeplan', false, 'other-account'],
    ['chatgptfreeplan_future', false, 'synthetic-account']
  ]) {
    const result = await preflightPayment('pro_500', token, {
      allowUnverifiedTarget: true,
      query: query(raw, active, account)
    });
    assert.equal(result.allowed, false);
  }
  assert.equal(
    plans.observedCanonicalPlan('chatgptfreeplan', { pro500Name: 'chatgptfreeplan' }),
    null
  );
  const invalidMapping = await preflightPayment('pro_500', token, {
    pro500Name: 'chatgptfreeplan',
    query: query('chatgptfreeplan', false)
  });
  assert.equal(invalidMapping.allowed, false);
});
test('same tier, downgrade, wrong account, vague Pro and inconsistent free state stop before payment', async () => {
  for (const [source, target, active, account] of [
    ['pro_500', 'pro_500', true],
    ['pro_500', 'pro_20x', true],
    ['pro_20x', 'plus', true],
    ['pro', 'pro_500', true],
    ['chatgptpro', 'pro_500', true],
    ['go', 'pro_500', true],
    ['plus', 'pro_500', false],
    ['free', 'pro_500', false, 'another-account']
  ]) {
    const result = await preflightPayment(target, token, {
      query: query(source, active, account),
      pro500Name: 'synthetic-verified-product'
    });
    assert.equal(result.allowed, false, source);
  }
});
test('missing or conflicting Pro500 mapping stops real execution but permits read-only payment preview', async () => {
  let reads = 0;
  for (const pro500Name of ['', 'pro', 'chatgptpro', 'chatgptprolite']) {
    const result = await preflightPayment('pro_500', token, {
      pro500Name,
      query: async () => {
        reads++;
        return query('plus')();
      }
    });
    assert.equal(result.allowed, false);
  }
  assert.equal(reads, 0);
  const preview = await preflightPayment('pro_500', token, {
    query: query('plus'),
    allowUnverifiedTarget: true
  });
  assert.equal(preview.allowed, true);
  assert.equal(preview.kind, 'upgrade');
});
test('precise tiers are required for confirmation, not a general Pro label or a price', () => {
  for (const rawPlan of ['pro', 'chatgptpro', 'unknown', '500']) {
    const result = evaluateSubscription('pro_500', 'synthetic-account', {
      ok: true,
      data: {
        rawPlan,
        upstreamAccountId: 'synthetic-account',
        hasActiveSubscription: true,
        currency: 'USD',
        amount: '500'
      }
    });
    assert.equal(result.verified, false);
  }
  assert.equal(
    plans.observedCanonicalPlan('synthetic-verified-product', {
      pro500Name: 'synthetic-verified-product'
    }),
    'pro_500'
  );
  assert.equal(plans.observedCanonicalPlan('chatgptpro', { pro500Name: 'chatgptpro' }), null);
});
test('account response retains precise known tier and leaves general Pro unknown', () => {
  const parse = (subscription_plan) =>
    parseAccountCheckResponse({
      accounts: {
        default: {
          account: { account_id: 'synthetic-account' },
          entitlement: { subscription_plan, has_active_subscription: true }
        }
      }
    });
  assert.equal(parse('chatgptprolite').canonicalPlan, 'pro_5x');
  assert.equal(parse('chatgptpro').tierVerified, false);
});
test('saved-card reservation does not request a CVC until the website needs it', async () => {
  const store = require('../upstream/mysql-store');
  const rpc = require('../rpc.cjs');
  const credential = require('../credential-client.cjs');
  let requested = 0;
  const calls = [];
  rpc.configureTask({
    id: 'synthetic-task',
    workerId: 'synthetic-worker',
    leaseId: 'lease',
    leaseVersion: 1
  });
  rpc.setTransportForTest(async (method, args) => {
    calls.push([method, args]);
    return {
      id: 'synthetic-card',
      card_number: '4242424242424242',
      card_expiry: '12/29',
      leaseId: 'card-lease',
      leaseVersion: 1
    };
  });
  credential.setRequesterForTest(() => {
    requested++;
    return '';
  });
  try {
    const card = await store.reserveCard('synthetic-task', [], { requireCvc: false });
    assert.equal(requested, 0);
    assert.equal(card.card_cvc, '');
    assert.equal(calls[0][1].requireCvc, false);
    await assert.rejects(() => store.requireCardCvc(card.id), { code: 'PENDING_CREDENTIALS' });
    assert.equal(requested, 1);
    assert.equal(calls.at(-1)[1].requireCvc, true);
  } finally {
    store.clearCredentials();
    rpc.setTransportForTest(null);
    rpc.clearTask();
    credential.setRequesterForTest(null);
  }
});
test('upgrade recheck never turns a quote and an active target into a paid invoice', async () => {
  const { recheck } = require('../confirmation.cjs');
  const context = {
    kind: 'upgrade',
    sourcePlan: 'plus',
    targetPlan: 'pro_500',
    accountId: 'synthetic-account',
    cardId: 'synthetic-card',
    cardLast4: '4242',
    amount: '480.00',
    currency: 'USD'
  };
  const original = {
    plan: 'pro_500',
    provider: 'local',
    session: JSON.stringify({ accessToken: token }),
    payload: { targetPlan: 'pro_500', paymentContext: context, recheckTaskId: 'synthetic-original' }
  };
  for (const evidence of [
    undefined,
    { ...context, quoteVerified: true },
    { ...context, verified: true, source: 'subscription_change', amount: '500' }
  ]) {
    const out = await recheck(
      { ...original, payload: { ...original.payload, originalPaymentEvidence: evidence } },
      {},
      { query: query('pro_500') }
    );
    assert.equal(out.success, false);
    assert.equal(out.confirmedPaid, false);
    assert.equal(out.resultUnknown, true);
  }
  const out = await recheck(
    {
      ...original,
      payload: {
        ...original.payload,
        originalPaymentEvidence: { ...context, verified: true, source: 'subscription_change' }
      }
    },
    {},
    { query: query('pro_500') }
  );
  assert.equal(out.success, true);
  assert.equal(out.confirmedPaid, true);
  const zero = { ...context, amount: '0.00' };
  const free = await recheck(
    {
      ...original,
      payload: {
        ...original.payload,
        paymentContext: zero,
        originalPaymentEvidence: { ...zero, verified: true, source: 'subscription_change' }
      }
    },
    {},
    { query: query('pro_500') }
  );
  assert.equal(free.success, true);
  assert.equal(free.confirmedPaid, false);
});
test('result redaction preserves strictly typed payment identity and hash, never PAN or credentials', () => {
  const { sanitizeResult, redactText } = require('../security.cjs');
  const id = '12345678-1234-4abc-8def-123456789012';
  const quoteId = 'quote:123456789012abcdefabcdefabcdefab';
  const source = {
    paymentEvidence: {
      accountId: id,
      cardId: id,
      quoteId,
      amount: '1234567890123.00',
      cvc: '123',
      card_number: '4242424242424242'
    },
    confirmation: { expectedAccountId: id },
    accessToken: 'synthetic-access-token-not-real',
    cardId: '4242424242424242'
  };
  const clean = sanitizeResult(source);
  assert.equal(clean.paymentEvidence.accountId, id);
  assert.equal(clean.paymentEvidence.quoteId, quoteId);
  assert.equal(clean.paymentEvidence.amount, '1234567890123.00');
  assert.equal(clean.confirmation.expectedAccountId, id);
  assert.notEqual(clean.cardId, source.cardId);
  assert.equal(clean.paymentEvidence.cvc, '[已隐藏]');
  assert.equal(clean.paymentEvidence.card_number, '[已隐藏]');
  assert.equal(clean.accessToken, '[已隐藏]');
  assert.notEqual(redactText(id), id);
});
