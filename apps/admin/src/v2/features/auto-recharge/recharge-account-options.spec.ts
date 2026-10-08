import { describe, expect, it } from 'vitest';
import { canSelectRechargeAccount, rechargeAccountOptionLabel } from './recharge-account-options';
import type { BankChatgptAccount } from './bank-recharge-api';
const account = {
  status: 'active',
  currentPlan: 'go',
  subscriptionState: 'active',
  emailMasked: 'te***@example.invalid',
  hasPassword: true
} as BankChatgptAccount;
describe('比特充值账号资料来源', () => {
  it('可选现有账号先核实官网，不以历史套餐决定是否付款', () => {
    expect(canSelectRechargeAccount(account)).toBe(true);
    expect(canSelectRechargeAccount({ ...account, subscriptionState: 'unknown' })).toBe(true);
    expect(canSelectRechargeAccount({ ...account, status: 'disabled' })).toBe(false);
  });
  it('历史套餐仅作提示，无密码账号明确要求补充', () => {
    expect(rechargeAccountOptionLabel(account)).toContain('历史记录');
    expect(rechargeAccountOptionLabel({ ...account, hasPassword: false })).toContain(
      '请先补充登录密码'
    );
  });
});
