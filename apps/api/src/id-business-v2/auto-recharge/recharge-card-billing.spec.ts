import { describe, expect, it, vi } from 'vitest';
import { finalizeRechargeCardBilling } from './recharge-card-billing';

function fixture() {
  const job = {
    id: 'job',
    ownerId: 'admin',
    cardId: 'card',
    billingNameEncrypted: 'encrypted-name',
    result: { addressId: 'address' }
  };
  const cards = {
    bindVerifiedBilling: vi.fn().mockResolvedValue(true),
    billingIdentity: vi.fn().mockResolvedValue({ numberHash: 'blind-index' })
  };
  const names = { lock: vi.fn(), confirm: vi.fn() };
  const run = (order: { cardId: string | null } | null) =>
    finalizeRechargeCardBilling({} as never, job, order, cards as never, names as never);
  return { job, cards, names, run };
}

describe('核实成功付款后的姓名确认', () => {
  it('订单属于任务中的银行卡且账单绑定成功才确认历史姓名', async () => {
    const { run, cards, names } = fixture();
    await run({ cardId: 'card' });
    expect(cards.bindVerifiedBilling).toHaveBeenCalledWith(
      {},
      'card',
      'encrypted-name',
      'address',
      'admin',
      'job'
    );
    expect(names.confirm).toHaveBeenCalledWith({}, 'blind-index', 'encrypted-name');
    expect(names.lock.mock.invocationCallOrder[0]).toBeLessThan(
      cards.bindVerifiedBilling.mock.invocationCallOrder[0]
    );
  });
  it.each([null, { cardId: 'other-card' }, { cardId: null }])(
    '不为未核实或错卡订单绑定姓名：%j',
    async (order) => {
      const { run, cards, names } = fixture();
      await run(order);
      expect(cards.bindVerifiedBilling).not.toHaveBeenCalled();
      expect(names.confirm).not.toHaveBeenCalled();
    }
  );
  it('账单资料付款期间变化时保留原绑定', async () => {
    const { run, cards, names } = fixture();
    cards.bindVerifiedBilling.mockResolvedValue(false);
    await run({ cardId: 'card' });
    expect(names.confirm).not.toHaveBeenCalled();
  });
});
