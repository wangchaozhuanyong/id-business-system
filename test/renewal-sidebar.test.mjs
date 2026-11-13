import assert from 'node:assert/strict';
import test from 'node:test';
import { renewalSidebar } from '../server/renewal-sidebar.mjs';

const at = Date.parse('2026-11-11T12:00:00+08:00');
const order = (id, fields = {}) => ({
  id, email: id + '@example.test', product: 'GPT', customerId: 'customer', start: '2026-10-13T12:00',
  expiry: '2026-11-13T12:00', source: '管理员手工', ...fields
});
const store = (orders, logs = [], accounts = []) => ({
  load: domain => ({ data: domain === 'commerce' ? { orders, logs, renewalWarningHours: 72 } : { accounts } }),
  featureDocument: () => ({ data: null })
});

test('renewal summary preserves rejected, replaced, expired and future subscription rules without returning records', () => {
  const next = order('new', { email: 'old@example.test', priorOrderId: 'old', expiry: '2026-12-13T12:00' });
  const data = store([order('old'), next, order('refused'),
    order('due'), order('expired', { expiry: '2026-11-08T12:00' }),
    order('future', { start: '2026-11-20T12:00', expiry: '2026-12-20T12:00' })],
  [{ type: '拒续费', entityId: 'refused' }]);
  assert.deepEqual(renewalSidebar(data, at), { count: 2, nextAt: Date.parse('2026-11-20T12:00:00+08:00') });
});

test('released inventory subscriptions are excluded and an ambiguous email does not choose a stock account', () => {
  const due = order('released', { accountId: 'account' });
  const asset = { id: 'account', type: 'gpt', email: due.email,
    accountLifecycleEvents: [{ id: 'retired', action: 'retire', orderIds: [due.id] }] };
  assert.equal(renewalSidebar(store([due], [], [asset]), at).count, 0);
  assert.equal(renewalSidebar(store([due], [], [asset, { ...asset, id: 'other' }]), at).count, 1);
});
