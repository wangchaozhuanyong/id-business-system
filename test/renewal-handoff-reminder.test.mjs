import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRenewalHandoff, renewalHandoffDomain, renewalHandoffPath } from '../server/renewal-handoff.mjs';

const origin = 'https://renewal.example.test';
const employee = { id: 'test-employee', name: '测试员工', role: 'employee' };
const finance = { id: 'test-finance', name: '测试财务', role: 'finance' };
const admin = { id: 'test-admin', name: '测试管理员', role: 'admin' };
const now = Date.parse('2026-11-19T16:00:00+08:00');
const order = (id, expiry, fields = {}) => ({
  id, orderNo: id, customerId: 'test-customer', email: id + '@example.test',
  product: 'GPT', plan: 'Plus', start: '2026-10-18T16:00', expiry, payment: '银行卡',
  source: '管理员手工', version: 1, ownerId: employee.id, ...fields
});

function fixture(data) {
  let clock = now, queue = { version: 0, data: { items: [] } };
  const store = {
    load: domain => ({ version: 1, data: domain === 'commerce' ? data : null }),
    featureDocument: domain => domain === renewalHandoffDomain ? queue : { data: null },
    replayWrite: () => null,
    orderCardFingerprint: () => '',
    saveRenewalQueue(version, _commerceVersion, items) {
      queue = { version: version + 1, data: { items } };
    }
  };
  const handler = createRenewalHandoff({ store, publicOrigin: origin,
    getAuth: () => ({ orderOwners: () => [employee, finance] }), clock: () => clock });
  const send = async (command, { actor = employee, view = 'staff' } = {}) => {
    const request = Object.assign(Readable.from(command ? [Buffer.from(JSON.stringify(command))] : []), {
      method: command ? 'POST' : 'GET', url: renewalHandoffPath + (command ? '' : '?view=' + view),
      headers: { origin, 'content-type': 'application/json', 'x-id-operation': randomUUID() }
    });
    let status, body;
    await handler(request, { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } }, actor);
    return { status, body };
  };
  return { send, advanceTo: next => { clock = next; } };
}

test('候选只含提醒范围内及已到期的有效订单，下一提醒时间按精确边界', async () => {
  const data = {
    customers: [{ id: 'test-customer', active: true }],
    renewalWarningDays: 7,
    renewalWarningHours: 24,
    orders: [
      order('due-now', '2026-11-19T16:00'),
      order('cutoff', '2026-11-20T16:00'),
      order('arrives-next', '2026-11-20T16:01'),
      order('far', '2026-12-19T16:00'),
      order('new-owner', '2026-11-20T16:02', { ownerId: 'another-employee' }),
      order('declined', '2026-11-20T10:00'),
      order('original', '2026-11-20T10:00'),
      order('renewed', '2026-12-20T10:00', { email: 'original@example.test', previousOrderId: 'original', start: '2026-11-18T09:00' })
    ],
    logs: [{ type: '拒续费', entityId: 'declined' }]
  };
  const { send, advanceTo } = fixture(data);
  const { status, body } = await send();
  assert.equal(status, 200);
  assert.equal(body.reminderHours, 24);
  assert.deepEqual(body.candidates.map(row => [row.id, row.reminderState]),
    [['due-now', 'expired'], ['cutoff', 'upcoming']]);
  assert.equal(body.nextReminderAt, now + 60_000);
  advanceTo(body.nextReminderAt);
  const appeared = (await send()).body;
  assert.deepEqual(appeared.candidates.map(row => row.id), ['due-now', 'cutoff', 'arrives-next']);
  assert.equal(appeared.nextReminderAt, Date.parse('2026-12-18T16:00:00+08:00'));
});

