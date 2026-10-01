import { V2_BANK_RECHARGE_PLANS, V2_RECHARGE_PLANS } from '@apple-business/shared';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { validateRechargeBitBrowserStart } from './recharge-local-validation';
import { validateStart } from './recharge-validation';

const accountId = '11111111-1111-4111-8111-111111111111';
const openedAt = '2026-10-01T00:00:00.000Z';

function fixture() {
  const tx = {};
  const transactions = {
    execute: vi.fn(async (operation: (value: unknown) => Promise<unknown>) => operation(tx))
  };
  const audit = { append: vi.fn() };
  const accounts = {
    requireCurrency: vi.fn().mockResolvedValue({ minorUnits: 2 }),
    requireActive: vi.fn().mockResolvedValue({ id: accountId })
  };
  const repository = {
    createOrder: vi.fn(async (_tx: unknown, input: { data: Record<string, unknown> }) => ({
      id: 'order-fixture',
      ...input.data
    })),
    findSubscriptionWithOrder: vi.fn().mockResolvedValue(null),
    upsertSubscription: vi.fn()
  };
  const service = new BankRechargeOrderService(
    transactions as never,
    audit as never,
    accounts as never,
    repository as never
  );
  return { service, transactions, audit, repository };
}

describe('手工套餐记录不扩大自动充值权限', () => {
  it('500 美元档可进入本机执行器，仍要求单次授权、币种和真实上限', () => {
    const input = {
      id: accountId,
      plan: 'pro-500',
      addressId: accountId,
      windowName: '500 档测试',
      lockedCurrency: 'MYR',
      maxAmount: '2200.00',
      authorizeSinglePayment: true
    };
    expect(validateRechargeBitBrowserStart(input)).toMatchObject({ plan: 'pro-500' });
    expect(() =>
      validateRechargeBitBrowserStart({ ...input, authorizeSinglePayment: false })
    ).toThrow();
    expect(() => validateRechargeBitBrowserStart({ ...input, maxAmount: '0' })).toThrow();
  });

  it.each(V2_BANK_RECHARGE_PLANS)('%s 可记录实际付款并沿用关联订阅和审计', async (plan) => {
    const { service, repository, audit } = fixture();
    await service.createManual(
      {
        plan,
        accountId,
        chargeCurrencyCode: 'PHP',
        chargeAmount: '100.00',
        manualEvidenceRef: 'fixture-payment',
        openedAt
      },
      { id: 'operator-fixture' } as never
    );
    expect(repository.createOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ plan, source: 'manual', chargeAmount: '100' })
      })
    );
    expect(repository.upsertSubscription).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId, plan, currentOrderId: 'order-fixture' })
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.bank_recharge.order.create_manual',
        afterData: expect.objectContaining({ plan })
      })
    );
  });

  it.each(['free', 'unknown', 'constructor'])('%s 不允许建立银充付款记录', async (plan) => {
    const { service, transactions, repository } = fixture();
    await expect(service.createManual({ plan }, {} as never)).rejects.toThrow('ChatGPT 套餐无效');
    expect(transactions.execute).not.toHaveBeenCalled();
    expect(repository.createOrder).not.toHaveBeenCalled();
  });

  const unsupportedAutomaticPlans = V2_BANK_RECHARGE_PLANS.filter(
    (plan) => !V2_RECHARGE_PLANS.some((supported) => supported === plan)
  );
  it.each(unsupportedAutomaticPlans)('%s 仍被服务器与本机自动充值入口拒绝', (plan) => {
    expect(() =>
      validateStart({ id: accountId, action: 'server', plan, sessionJson: '{}' })
    ).toThrow('支持的套餐');
    expect(() =>
      validateRechargeBitBrowserStart({
        id: accountId,
        plan,
        addressId: accountId,
        authorizeSinglePayment: true
      })
    ).toThrow('请选择套餐');
  });
});
