import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { validateRenewalAccountReference } from '../modules/orders/renewal-account-reference.mjs';
import { createRenewalHandoff, renewalHandoffDomain, renewalHandoffPath } from '../server/renewal-handoff.mjs';

const origin = 'https://renewal.example.test';
const employee = { id: 'submitter', name: '合成员工', role: 'employee' };
const finance = { id: 'finance-reviewer', name: '合成财务', role: 'finance' };
const otherFinance = { id: 'finance-other', name: '合成财务二', role: 'finance' };
const admin = { id: 'other-admin', name: '合成管理员', role: 'super' };
const order = {
  id: 'original', orderNo: 'OD-FIXTURE', customerId: 'customer', ownerId: employee.id,
  product: 'GPT', plan: 'Plus', payment: '银行卡', source: '管理员手工', version: 1,
  start: '2026-10-19T12:00', expiry: '2026-11-19T12:00'
};
const accountReference = '{"user":{"id":"user-example","email":"example@example.test"},"account":{"id":"acct_example"}}';
const submit = { action: 'submit', orders: [{ id: order.id, version: 1 }], remark: '请办理续费', accountReference };

function fixture() {
  let queue = { version: 0, data: { items: [] } };
  const commerce = { version: 1, data: { orders: [order], customers: [{ id: 'customer', name: '合成客户', active: true }] } };
  const store = {
    load: domain => (domain === 'commerce' ? commerce : { data: null }),
    featureDocument: domain => (domain === renewalHandoffDomain ? queue : { data: null }),
    orderCardFingerprint: () => '',
    replayWrite: () => null,
    saveRenewalQueue(version, commerceVersion, items) {
      assert.equal(version, queue.version);
      assert.equal(commerceVersion, commerce.version);
      queue = { version: version + 1, data: { items } };
    }
  };
  const handler = createRenewalHandoff({ store, publicOrigin: origin,
    getAuth: () => ({ orderOwners: () => [employee, finance, otherFinance, admin] }),
    clock: () => Date.parse('2026-11-19T13:00:00+08:00') });
  async function request(actor, body, view = 'staff') {
    const method = body ? 'POST' : 'GET';
    const input = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method, url: renewalHandoffPath + (body ? '' : '?view=' + view),
      headers: { origin, 'content-type': 'application/json', 'x-id-operation': randomUUID() }
    });
    let status, data;
    await handler(input, { writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } }, actor);
    return { status, data };
  }
  return { request, snapshot: () => queue, commerce };
}

test('续费账号标识仅接受规定的非凭证值和 JSON 字段', () => {
  assert.equal(validateRenewalAccountReference(' \n '), '');
  assert.equal(validateRenewalAccountReference('  account_X7AB  '), 'account_X7AB');
  assert.equal(validateRenewalAccountReference('example@example.test'), 'example@example.test');
  assert.equal(validateRenewalAccountReference('@customer_name'), '@customer_name');
  assert.equal(validateRenewalAccountReference('00000000-0000-0000-0000-000000000000'),
    '00000000-0000-0000-0000-000000000000');
  assert.equal(validateRenewalAccountReference(' { "user": { "id": 7 }, "accountId": "  acct_example  " } '),
    '{"user":{"id":"7"},"accountId":"acct_example"}');
  for (const input of [null, {}, 'x'.repeat(2049), 'Bearer fixture', 'eyJabc.fixture.signature', 'sk-example',
    'https://example.test', '@ghp_example', '4242424242424242', '{"accessToken":"合成凭证","id":"account"}',
    '{"user":{"id":"account","cookie":"合成凭证"}}', '{"user":{"password":"合成凭证"}}',
    '{"id":"sk-example"}', '{"__proto__":{"id":"account"}}', '{"id":{"accountId":"account"}}', '["account"]']) {
    assert.throws(() => validateRenewalAccountReference(input), /仅支持账号标识、邮箱和用户名/);
  }
});

test('账号交接限定一笔订单，失败不保存，办理中只返回给经办财务', async () => {
  const { request, snapshot, commerce } = fixture();
  const batch = { ...submit, orders: [...submit.orders, { id: 'other', version: 1 }] };
  assert.equal((await request(employee, batch)).status, 400);
  const rejected = await request(employee, { ...submit, accountReference: '{"sessionToken":"synthetic-secret"}' });
  assert.equal(rejected.status, 400);
  assert(!JSON.stringify(rejected).includes('synthetic-secret'));
  assert.equal(snapshot().version, 0);
  assert.equal((await request(employee, submit)).status, 200);
  const [stored] = snapshot().data.items;
  assert.equal(stored.accountReference, accountReference);
  assert.equal((await request(employee)).data.items[0].accountReference, accountReference);
  assert.equal((await request(admin)).data.items[0].accountReference, undefined);
  assert.equal((await request(finance, null, 'finance')).data.items[0].accountReference, accountReference);
  commerce.data.orders[0] = { ...order, expiry: '2026-11-20T12:00' };
  assert.equal((await request(finance, null, 'finance')).data.items[0].accountReference, undefined);
  commerce.data.orders[0] = order;
  assert.equal((await request(finance, { action: 'claim', id: stored.id, version: 1 })).status, 200);
  assert.equal((await request(finance, null, 'finance')).data.items[0].accountReference, accountReference);
  assert.equal((await request(otherFinance, null, 'finance')).data.items[0].accountReference, undefined);
  const paid = await request(finance, { action: 'paid', id: stored.id, version: 2, amount: '15', currency: 'USD',
    cardMode: 'none', financeRemark: '已完成续费' });
  assert.equal(paid.status, 200);
  assert.equal(snapshot().data.items[0].accountReference, undefined);
  assert.equal((await request(employee)).data.items[0].financeRemark, '已完成续费');
  assert.equal((await request(finance, null, 'finance')).data.items[0].accountReference, undefined);
});

test('撤回或退回清理账号交接资料，原单可重新提交', async () => {
  const { request, snapshot } = fixture();
  assert.equal((await request(employee, submit)).status, 200);
  const [original] = snapshot().data.items;
  assert.equal((await request(employee, { action: 'withdraw', id: original.id, version: 1 })).status, 200);
  assert.equal(snapshot().data.items[0].accountReference, undefined);
  assert.equal((await request(employee, submit)).status, 200);
  const [newItem] = snapshot().data.items;
  assert.equal((await request(finance, { action: 'claim', id: newItem.id, version: 1 })).status, 200);
  assert.equal((await request(finance, { action: 'return', id: newItem.id, version: 2, reason: '未办理' })).status, 200);
  assert(snapshot().data.items.every(row => row.accountReference === undefined));
});