test('已拒续和已续费只在管理员历史筛选展示，不进入送财务候选或提醒计时', async () => {
  const data = {
    customers: [{ id: 'test-customer', active: true }],
    renewalWarningHours: 24,
    orders: [
      order('declined', '2026-11-20T10:00'),
      order('declined-outside-window', '2026-11-28T10:00'),
      order('legacy-payment', '2026-11-19T10:00', { payment: '' }),
      order('already-renewed', '2026-11-19T12:00'),
      order('successor', '2026-12-18T12:00', { email: 'already-renewed@example.test',
        previousOrderId: 'already-renewed', start: '2026-11-18T12:00' }),
      order('unresolved-customer', '2026-11-20T11:00', { customerId: '', telegram: '@renewal_fixture' }),
      order('unresolved-future', '2026-11-20T16:01', { customerId: '' }),
      order('queued', '2026-11-20T15:00')
    ],
    logs: ['declined', 'declined-outside-window', 'legacy-payment', 'already-renewed']
      .map(entityId => ({ type: '拒续费', entityId }))
  };
  const { send, advanceTo } = fixture(data);
  const command = id => ({ action: 'submit', remark: '客户已确认续费', orders: [{ id, version: 1 }] });
  assert.equal((await send(command('queued'))).status, 200);
  // An old inconsistent record may already have a decision and an active handoff.
  data.logs.unshift({ type: '拒续费', entityId: 'queued' });
  const staff = await send();
  assert.deepEqual(staff.body.candidates, []);
  const manager = await send(undefined, { actor: admin });
  assert.equal(manager.status, 200);
  assert.deepEqual(manager.body.candidates.map(({ id, reminderState }) => [id, reminderState]),
    [['declined', 'refused'], ['declined-outside-window', 'refused'], ['legacy-payment', 'refused'],
      ['already-renewed', 'renewed'], ['unresolved-customer', 'upcoming']]);
  assert(manager.body.candidates.every(row => row.canSubmitToFinance === false));
  assert.equal(manager.body.candidates.find(row => row.id === 'unresolved-customer').contactSearch, '@renewal_fixture');
  assert.equal(manager.body.nextReminderAt, now + 60_000);
  assert(staff.body.nextReminderAt > manager.body.nextReminderAt);
  assert.deepEqual((await send(undefined, { actor: finance, view: 'finance' })).body.candidates, []);
  assert.equal((await send(command('declined'), { actor: admin })).status, 409);
  assert.equal((await send(command('already-renewed'), { actor: admin })).status, 409);
  assert.equal((await send(command('unresolved-customer'), { actor: admin })).status, 409);
  assert.equal((await send(undefined, { actor: admin })).body.items.length, 1);

  data.logs.unshift({ type: '恢复续费提醒', entityId: 'declined' });
  assert.deepEqual((await send()).body.candidates.map(({ id, reminderState }) => [id, reminderState]),
    [['declined', 'upcoming']]);
  assert.equal((await send()).body.candidates[0].canSubmitToFinance, true);
  assert.equal((await send()).body.candidates[0].contactSearch, undefined);
  assert.equal((await send(command('declined'))).status, 200);
  advanceTo(manager.body.nextReminderAt);
  const appeared = (await send(undefined, { actor: admin })).body.candidates.find(row => row.id === 'unresolved-future');
  assert.equal(appeared.reminderState, 'upcoming');
  assert.equal(appeared.canSubmitToFinance, false);
});

test('保存设置并发缩短提醒时间后，旧选单不能越过续费提醒窗口提交', async () => {
  const data = {
    customers: [{ id: 'test-customer', active: true }],
    orders: [order('stale', '2026-11-21T16:00'), order('due', '2026-11-19T17:00'),
      order('already-sent', '2026-11-21T15:00')]
  };
  const { send } = fixture(data);
  const command = ids => ({ action: 'submit', confirmed: true, remark: '客户已确认续费',
    orders: ids.map(id => ({ id, version: 1 })) });
  const before = await send();
  assert.equal(before.body.reminderHours, 72);
  assert.equal(before.body.candidates.length, 3);
  assert.equal((await send(command(['already-sent']))).status, 200);
  data.renewalWarningDays = 1;
  const narrow = await send();
  assert.equal(narrow.body.reminderHours, 24);
  assert.deepEqual(narrow.body.candidates.map(row => row.id), ['due']);
  const stale = await send(command(['due', 'stale']));
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /不在续费提醒范围/);
  assert.deepEqual((await send()).body.items.map(row => row.order.id), ['already-sent']);
  assert.equal((await send(command(['due']))).status, 200);
  const submitted = await send();
  assert.equal(submitted.body.items[0].order.id, 'due');
  assert.equal(submitted.body.candidates.length, 0);
});
