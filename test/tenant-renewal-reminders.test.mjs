import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import {
  prepareTenantRenewalWrite, tenantRenewalHandledAction, tenantRenewalSettingsAction
} from '../server/tenant-renewal-reminders.mjs';

const clock = new Date('2026-11-10T12:00:00Z');
const actor = { id: 'operator', name: '处理管理员', role: 'admin' };
const cycleEnd = Date.parse('2026-11-13T12:00:00Z');
const order = (id, extra = {}) => ({
  id, tenantId: 'tenant', product: 'Claude Pro', email: 'same@example.test',
  start: '2026-11-01T09:00', expiry: '2026-11-13T20:00', paidConfirmed: true, ...extra
});
const seed = () => ({
  customers: [], tenants: [{ id: 'tenant' }, { id: 'other' }],
  orders: [order('first'), order('second', { expiry: '2026-11-13T12:00:00Z' }),
    order('other-account', { email: 'other@example.test' }), order('other-tenant', { tenantId: 'other' })],
  operating: [], rentBatches: [], logs: [], renewalWarningDays: 1
});
const prepare = (before, next, action, operator = actor) =>
  prepareTenantRenewalWrite(before, next, action, operator, clock);
const settings = (before, hours) => ({
  ...structuredClone(before), tenantRenewalWarningHours: hours,
  logs: [{ id: 'setting', type: tenantRenewalSettingsAction }, ...structuredClone(before.logs)]
});
const handled = (before, { id = 'handled', orderIds = ['first', 'second'], expiry = cycleEnd } = {}) => ({
  ...structuredClone(before), logs: [{ id, type: tenantRenewalHandledAction, entityId: 'tenant',
    detail: '客户端附加内容', at: '2000-01-01T00:00:00Z', actor: '客户端姓名', actorId: 'client',
    tenantRenewal: { orderIds, expiry, extra: '客户端附加资料' } }, ...structuredClone(before.logs)]
});

test('租户提醒设置独立持久化，旧客户端保存保留设置', () => {
  const before = seed(), next = settings(before, 96);
  prepare(before, next, tenantRenewalSettingsAction);
  assert.equal(next.tenantRenewalWarningHours, 96);
  assert.equal(next.renewalWarningDays, 1);
  assert.equal(next.logs[0].actor, actor.name);
  const unrelated = structuredClone(next);
  delete unrelated.tenantRenewalWarningHours;
  prepare(next, unrelated, '新增资料');
  assert.equal(unrelated.tenantRenewalWarningHours, 96);
  assert.throws(() => prepare(next, { ...unrelated, tenantRenewalWarningHours: 24 }, '新增资料'), { status: 409 });
  for (const hours of [0, 1.5, 8761, '72', null])
    assert.throws(() => prepare(before, settings(before, hours), tenantRenewalSettingsAction), { status: 400 });
  assert.throws(() => prepare(before, settings(before, 72), tenantRenewalSettingsAction, {
    ...actor, role: 'employee'
  }), { status: 403 });
  const changedOrder = settings(before, 72);
  changedOrder.orders[0].expiry = '2026-12-13T20:00';
  assert.throws(() => prepare(before, changedOrder, tenantRenewalSettingsAction), { status: 409 });
});

test('处理只记录同租户同账号同周期，并由服务端记录真实操作人和时间', () => {
  const before = seed(), next = handled(before);
  prepare(before, next, tenantRenewalHandledAction);
  assert.deepEqual(next.orders, before.orders);
  assert.deepEqual(next.logs[0], {
    id: 'handled', type: tenantRenewalHandledAction, entityId: 'tenant', detail: '已标记处理本次到期提醒',
    at: clock.toISOString(), actor: actor.name, actorId: actor.id,
    tenantRenewal: { orderIds: ['first', 'second'], expiry: cycleEnd }
  });
  assert.throws(() => prepare(next, handled(next, { id: 'repeat', orderIds: ['second'] }),
    tenantRenewalHandledAction), /已经处理/);
  assert.throws(() => prepare(next, { ...next, logs: [] }, '修改资料'), /完整保留/);
  assert.throws(() => prepare(before, handled(before), '修改资料'), /完整保留/);

  const corrected = structuredClone(next);
  corrected.orders[0].expiry = '2026-11-12T20:00';
  const nextCycle = handled(corrected, { id: 'other-cycle', orderIds: ['first'], expiry: cycleEnd - 86_400_000 });
  prepare(corrected, nextCycle, tenantRenewalHandledAction);
  assert.equal(nextCycle.logs.length, 2);
  assert.deepEqual(nextCycle.logs[1], next.logs[0]);
});

