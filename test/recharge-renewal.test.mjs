import assert from 'node:assert/strict';
import test from 'node:test';
import { rechargeRenewalExpiryPending } from '../frontend/order-opening.mjs';
import { applyOrderCompletion } from '../server/order-completion.mjs';
import { matchRechargeRenewal } from '../server/recharge-renewal.mjs';
import { rechargeOrderEvidence } from '../server/recharge-order-sync.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';

const completedAt = '2026-11-12T06:00:00.000Z';
const now = Date.parse(completedAt) + 3600_000;
const prior = {
  id: 'order-prior', orderNo: 'QA-OLD', product: 'GPT', plan: 'Plus', email: ' Renewal@Example.test ',
  customerId: 'customer-a', source: '管理员手工', entitlementStatus: 'active',
  start: '2026-10-13T14:00', expiry: '2026-11-13T14:00', version: 1
};
const recharge = {
  id: 'order-new', orderNo: 'QA-NEW', product: 'GPT', plan: 'Plus', email: 'renewal@example.test',
  source: '线上代充', taskId: 'qa-recharge', entitlementStatus: 'active', version: 1,
  start: '2026-11-12T14:00', rechargeCompletedAt: completedAt, expiry: ''
};
const linked = { ...recharge, customerId: prior.customerId, previousOrderId: prior.id };
const customers = [{ id: 'customer-a', active: true, name: '合成客户甲' }, { id: 'customer-b', active: true, name: '合成客户乙' }];
const commerce = (orders = [prior]) => ({ orders, customers, renewalWarningHours: 48 });
const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin' };

test('真实成功回执必须包含同一充值码、邮箱、套餐和实际成功时间', () => {
  const task = { jobKey: 'qa-job', status: 'success', cdk: 'QA-ONLY', createdAt: '2026-11-12T05:50:00Z' };
  const bill = {
    cdk_code: task.cdk, email: recharge.email, plan_type: 'plus', status: 'success',
    stripe_session_id: 'qa-session', payment_time: '2026-11-12T05:55:00Z'
  };
  const runtimeEntries = [{ jobKey: task.jobKey, source: 'task', ts: Date.parse(completedAt),
    text: '任务结束 status=success progress=100' }];
  const evidence = (entry, options = {}) => rechargeOrderEvidence(entry, { bills: [bill], runtimeEntries, now, ...options });
  assert.equal(evidence(task).codeRenewal, true);
  assert.equal(evidence(task).completedAt, completedAt);
  assert.equal(evidence({ ...task, cdk: '' }).codeRenewal, false);
  assert.equal(evidence(task, { runtimeEntries: [] }).codeRenewal, false);
  assert.equal(evidence(task, { bills: [bill, bill] }).codeRenewal, false);
  assert.equal(evidence(task, { bills: [{ ...bill, email: '' }] }).codeRenewal, false);
  assert.equal(evidence({ ...task, status: 'failed' }), null);
});

test('续费仅匹配唯一有效客户链的当前到期原单', () => {
  const earlier = { ...prior, id: 'order-earlier', start: '2026-09-13T14:00', expiry: '2026-10-13T14:00' };
  assert.equal(matchRechargeRenewal(recharge, commerce([earlier, prior])).prior.id, prior.id);
  assert.equal(matchRechargeRenewal(recharge, commerce([{ ...prior,
    entitlementStatus: undefined, paidConfirmed: false, receiptConfirmed: false
  }])).prior.id, prior.id, '已录入周期的手工原单不依赖旧财务确认');
  assert.equal(matchRechargeRenewal(recharge, commerce([{ ...prior, expiry: '2026-11-11T14:00' }])).kind, 'matched');
  assert.equal(matchRechargeRenewal(recharge, commerce([{ ...prior, expiry: '2026-11-17T14:00' }])).kind, 'none');
  assert.equal(matchRechargeRenewal(recharge, commerce([{ ...prior, subscriptionEnded: true }])).kind, 'none');
  assert.equal(matchRechargeRenewal(recharge, commerce([{ ...prior, email: '' }])).kind, 'none');
  assert.equal(matchRechargeRenewal(recharge, commerce([prior, { ...earlier, customerId: 'customer-b' }])).kind, 'review');
  assert.equal(matchRechargeRenewal(recharge, commerce([prior, { ...prior, id: 'independent' }])).kind, 'review');
  assert.equal(matchRechargeRenewal({ ...recharge, plan: 'Pro 100' }, commerce()).kind, 'review');
  assert.equal(matchRechargeRenewal(recharge, commerce([prior, { ...linked, id: 'other-success' }])).kind, 'review');
  assert.equal(matchRechargeRenewal(recharge, commerce(), { accounts: [
    { id: 'qa-dead', email: recharge.email, type: 'gpt', health: 'dead' }
  ] }).kind, 'review');
  assert.equal(matchRechargeRenewal({ ...recharge, rechargeOwnerId: 'employee-b' },
    commerce([{ ...prior, ownerId: 'employee-a' }])).kind, 'review');
});

test('待核对新单取代旧期的倒计时，确认真实到期受权限、版本和重复请求保护', () => {
  const snapshots = orders => ({
    commerce: { version: 1, data: commerce(orders) }, inventory: { version: 1, data: {} },
    mailboxes: { version: 1, data: {} }, subscriptions: { version: 1, data: {} }
  });
  const [account] = projectSubscriptions(snapshots([linked, prior]), now);
  assert.equal(account.series[0].sourceId, linked.id);
  assert.equal(account.series[0].expiry, '');
  assert.equal(account.series[0].renewalExpiryPending, true);
  assert.equal(account.status, 'opened');
  assert.equal(account.history.length, 2);
  const command = { action: 'confirm-renewal-expiry', orderId: linked.id, version: 1, expiry: '2026-12-13T14:00' };
  const save = (order, override, user = actor) =>
    applyOrderCompletion(commerce([order, prior]), {}, user, { ...command, ...override }, () => [], completedAt).order;
  assert.throws(() => save(linked, { expiry: '2026-11-13T14:00' }), { status: 400 });
  assert.throws(() => save(linked, { expiry: '2026-11-31T14:00' }), { status: 400 });
  assert.throws(() => save(linked, { version: 0 }), { status: 409 });
  assert.throws(() => save(linked, {}, { ...actor, role: 'employee' }), { status: 403 });
  const confirmed = save(linked);
  assert.equal(confirmed.expiry, command.expiry);
  assert.equal(confirmed.version, 2);
  assert.equal(confirmed.rechargeCompletedAt, completedAt);
  assert.equal(rechargeRenewalExpiryPending(confirmed), false);
  assert.equal(save(confirmed), confirmed, '相同提交只返回原结果');
  assert.throws(() => save(confirmed, { expiry: '2026-12-14T14:00' }), { status: 409 });
  const [updated] = projectSubscriptions(snapshots([confirmed, prior]), now);
  assert.equal(updated.series[0].expiry, command.expiry);
  assert.equal(updated.status, 'active');
});
