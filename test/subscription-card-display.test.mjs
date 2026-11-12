import assert from 'node:assert/strict';
import test from 'node:test';
import { cardDisplayFixture, cardDisplayActor, syntheticCards } from './helpers/subscription-card-display-fixture.mjs';

test('订阅用卡资料按真实卡关联提供完整卡号、类型、文本序列号，保留同尾号差异', async () => {
  const fixture = cardDisplayFixture();
  const result = await fixture.request();
  assert.equal(result.status, 200);
  assert.match(result.headers['Cache-Control'], /no-store/);
  const items = new Map(result.body.items.map(row => [row.id, row]));
  const shared = items.get('manual'), sameTail = items.get('same-tail');
  assert.equal(shared.number, syntheticCards.shared);
  assert.equal(shared.typeName, 'wise潘');
  assert.deepEqual(shared.serials, ['0007-A', '0007-B', 'OLD-SERIAL']);
  assert.equal(items.get('pool').cardKey, shared.cardKey);
  assert.notEqual(sameTail.cardKey, shared.cardKey);
  assert.equal(sameTail.number, syntheticCards.sameTail);
  assert.equal(sameTail.typeName, 'vccwc999');
  assert.deepEqual(sameTail.serials, ['0008']);
  assert.equal(items.get('archive').number, syntheticCards.archived);
  for (const id of ['missing', 'conflict']) assert.equal(items.get(id).number, '');
  assert.deepEqual(items.get('conflict').serials, []);
  const preferred = items.get('preferred');
  assert.equal(preferred.preferred, true);
  assert.equal(preferred.number, syntheticCards.replacement);
  assert.equal(preferred.typeName, 'vccwc999');
  assert.deepEqual(preferred.serials, ['0012']);
  const frozen = result.body.frozen[0];
  assert.equal(frozen.number, syntheticCards.frozen);
  assert.equal(frozen.typeName, 'vccwc999');
  assert.deepEqual(frozen.serials, ['FRZ-0001']);
  assert.equal(fixture.reads.length, 1, '同一次列表读取只读取一次卡池');
  assert.equal(fixture.audits.length, 1);
  for (const number of Object.values(syntheticCards)) assert(!JSON.stringify(fixture.audits).includes(number));
  assert(!JSON.stringify(result.body).includes('SYNTHETIC-CVC'));
});

test('原状态读取不新增完整资料，员工及跨站读取仍被拒绝', async () => {
  const fixture = cardDisplayFixture();
  const safe = await fixture.request({ details: false });
  assert.equal(safe.status, 200);
  for (const row of [...safe.body.items, ...safe.body.frozen]) {
    assert.equal(row.number, undefined);
    assert.equal(row.serials, undefined);
  }
  const before = fixture.reads.length;
  assert.equal((await fixture.request({ actor: { ...cardDisplayActor, role: 'employee' } })).status, 403);
  assert.equal((await fixture.request({ actor: null })).status, 403);
  assert.equal((await fixture.request({ requestOrigin: 'https://another.invalid' })).status, 403);
  assert.equal(fixture.reads.length, before);
  assert.equal(fixture.audits.length, 0);
});

test('银行卡资料和续费准备接口不再返回余额', async () => {
  const fixture = cardDisplayFixture();
  const details = await fixture.request({ path: '/api/local/subscription-card-details', command: { orderId: 'manual' } });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.body.order.card.canReveal, true);
  assert.equal(Object.hasOwn(details.body.order.card, 'balance'), false);
  const prepared = await fixture.request({ path: '/api/local/subscription-renewal-card', command: { action: 'prepare', orderId: 'preferred' } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.last4, '0002');
  assert.equal(prepared.body.canCopy, true);
  assert.equal(Object.hasOwn(prepared.body, 'balance'), false);
});
