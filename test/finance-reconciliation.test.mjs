import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createFinanceReconciliation } from '../server/finance/recharge-reconciliation.mjs';
import { createStaffWorkspaces } from '../server/staff-workspaces.mjs';
import { reconciliationFixture } from './helpers/reconciliation-fixture.mjs';

const actor = { id: 'fixture-finance', role: 'finance', email: 'finance@example.test' };
const query = values => new URLSearchParams(values);
const read = (fixture, values = {}, who = actor) => createFinanceReconciliation(fixture.client, fixture.store)(query(values), who);

test('reconciliation returns original full card number, email, current type and explicit payment identifiers', async () => {
  const f = reconciliationFixture();
  Object.assign(f.state.records[0], { card_number: '0000 0000 0000 2468', card_cvc: 'fixture-private',
    cdk_code: 'fixture-code-not-for-display', session: 'fixture-session-not-for-display', error_message: 'fixture-raw-error' });
  const result = await read(f);
  assert.deepEqual(result, { total: 1, hasMore: false, items: [{ reference: '1', time: '2026-11-14T06:00:00.000Z',
    amount: '20.00', currency: 'USD', plan: 'plus', status: 'success', last4: '2468', cardNumber: f.number,
    cardType: '样例虚拟卡', cardTypeState: 'matched', email: 'recharge-1@example.test',
    paymentReference: 'cs_test_reconciliation_1', errorCode: '' }] });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|fixture-code|fixture-session|fixture-raw-error/);
  assert.deepEqual(f.calls, ['/api/admin/billing?page=1', '/api/admin/cards']);
});

test('card type matching uses the whole number and never reconstructs a missing historical number from a suffix', async () => {
  const f = reconciliationFixture(2);
  f.state.cards[1] = { id: 2, card_number: '1000000000002468', last4: '2468' };
  f.state.records[1].card_number = '1000000000002468';
  f.state.records[1].card_last4 = '2468';
  let result = await read(f);
  assert.deepEqual(result.items.map(row => row.cardType), ['样例虚拟卡', '样例 Wise 卡']);
  f.state.records[0].card_number = null;
  f.state.records[0].email = null;
  result = await read(f);
  assert.equal(result.items[0].cardNumber, '');
  assert.equal(result.items[0].cardTypeState, 'missing-number');
  assert.equal(result.items[0].email, '');
});

test('archives preserve deleted-card classification while conflicting identities remain marked for review', async () => {
  const f = reconciliationFixture();
  f.state.cards = [];
  f.archive.data.cards['recharge:1'] = { number: f.number, last4: '2468' };
  f.types.data.items[0].active = false;
  assert.equal((await read(f)).items[0].cardType, '样例虚拟卡');
  f.state.cards = [{ id: 2, card_number: f.number, last4: '2468' }];
  assert.equal((await read(f)).items[0].cardTypeState, 'ambiguous');
  f.state.cards = [{ id: 1, card_number: f.otherNumber, last4: '1357' }];
  assert.equal((await read(f)).items[0].cardTypeState, 'ambiguous');
  f.state.records[0].card_last4 = '9999';
  const row = (await read(f)).items[0];
  assert.equal(row.cardNumber, f.number);
  assert.equal(row.cardType, '');
  assert.equal(row.cardTypeState, 'conflict');
});

test('unknown, unassigned and unavailable classifications remain distinct without losing billing records', async () => {
  const f = reconciliationFixture();
  f.types.data.assignments = {};
  assert.equal((await read(f)).items[0].cardTypeState, 'unassigned');
  f.state.cards = [];
  assert.equal((await read(f)).items[0].cardTypeState, 'unmatched');
  f.state.failCards = true;
  let result = await read(f);
  assert(result.warning);
  assert.equal(result.items[0].cardNumber, f.number);
  assert.equal(result.items[0].cardTypeState, 'unavailable');
  f.store.featureDocument = () => { throw new Error('fixture source unavailable'); };
  result = await read(f);
  assert(result.warning);
  assert.equal(result.items[0].email, 'recharge-1@example.test');
});

