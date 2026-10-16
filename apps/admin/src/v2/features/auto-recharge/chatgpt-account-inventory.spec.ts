import { describe, expect, it } from 'vitest';
import {
  chatgptAccountInventoryFilter,
  canChangeChatgptAccountSale
} from './chatgpt-account-inventory';
import type { BankChatgptAccount } from './bank-recharge-api';
import { canSelectRechargeAccount } from './recharge-account-options';

describe('ChatGPT 账号库存分类', () => {
  it.each([
    ['all', 'all', 'all', 'active'],
    ['active', 'unsold', 'never_subscribed', 'active'],
    ['sold', 'sold', 'all', 'active'],
    ['deleted', 'all', 'all', 'deleted']
  ] as const)('%s 页签发送正确服务端分类', (view, saleStatus, subscriptionState, deleted) => {
    expect(chatgptAccountInventoryFilter(view)).toEqual({ saleStatus, subscriptionState, deleted });
  });
  const account = {
    registered: true,
    saleStatus: 'unsold',
    status: 'active'
  } as BankChatgptAccount;
  it('只有明确已注册才允许出售，资料完整度和启用状态不冒充注册状态', () => {
    expect(canChangeChatgptAccountSale(account)).toBe(true);
    expect(canChangeChatgptAccountSale({ ...account, registered: false })).toBe(false);
    expect(canChangeChatgptAccountSale({ ...account, registered: undefined } as never)).toBe(false);
    expect(
      canChangeChatgptAccountSale({ ...account, hasPassword: false, needsSupplement: true })
    ).toBe(true);
    expect(canChangeChatgptAccountSale({ ...account, status: 'disabled' })).toBe(true);
  });
  it('允许纠正已出售标记，但回收站不提供切换', () => {
    expect(canChangeChatgptAccountSale({ ...account, saleStatus: 'sold', registered: false })).toBe(
      true
    );
    expect(canChangeChatgptAccountSale({ ...account, deletedAt: '2026-10-16T01:00:00Z' })).toBe(
      false
    );
  });
  it('已出售且启用的账号仍能充值续费', () => {
    expect(
      canSelectRechargeAccount({ ...account, saleStatus: 'sold', subscriptionState: 'active' })
    ).toBe(true);
  });
});
