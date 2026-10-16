import { describe, expect, it } from 'vitest';
import type { V2VendureMailboxHealth } from '@apple-business/shared';
import { mailboxDeliverySummary, mailboxListenerSummary } from './vendure-mailbox-health';

const health: V2VendureMailboxHealth = {
  status: 'available',
  checkedAt: '2026-10-16T08:00:00Z',
  listeners: [
    { primaryAccountId: '1', state: 'unknown', reason: 'not_started', leaseExpiresAt: null }
  ],
  delivery: { configured: true, pendingCount: 0, oldestPendingAt: null, lastDeliveredAt: null }
};
describe('mail health labels use evidence rather than defaults', () => {
  it.each(['unsupported', 'unavailable'] as const)('keeps %s health unknown', (status) => {
    expect(mailboxListenerSummary({ ...health, status })).toBe('未知');
    expect(mailboxDeliverySummary({ ...health, status })).toBe('未知');
  });
  it('distinguishes inactive listening and missing first delivery receipt', () => {
    expect(mailboxListenerSummary(health)).toContain('未确认');
    expect(mailboxDeliverySummary(health)).toBe('等待首条回执');
    expect(
      mailboxDeliverySummary({ ...health, delivery: { ...health.delivery!, configured: false } })
    ).toBe('通知未配置');
  });
  it('calculates backlog age at the server check time, without a polling timer', () => {
    expect(
      mailboxDeliverySummary({
        ...health,
        delivery: { ...health.delivery!, pendingCount: 3, oldestPendingAt: '2026-10-16T07:58:00Z' }
      })
    ).toBe('通知积压 3 条');
    expect(
      mailboxDeliverySummary({
        ...health,
        delivery: { ...health.delivery!, pendingCount: 1, oldestPendingAt: '2026-10-16T07:59:50Z' }
      })
    ).toBe('等待投递 1 条');
  });
  it('shows a real authorization failure ahead of other healthy listeners', () => {
    expect(
      mailboxListenerSummary({
        ...health,
        listeners: [
          { ...health.listeners[0]!, state: 'listening', reason: 'connected' },
          {
            ...health.listeners[0]!,
            primaryAccountId: '2',
            state: 'unavailable',
            reason: 'authorization_failed'
          }
        ]
      })
    ).toBe('授权失效');
  });
});