test('filters apply upstream before pagination and preserve Beijing date boundaries', async () => {
  const f = reconciliationFixture(45);
  const all = await read(f, { page: 3 });
  assert.equal(all.items.length, 5);
  assert.equal(all.total, 45);
  assert.equal(all.hasMore, false);
  const filtered = await read(f, { from: '2026-11-14', to: '2026-11-14', status: 'failed', plan: 'pro100', last4: '1357' });
  assert(filtered.items.length);
  assert(filtered.items.every(row => row.status === 'failed' && row.plan === 'pro100' && row.last4 === '1357'));
  assert(filtered.items.every(row => row.amount === '0.00' && row.errorCode === 'card_declined'));
  const path = f.calls.find(path => path.includes('start_date'));
  const params = new URL(path, 'https://fixture.invalid').searchParams;
  assert.equal(params.get('start_date'), '2026-11-13 16:00:00.000');
  assert.equal(params.get('end_date'), '2026-11-14 15:59:59.999');
  assert.equal(params.get('status'), 'failed');
  assert.equal(params.get('plan_type'), 'pro100');
  assert.equal(params.get('card_last4'), '1357');
});

test('invalid filters and unauthorized roles are rejected before reading any billing or card data', async () => {
  const f = reconciliationFixture();
  for (const input of [{ page: 0 }, { page: 5001 }, { from: '2026-02-30' }, { from: '2026-11-15', to: '2026-11-14' },
    { status: 'arbitrary' }, { plan: 'unknown' }, { last4: '12' }, { last4: '%2468' }, { last4: f.number }])
    await assert.rejects(read(f, input), { status: 400 });
  for (const role of ['admin', 'supervisor', 'employee', 'registrar', undefined])
    await assert.rejects(read(f, {}, { ...actor, role }), { status: 403 });
  assert.deepEqual(f.calls, []);
  assert.equal((await read(f, {}, { ...actor, role: 'super' })).items[0].cardNumber, f.number);
});

test('large synthetic card pools preserve exact classification and last-page totals', async () => {
  for (const count of [1000, 10000]) {
    const f = reconciliationFixture(count);
    f.state.cards = Array.from({ length: count }, (_, index) => {
      const number = '00000000' + String(index).padStart(8, '0');
      Object.assign(f.state.records[index], { card_number: number, card_last4: number.slice(-4) });
      f.types.data.assignments['recharge:' + (index + 1)] = index % 2 ? 'wise' : 'vcc';
      return { id: index + 1, card_number: number, last4: number.slice(-4) };
    });
    const result = await read(f, { page: count / 20 });
    assert.equal(result.total, count);
    assert.equal(result.hasMore, false);
    assert.equal(result.items.length, 20);
    assert(result.items.every(row => row.cardTypeState === 'matched'));
    assert.equal(result.items.at(-1).cardNumber, f.state.cards.at(-1).card_number);
    assert.equal(result.items.at(-1).cardType, '样例 Wise 卡');
    assert.equal(f.calls.length, 2);
  }
});

test('missing totals and amounts are not converted to zero, and malformed identifier fields are not projected', async () => {
  const f = reconciliationFixture();
  const row = { ...f.state.records[0], amount: null, email: 'not-an-email', stripe_session_id: '{"private":"fixture"}',
    error_code: '<script>fixture</script>' };
  f.client.get = async path => path.startsWith('/api/admin/billing') ? { records: [row], total: null } : { cards: f.state.cards };
  const result = await read(f);
  assert.equal(Object.hasOwn(result, 'total'), false);
  assert.equal(result.items[0].amount, '');
  assert.equal(result.items[0].email, '');
  assert.equal(result.items[0].paymentReference, '');
  assert.equal(result.items[0].errorCode, '');
});

test('the existing finance endpoint remains read-only, same-origin, role-checked and noncacheable', async () => {
  const f = reconciliationFixture();
  const handler = createStaffWorkspaces({ store: f.store, client: f.client, publicOrigin: 'https://fixture.invalid' });
  const path = '/api/local/staff/finance/reconciliation';
  async function call(method, who, origin = 'https://fixture.invalid') {
    const request = Readable.from([]);
    Object.assign(request, { method, url: path, headers: { origin } });
    let status, headers, body;
    await handler(request, { writeHead(code, value) { status = code; headers = value; }, end(value) { body = JSON.parse(value); } }, path, who);
    return { status, headers, body };
  }
  assert.equal((await call('GET', undefined)).status, 401);
  assert.equal((await call('GET', { ...actor, role: 'admin' })).status, 403);
  assert.equal((await call('GET', actor, 'https://other.invalid')).status, 403);
  assert.equal((await call('POST', actor)).status, 405);
  assert.deepEqual(f.calls, []);
  for (const role of ['finance', 'super']) {
    const result = await call('GET', { ...actor, role });
    assert.equal(result.status, 200);
    assert.equal(result.headers['Cache-Control'], 'private, no-store');
    assert.equal(result.body.items[0].cardNumber, f.number);
  }
});
