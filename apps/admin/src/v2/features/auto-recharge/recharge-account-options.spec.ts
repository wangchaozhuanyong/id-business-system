import { describe, expect, it } from 'vitest';
import { canSelectRechargeAccount, rechargeAccountOptionLabel } from './recharge-account-options';
import type { BankChatgptAccount } from './bank-recharge-api';

const account = {
  status: 'active',
  currentPlan: 'plus',
  subscriptionState: 'active',
  emailMasked: 'te***@example.invalid',
  hasPassword: true
} as BankChatgptAccount;
describe('自动充值选用已有订阅账号', () => {
  it.each(['pro-5x', 'pro-20x', 'pro-500'])('有效Plus允许选择升级%s', (plan) => {
    expect(canSelectRechargeAccount(account, plan)).toBe(true);
    expect(canSelectRechargeAccount({ ...account, subscriptionState: 'due_soon' }, plan)).toBe(
      true
    );
  });
  it.each(['go', 'plus'])('有效Plus不允许通过%s再开同套餐或降级', (plan) => {
    expect(canSelectRechargeAccount(account, plan)).toBe(false);
  });
  it('未知订阅、停用或已有Pro不进入升级选择，已到期账号仍可充值', () => {
    expect(canSelectRechargeAccount({ ...account, subscriptionState: 'unknown' }, 'pro-5x')).toBe(
      false
    );
    expect(canSelectRechargeAccount({ ...account, status: 'disabled' }, 'pro-5x')).toBe(false);
    expect(canSelectRechargeAccount({ ...account, currentPlan: 'pro-5x' }, 'pro-20x')).toBe(false);
    expect(canSelectRechargeAccount({ ...account, subscriptionState: 'expired' }, 'plus')).toBe(
      true
    );
    expect(
      canSelectRechargeAccount({ ...account, subscriptionState: 'never_subscribed' }, 'go')
    ).toBe(true);
    expect(rechargeAccountOptionLabel(account)).toContain('Plus 升级');
  });
});
