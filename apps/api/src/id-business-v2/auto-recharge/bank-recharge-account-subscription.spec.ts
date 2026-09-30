import { describe, expect, it } from 'vitest';
import {
  accountSubscriptionState,
  parseAccountSubscriptionState
} from './bank-recharge-account-subscription';
import { bankRechargeAccountFilter } from './persistence/bank-recharge.repository';

const now = new Date('2026-09-30T00:00:00.000Z');
const warning = new Date('2026-10-03T00:00:00.000Z');

describe('ChatGPT account subscription filters', () => {
  it('uses the same due soon and expiry boundaries for labels and database filters', () => {
    expect(
      accountSubscriptionState(
        { status: 'active', dueAt: new Date('2026-10-02') },
        now.getTime(),
        warning.getTime()
      )
    ).toBe('due_soon');
    expect(
      accountSubscriptionState(
        { status: 'active', dueAt: new Date('2026-10-04') },
        now.getTime(),
        warning.getTime()
      )
    ).toBe('active');
    expect(
      accountSubscriptionState({ status: 'active', dueAt: now }, now.getTime(), warning.getTime())
    ).toBe('expired');
    expect(bankRechargeAccountFilter('', null, 'due_soon', now, warning)).toEqual({
      AND: [{}, { subscription: { is: { status: 'active', dueAt: { gt: now, lte: warning } } } }]
    });
    expect(bankRechargeAccountFilter('', null, 'never_subscribed', now, warning)).toEqual({
      AND: [{}, { subscription: { is: null } }]
    });
  });

  it('rejects unsupported membership filters', () => {
    expect(() => parseAccountSubscriptionState('arbitrary')).toThrow('会员状态筛选无效');
  });
});
