import { describe, expect, it, vi } from 'vitest';
import { recordManuallySettledRecharge } from './bank-recharge-manual-settlement';

function fixture() {
  const repository = {
    findOrderByPaymentEvidence: vi.fn().mockResolvedValue(null),
    findCard: vi
      .fn()
      .mockResolvedValue({ id: 'card', label: '合成卡', numberEncrypted: null, last4: '4242' }),
    createOrder: vi.fn(async (_tx, { data }) => ({
      id: 'order',
      status: 'pending_details',
      financeStatus: 'unposted',
      ...data
    })),
    findSubscriptionWithOrder: vi.fn().mockResolvedValue(null),
    upsertSubscription: vi.fn()
  };
  const accounts = {
    requireCurrency: vi.fn().mockResolvedValue({ code: 'PHP', minorUnits: 2 }),
    ensureAccountForVerifiedPayment: vi.fn().mockResolvedValue('account')
  };
  const audit = { append: vi.fn() };
  const encryption = { decrypt: vi.fn().mockReturnValue(null), encrypt: vi.fn() };
  const job = { id: 'job', ownerId: 'owner', plan: 'plus', cardId: 'card' };
  const input = {
    identifier: 'oaics_original',
    evidenceRef: 'BANK-SYNTHETIC',
    amount: '982.14',
    currency: 'PHP',
    openedAt: '2026-10-17T12:00:00.000Z',
    dueAt: '2026-11-17T12:00:00.000Z'
  };
  const run = (patch = {}) =>
    recordManuallySettledRecharge(
      {} as never,
      job as never,
      { ...input, ...patch },
      {
        repository: repository as never,
        accounts: accounts as never,
        audit: audit as never,
        encryption: encryption as never,
        orderNo: () => 'BANK-SYNTHETIC'
      }
    );
  return { repository, accounts, audit, encryption, input, run };
}
describe('人工成功复用充值订单和订阅投影', () => {
  it('关联原任务和凭据，以 Decimal 保存真实成本，待补全不冒充财务已入账或官网核实', async () => {
    const f = fixture(),
      order = await f.run();
    expect(order).toMatchObject({
      source: 'manual',
      channel: 'bitbrowser',
      rechargeJobId: 'job',
      checkoutIdentifier: 'oaics_original',
      manualEvidenceRef: 'BANK-SYNTHETIC',
      chargeAmount: '982.14',
      chargeCurrencyCode: 'PHP',
      status: 'pending_details',
      financeStatus: 'unposted'
    });
    expect(order).not.toHaveProperty('paymentEvidenceId');
    expect(order).not.toHaveProperty('verifiedAt');
    expect(f.repository.upsertSubscription).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        accountId: 'account',
        currentOrderId: 'order',
        plan: 'plus',
        openedAt: new Date(f.input.openedAt),
        dueAt: new Date(f.input.dueAt)
      })
    );
    expect(f.audit.append).toHaveBeenCalledOnce();
  });
  it('凭据或原任务已有订单不能重复创建', async () => {
    const f = fixture();
    f.repository.findOrderByPaymentEvidence.mockResolvedValue({ id: 'prior' });
    await expect(f.run()).rejects.toThrow('已有充值订单');
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it.each([
    { amount: '0' },
    { amount: '-1' },
    { amount: '982.141' },
    { currency: 'bad_currency' },
    { openedAt: 'invalid' },
    { openedAt: '2099-01-01T00:00:00Z' },
    { dueAt: '2026-10-16T12:00:00.000Z' }
  ])('无效真实资料拒绝写入：%j', async (patch) => {
    const f = fixture();
    await expect(f.run(patch)).rejects.toThrow();
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it('缺少已绑定账号或原银行卡不能虚构成功订单', async () => {
    const f = fixture();
    f.accounts.ensureAccountForVerifiedPayment.mockResolvedValue(null);
    await expect(f.run()).rejects.toThrow('账号');
    f.accounts.ensureAccountForVerifiedPayment.mockResolvedValue('account');
    f.repository.findCard.mockResolvedValue(null);
    await expect(f.run()).rejects.toThrow('银行卡');
    expect(f.repository.createOrder).not.toHaveBeenCalled();
  });
  it('较新订阅不被历史成功单覆盖', async () => {
    const f = fixture();
    f.repository.findSubscriptionWithOrder.mockResolvedValue({
      currentOrderId: 'newer',
      openedAt: new Date('2026-10-18T00:00:00Z')
    });
    await f.run();
    expect(f.repository.createOrder).toHaveBeenCalledOnce();
    expect(f.repository.upsertSubscription).not.toHaveBeenCalled();
  });
});