test('拒绝跨租户、跨账号、超出提醒窗口和失效的订单', () => {
  const before = seed();
  for (const ids of [['other-tenant'], ['first', 'other-account'], ['不存在']])
    assert.throws(() => prepare(before, handled(before, { orderIds: ids }), tenantRenewalHandledAction), { status: 409 });
  const later = seed();
  later.orders[0].expiry = '2026-11-14T20:00';
  assert.throws(() => prepare(later, handled(later, { orderIds: ['first'], expiry: cycleEnd + 86_400_000 }),
    tenantRenewalHandledAction), /尚未进入提醒时间/);
  for (const extra of [{ cancelled: true }, { subscriptionEnded: true }, { paidConfirmed: false },
    { start: '2026-11-12T10:00' }]) {
    const invalid = seed();
    Object.assign(invalid.orders[0], extra);
    assert.throws(() => prepare(invalid, handled(invalid, { orderIds: ['first'] }),
      tenantRenewalHandledAction), { status: 409 });
  }
});

test('复用客户与订单保存接口和版本号', async () => {
  const origin = 'https://example.test', path = '/api/local/commerce';
  let snapshot = { version: 1, data: seed() };
  const store = {
    load: () => snapshot,
    saveBatch(entries, options) {
      const [entry] = entries;
      assert.equal(entries.length, 1);
      assert.equal(entry.domain, 'commerce');
      assert.equal(entry.version, snapshot.version);
      prepare(snapshot.data, entry.data, entry.action, options.actor);
      snapshot = { version: entry.version + 1, data: entry.data };
      return [{ ...snapshot, domain: entry.domain }];
    }
  };
  const write = async (version, action, data) => {
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ version, action, data }))]), {
      method: 'PUT', url: path, headers: { origin, 'content-type': 'application/json' }
    });
    let status, body;
    await handleLocalBusiness(request, {
      setHeader() {}, writeHead(code) { status = code; }, end(content) { body = JSON.parse(content); }
    }, path, store, actor, { publicOrigin: origin });
    return { status, body };
  };
  const setting = await write(1, tenantRenewalSettingsAction, settings(snapshot.data, 96));
  assert.equal(setting.status, 200);
  const result = await write(2, tenantRenewalHandledAction, handled(snapshot.data));
  assert.equal(result.status, 200);
  assert.equal(result.body.version, 3);
  assert.equal(result.body.data.logs[0].actorId, actor.id);
  assert.equal(result.body.data.logs[0].tenantRenewal.expiry, cycleEnd);
  const stale = await write(2, tenantRenewalHandledAction, handled(setting.body.data));
  assert.equal(stale.status, 409);
  assert.equal(snapshot.version, 3);
});

test('租户续费设置、处理和审计在隔离 SQLite 中原子保存', { skip: process.env.CI !== 'true' }, () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const now = Date.now(), expiry = now + 24 * 3_600_000;
    const initialData = {
      ...seed(), tenants: [{ id: 'tenant', name: '合成租户', phone: '01012345670', active: true, version: 1 }],
      orders: [order('persisted', {
        plan: 'Pro', businessType: '续费', payment: '银行卡', proMaterialMode: 'people',
        paidAmount: '20', paidCurrency: 'USD', saleAmount: '180', saleCurrency: 'CNY',
        start: new Date(now - 24 * 3_600_000).toISOString(), expiry: new Date(expiry).toISOString(), version: 1
      })]
    };
    const save = (version, action, data) =>
      store.saveBatch([{ domain: 'commerce', version, action, data }], { actor })[0];
    const initial = save(0, '新增独立订单', initialData);
    const configured = save(initial.version, tenantRenewalSettingsAction, settings(initial.data, 96));
    const mark = handled(configured.data, { orderIds: ['persisted'], expiry });
    const saved = save(configured.version, tenantRenewalHandledAction, mark);
    const snapshot = store.load('commerce');
    assert.equal(snapshot.version, saved.version);
    assert.equal(snapshot.data.tenantRenewalWarningHours, 96);
    assert.deepEqual(snapshot.data.orders, initial.data.orders);
    assert.deepEqual(snapshot.data.logs[0].tenantRenewal, { orderIds: ['persisted'], expiry });
    assert.equal(snapshot.data.logs[0].actorId, actor.id);
    const audit = store.audit();
    assert.equal(audit[0].action, tenantRenewalHandledAction);
    assert.equal(audit[0].actorId, actor.id);
    assert.throws(() => save(configured.version, tenantRenewalHandledAction, mark), { status: 409 });
    assert.throws(() => save(snapshot.version, tenantRenewalHandledAction,
      handled(snapshot.data, { id: 'repeat', orderIds: ['persisted'], expiry })), /已经处理/);
    assert.deepEqual(store.load('commerce'), snapshot);
    assert.deepEqual(store.audit(), audit);
  } finally {
    store.close();
  }
});
