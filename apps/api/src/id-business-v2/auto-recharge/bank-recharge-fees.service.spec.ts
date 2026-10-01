import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeFeesService } from './bank-recharge-fees.service';
const accountId = randomUUID();
function fixture() {
  const repository = {
    findFinanceAccount: vi
      .fn()
      .mockResolvedValue({ id: accountId, currency: 'USDT', status: 'active' }),
    financeFxSnapshot: vi.fn().mockResolvedValue(null),
    createFinanceFxSnapshot: vi.fn(async (_tx, data) => data)
  };
  const audit = { append: vi.fn() };
  const service = new BankRechargeFeesService(repository as never, audit as never);
  return { repository, audit, service };
}
describe('订阅费用核对和快照', () => {
  it('未知费用保持空值；明确零费用无需账户', async () => {
    const { service } = fixture();
    const pending = await service.prepare({} as never, {} as never, {}, {
      id: 'operator'
    } as never);
    expect(pending.usdtFeeAmount).toBeNull();
    expect(pending.shoppingFeeAmount).toBeNull();
    const known = await service.prepare(
      {} as never,
      {} as never,
      { usdtFeeAmount: '0', shoppingFeeAmount: '0' },
      { id: 'operator' } as never
    );
    expect(known.usdtFeeAmountCny).toBe('0');
    expect(known.shoppingFeeAmountCny).toBe('0');
  });
  it('不同费用币种锁定各自估值，人工汇率必须记录原因', async () => {
    const f = fixture();
    const value = await f.service.prepare(
      {} as never,
      {} as never,
      {
        usdtFeeAmount: '0.5',
        usdtFeeFinanceAccountId: accountId,
        usdtFeeFxRateToCny: '6',
        usdtFeeManualRateReason: '实际扣费凭据',
        shoppingFeeAmount: '0'
      },
      { id: 'operator' } as never
    );
    expect(value.usdtFeeAmountCny).toBe('3');
    expect(value.usdtFeeFxSnapshotId).toBeTruthy();
    expect(f.audit.append).toHaveBeenCalledOnce();
  });
  it('拒绝账户错币种、缺失汇率、非法汇率和未核对完成', async () => {
    const f = fixture();
    await expect(
      f.service.prepare(
        {} as never,
        {} as never,
        { usdtFeeAmount: '1', usdtFeeFinanceAccountId: accountId },
        {} as never
      )
    ).rejects.toThrow('缺少有效汇率');
    await expect(
      f.service.prepare(
        {} as never,
        {} as never,
        { shoppingFeeAmount: '1', shoppingFeeFinanceAccountId: accountId },
        {} as never
      )
    ).rejects.toThrow('同币种');
    await expect(
      f.service.prepare(
        {} as never,
        {} as never,
        { usdtFeeAmount: '1', usdtFeeFinanceAccountId: accountId, usdtFeeFxRateToCny: 'invalid' },
        {} as never
      )
    ).rejects.toThrow('汇率');
    await expect(f.service.postingLines({} as never, {} as never)).rejects.toThrow('请核对');
  });
});
