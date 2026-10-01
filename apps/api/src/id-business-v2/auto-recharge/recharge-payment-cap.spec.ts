import { describe, expect, it, vi } from 'vitest';
import { RechargeSettingsService } from './recharge-settings.service';

const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function fixture() {
  const repository = {
    listPaymentCaps: vi.fn().mockResolvedValue([]),
    paymentCap: vi.fn().mockResolvedValue(null),
    currencyForCap: vi.fn().mockResolvedValue({ code: 'PHP', active: true, minorUnits: 2 }),
    upsertPaymentCap: vi.fn().mockImplementation(async (_tx, plan, currencyCode, maxAmount) => ({
      plan,
      currencyCode,
      maxAmount: { toString: () => maxAmount }
    }))
  };
  const audit = { append: vi.fn() };
  const transactions = {
    execute: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}))
  };
  const service = new RechargeSettingsService(
    repository as never,
    {} as never,
    transactions as never,
    audit as never,
    {} as never
  );
  return { service, repository, audit };
}

describe('server payment safety cap', () => {
  it('blocks an unconfigured plan and currency', async () => {
    const { service } = fixture();
    await expect(service.requirePaymentCap({} as never, 'plus', 'PHP')).rejects.toThrow(
      '请先在服务器设置中配置'
    );
  });

  it('saves an exact decimal cap and audits the change', async () => {
    const { service, repository, audit } = fixture();
    await expect(
      service.updatePaymentCap('plus', 'PHP', { maxAmount: '1500.00' }, operator)
    ).resolves.toEqual({ plan: 'plus', currencyCode: 'PHP', maxAmount: '1500' });
    expect(repository.upsertPaymentCap).toHaveBeenCalledWith(
      {},
      'plus',
      'PHP',
      '1500',
      operator.id
    );
    expect(audit.append).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.payment_cap.update',
        afterData: { maxAmount: '1500' }
      })
    );
  });

  it('rejects an amount with more decimal places than the currency allows', async () => {
    const { service, repository } = fixture();
    repository.currencyForCap.mockResolvedValue({ code: 'JPY', active: true, minorUnits: 0 });
    await expect(
      service.updatePaymentCap('plus', 'JPY', { maxAmount: '30.01' }, operator)
    ).rejects.toThrow('精度不匹配');
    expect(repository.upsertPaymentCap).not.toHaveBeenCalled();
  });
});
