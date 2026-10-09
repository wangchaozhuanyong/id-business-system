import { describe, expect, it } from 'vitest';
import { onlineSubscriptionDetails } from './labels';
describe('原订阅查询结果协议', () => {
  it('展示原执行器嵌套data的套餐、到期、续费、剩余时长和账单入口', () => {
    const original = {
      ok: true,
      data: {
        plan: 'Plus',
        hasActiveSubscription: true,
        expiresAt: '2026-11-09T04:00:00Z',
        autoRenew: '否',
        remainingDaysDisplay: '31天',
        billingPageUrl: 'https://chatgpt.com/#settings/Subscription'
      }
    };
    const result = onlineSubscriptionDetails(original);
    expect(result).toMatchObject({
      plan: 'Plus',
      hasActiveSubscription: true,
      expiresAt: original.data.expiresAt,
      autoRenew: '否',
      remainingDaysDisplay: '31天',
      billingPageUrl: original.data.billingPageUrl
    });
  });
  it('保留现有平面字段并兼容原续费取消后的data结果', () => {
    expect(
      onlineSubscriptionDetails({
        status: 'succeeded',
        data: { cancelled: true, autoRenew: '否', message: '已成功关闭自动续费' }
      })
    ).toMatchObject({ status: 'succeeded', autoRenew: '否', message: '已成功关闭自动续费' });
  });
  it('错误和未提供结果不伪造订阅状态', () => {
    expect(onlineSubscriptionDetails({ ok: false, error: '会话已过期' })).toEqual({
      ok: false,
      error: '会话已过期'
    });
    expect(onlineSubscriptionDetails()).toEqual({});
  });
});
