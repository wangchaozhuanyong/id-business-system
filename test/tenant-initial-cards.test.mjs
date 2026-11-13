import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { orderCardArchiveDocument } from '../server/card-management.mjs';
import { createOrderAuxiliaryHandler } from '../server/order-auxiliary.mjs';
import { stageInitialTenantCards } from '../server/tenant-initial-cards.mjs';
const card = index => ({ number: String(4000000000000000n + BigInt(index)), label: `合成卡 ${index}` });
test('新增租户与 99 张银行卡生成同一保存计划，原输入字段不留在商务文档', () => {
  const next = { tenants: [{ id: 'new', initialCards: Array.from({ length: 99 }, (_, i) => card(i)) }] };
  let id = 0;
  const result = stageInitialTenantCards({ tenants: [] }, next, [], () => 'tenant:' + ++id);
  assert.equal(result.additions.length, 99);
  assert.equal(new Set(result.additions.map(row => row.id)).size, 99);
  assert(result.additions.every(row => row.tenantId === 'new' && row.active));
  assert.deepEqual(result.targets, ['new']);
  assert(!Object.hasOwn(next.tenants[0], 'initialCards'));
});
test('第 100 张、重复卡号、非法卡号与修改历史租户被拦截，失败前不消除输入', () => {
  for (const cards of [Array.from({ length: 100 }, (_, i) => card(i)), [card(1), card(1)], [{ number: '123' }],
    [{ number: '', label: '有名称但没有卡号' }], [{ number: 123 }]]) {
    const next = { tenants: [{ id: 'new', initialCards: cards }] };
    assert.throws(() => stageInitialTenantCards(null, next));
    assert.deepEqual(next.tenants[0].initialCards, cards);
  }
  assert.throws(() => stageInitialTenantCards({ tenants: [{ id: 'old' }] }, { tenants: [{ id: 'old', initialCards: [card(0)] }] }), /已有租户/);
});
test('普通新增租户时跳过未填写的银行卡行', () => {
  const next = { tenants: [{ id: 'new', initialCards: [{ number: ' ', label: ' ' }, card(0)] }] };
  const result = stageInitialTenantCards(null, next, [], () => 'tenant:one');
  assert.deepEqual(result.additions, [{ id: 'tenant:one', tenantId: 'new', ...card(0), active: true }]);
  assert.equal(Object.hasOwn(next.tenants[0], 'initialCards'), false);
});
test('多租户计划整体预检，失败不修改前面租户；历史银行卡保持原样', () => {
  const existing = [{ id: 'existing', tenantId: 'old', ...card(0), active: false }];
  const before = structuredClone(existing);
  const next = { tenants: [{ id: 'a', initialCards: [card(1)] }, { id: 'b', initialCards: [card(1)] }] };
  assert.throws(() => stageInitialTenantCards(null, next, existing));
  assert.equal(next.tenants[0].initialCards.length, 1);
  assert.deepEqual(existing, before);
  const clean = { tenants: [{ id: 'a', initialCards: [{ number: '4000-0000 0000 0000', label: '' }] }] };
  assert.throws(() => stageInitialTenantCards(null, clean, existing), /不能重复登记/);
  clean.tenants[0].initialCards[0].number = '4000-0000 0000 0001';
  assert.equal(stageInitialTenantCards(null, clean, existing).additions[0].number, card(1).number);
});

test('已有租户银行卡入口也最多 99 张，第 100 张不写入且审计不含卡号', async () => {
  let doc = { version: 1, data: { items: Array.from({ length: 98 }, (_, i) => ({ ...card(i), id: 'tenant:' + i, tenantId: 'old', active: true })) } };
  doc.data.items[0].firstUse = { orderId: 'used-order', orderNo: 'QA-USED' };
  const commerce = {
    tenants: [{ id: 'old', name: '合成租户', active: true }, { id: 'other', active: true }],
    orders: [{ id: 'historical', orderNo: 'QA-HISTORICAL', payment: '银行卡', cardId: 'recharge:100' }]
  };
  const audit = [];
  const store = {
    load: domain => ({ data: domain === 'commerce' ? commerce : null, version: 2 }),
    featureDocument(domain) {
      if (domain === 'tenant-cards') return structuredClone(doc);
      if (domain === orderCardArchiveDocument) return { version: 1, data: { cards: { 'recharge:100': card(100) } } };
      return { version: 0, data: null };
    },
    saveFeatureDocument(domain, version, data, entry) {
      assert.equal(domain, 'tenant-cards'); assert.equal(version, doc.version);
      assert.equal(entry.commerceVersion, 2);
      audit.push(entry); doc = { version: version + 1, data }; return doc;
    }
  };
  const handler = createOrderAuxiliaryHandler({ store, publicOrigin: 'https://test.invalid' });
  async function send(command, role = 'admin') {
    const request = Readable.from([Buffer.from(JSON.stringify(command))]);
    request.method = 'POST'; request.url = '/api/local/tenant-cards';
    request.headers = { origin: 'https://test.invalid', 'content-type': 'application/json' };
    let status, body;
    await handler(request, { writeHead(s) { status = s; }, end(value) { body = JSON.parse(value); } }, request.url, { id: 'admin', role });
    return { status, body };
  }
  const add = (index, tenantId = 'old', version = doc.version) => send({ tenantId, action: 'add', version, ...card(index) });
  const lookup = (number, role) => send({ action: 'lookup', number }, role);
  assert.equal((await add(98)).status, 200);
  assert.equal(doc.data.items.length, 99);
  assert.equal((await add(99)).status, 409);
  const duplicate = await add(98, 'other', 1);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /不能重复登记/);
  assert.deepEqual(duplicate.body.matches, [{ cardId: doc.data.items.at(-1).id, tenantId: 'old', tenantName: '合成租户', last4: '0098' }]);
  assert(!JSON.stringify(duplicate.body).includes(card(98).number));
  const used = await lookup('4000-0000 0000 0000');
  assert.equal(used.status, 200);
  assert.equal(used.body.matches[0].used, true);
  assert.equal(used.body.matches[0].firstUse.orderNo, 'QA-USED');
  assert.equal((await lookup(card(98).number)).body.matches[0].used, false);
  assert.deepEqual((await lookup('5555555555550098')).body.matches, []);
  assert.equal((await lookup('0098')).status, 400);
  assert.equal((await lookup(card(98).number, 'employee')).status, 403);
  const historical = { orderId: 'historical', orderNo: 'QA-HISTORICAL', last4: '0100' };
  assert.deepEqual((await lookup(card(100).number)).body.matches, [historical]);
  assert.deepEqual((await add(100, 'other')).body.matches, [historical]);
  assert.equal(doc.data.items.length, 99);
  assert.equal(audit.length, 1);
  assert(!JSON.stringify(audit).includes(card(98).number));
});
