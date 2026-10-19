import { describe, expect, it } from 'vitest';
import { readV2RechargeManualSettlement } from '@apple-business/shared';
import {
  resolvedDirectManualPayment,
  resolvedDirectManualCheckout,
  completedDirectManualDocument
} from './bitbrowser-manual-settlement';
const accountKey = 'a'.repeat(64),
  identifier = 'oaics_synthetic_manual';
function fixture() {
  const proof = {
    version: 1,
    outcome: 'failure',
    operationId: '11111111-1111-4111-8111-111111111111',
    sourceJobId: '22222222-2222-4222-8222-222222222222',
    operatorId: '33333333-3333-4333-8333-333333333333',
    accountKey,
    identifier,
    plan: 'plus',
    resolvedAt: '2026-10-19T00:00:00.000Z',
    requestDigest: 'b'.repeat(64)
  };
  const payment = {
    account_key: accountKey,
    target_plan: 'plus',
    checkout_identifier: identifier,
    payment_attempted: true,
    confirmation_requests_sent: 1,
    payment_status: 'requires_action',
    manual_settlement: { ...proof }
  } as Record<string, unknown>;
  return { payment, checkout: structuredClone(payment) };
}
describe('人工处理账本在网页执行器内的只读绑定', () => {
  it('失败记录保留原付款事实，只有成对同源处理记录才可开始新单', () => {
    const f = fixture();
    expect(resolvedDirectManualPayment(f.payment, accountKey)).toBe(true);
    expect(resolvedDirectManualCheckout(f.checkout, f.payment, accountKey, 'plus')).toBe(true);
    expect(completedDirectManualDocument(f.payment, accountKey)).toBe(false);
  });
  it.each([
    { version: 2 },
    { outcome: 'untrusted' },
    { sourceJobId: 'invalid' },
    { operatorId: 'invalid' },
    { requestDigest: 'invalid' },
    { resolvedAt: 'invalid' },
    { resolvedAt: '2026-10-19' },
    { identifier: 'oaics_other' },
    { accountKey: 'c'.repeat(64) },
    { plan: 'go' },
    { orderId: '11111111-1111-4111-8111-111111111111' },
    { untrusted: 'field' }
  ])('不完整或绑定变化的标记不放行：%j', (patch) => {
    const f = fixture();
    Object.assign(f.payment.manual_settlement as object, patch);
    expect(resolvedDirectManualPayment(f.payment, accountKey)).toBe(false);
    expect(resolvedDirectManualCheckout(f.checkout, f.payment, accountKey, 'plus')).toBe(false);
  });
  it('两个有效但不同来源的人工处理不能混配', () => {
    const f = fixture();
    (f.checkout.manual_settlement as Record<string, unknown>).operationId =
      '44444444-4444-4444-8444-444444444444';
    expect(readV2RechargeManualSettlement(f.checkout)).toBeDefined();
    expect(resolvedDirectManualCheckout(f.checkout, f.payment, accountKey, 'plus')).toBe(false);
  });
  it('成功必须带关联订单，且不会被当成可重试的失败单', () => {
    const f = fixture();
    Object.assign(f.payment.manual_settlement as object, { outcome: 'success' });
    expect(readV2RechargeManualSettlement(f.payment)).toBeUndefined();
    Object.assign(f.payment.manual_settlement as object, {
      orderId: '44444444-4444-4444-8444-444444444444'
    });
    expect(completedDirectManualDocument(f.payment, accountKey)).toBe(true);
    expect(resolvedDirectManualPayment(f.payment, accountKey)).toBe(false);
  });
});
