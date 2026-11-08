import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
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
  for (const cards of [Array.from({ length: 100 }, (_, i) => card(i)), [card(1), card(1)], [{ number: '123' }]]) {
    const next = { tenants: [{ id: 'new', initialCards: cards }] };
    assert.throws(() => stageInitialTenantCards(null, next));
    assert.deepEqual(next.tenants[0].initialCards, cards);
  }
  assert.throws(() => stageInitialTenantCards({ tenants: [{ id: 'old' }] }, { tenants: [{ id: 'old', initialCards: [card(0)] }] }), /已有租户/);
});
test('多租户计划整体预检，失败不修改前面租户；历史银行卡保持原样', () => {
  const existing = [{ id: 'existing', tenantId: 'old', ...card(0), active: false }];
  const before = structuredClone(existing);
  const next = { tenants: [{ id: 'a', initialCards: [card(0)] }, { id: 'b', initialCards: [{ number: 'invalid' }] }] };
  assert.throws(() => stageInitialTenantCards(null, next, existing));
  assert.equal(next.tenants[0].initialCards.length, 1);
  assert.deepEqual(existing, before);
  const clean = { tenants: [{ id: 'a', initialCards: [{ number: '4000-0000 0000 0000', label: '' }] }] };
  assert.equal(stageInitialTenantCards(null, clean, existing).additions[0].number, card(0).number);
});

test('已有租户银行卡入口也最多 99 张，第 100 张不写入且审计不含卡号', async () => {
  let doc = { version: 1, data: { items: Array.from({ length: 98 }, (_, i) => ({ ...card(i), id: 'tenant:' + i, tenantId: 'old', active: true })) } };
  const audit = [];
  const store = {
    load: () => ({ data: { tenants: [{ id: 'old', active: true }] } }),
    featureDocument: () => structuredClone(doc),
    saveFeatureDocument(domain, version, data, entry) {
      assert.equal(domain, 'tenant-cards'); assert.equal(version, doc.version);
      audit.push(entry); doc = { version: version + 1, data }; return doc;
    }
  };
  const handler = createOrderAuxiliaryHandler({ store, publicOrigin: 'https://test.invalid' });
  async function add(index) {
    const request = Readable.from([Buffer.from(JSON.stringify({ tenantId: 'old', action: 'add', version: doc.version, ...card(index) }))]);
    request.method = 'POST'; request.url = '/api/local/tenant-cards';
    request.headers = { origin: 'https://test.invalid', 'content-type': 'application/json' };
    let status, body;
    await handler(request, { writeHead(s) { status = s; }, end(value) { body = JSON.parse(value); } }, request.url, { id: 'admin', role: 'admin' });
    return { status, body };
  }
  assert.equal((await add(98)).status, 200);
  assert.equal(doc.data.items.length, 99);
  assert.equal((await add(99)).status, 409);
  assert.equal(doc.data.items.length, 99);
  assert.equal(audit.length, 1);
  assert(!JSON.stringify(audit).includes(card(98).number));
});
