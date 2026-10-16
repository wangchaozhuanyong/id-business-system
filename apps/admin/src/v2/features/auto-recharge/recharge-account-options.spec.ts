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
  it('完整邮箱参与选择器显示和过滤', () => {
    expect(
      rechargeAccountOptionLabel({ ...account, email: 'full.address@example.invalid' })
    ).toContain('full.address@example.invalid');
  });
  it('可选现有账号先核实官网，不以历史套餐决定是否付款', () => {
    expect(canSelectRechargeAccount(account)).toBe(true);
    expect(canSelectRechargeAccount({ ...account, subscriptionState: 'unknown' })).toBe(true);
    expect(canSelectRechargeAccount({ ...account, status: 'disabled' })).toBe(false);
  });
  it('历史套餐仅作提示，无密码账号使用邮箱验证码', () => {
    expect(rechargeAccountOptionLabel(account)).toContain('历史记录');
    expect(rechargeAccountOptionLabel({ ...account, hasPassword: false })).toContain(
      '邮箱验证码登录'
    );
  });
});
