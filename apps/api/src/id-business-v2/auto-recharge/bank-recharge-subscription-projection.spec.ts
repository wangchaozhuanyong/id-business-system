import { describe, expect, it, vi } from 'vitest';
import { activateBankRechargeSubscription } from './bank-recharge-subscription-projection';

describe('历史银充单的订阅投影', () => {
  const order = {
    id: 'old-order',
    source: 'automatic',
    accountId: 'account',
    customerId: 'customer',
    plan: 'plus',
    openedAt: new Date('2026-10-04'),
    dueAt: new Date('2026-10-31')
  };
  it.each([null, { currentOrderId: 'new-order', openedAt: new Date('2026-10-03') }])(
    '自动单普通编辑在现投影 %j 下不创建或抢占指针',
    async (current) => {
      const repository = {
        findSubscriptionWithOrder: vi.fn().mockResolvedValue(current),
        upsertSubscription: vi.fn()
      };
      await activateBankRechargeSubscription({} as never, repository as never, order);
      expect(repository.upsertSubscription).not.toHaveBeenCalled();
    }
  );
  it('已核对并指向本单的订阅可以同步同单资料', async () => {
    const repository = {
      findSubscriptionWithOrder: vi
        .fn()
        .mockResolvedValue({ currentOrderId: order.id, openedAt: order.openedAt }),
      upsertSubscription: vi.fn()
    };
    await activateBankRechargeSubscription({} as never, repository as never, order);
    expect(repository.upsertSubscription).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ currentOrderId: order.id, dueAt: order.dueAt })
    );
  });
});
