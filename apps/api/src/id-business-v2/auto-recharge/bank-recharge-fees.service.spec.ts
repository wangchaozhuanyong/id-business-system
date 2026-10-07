import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { IdBusinessV2FinanceFxService } from '../finance/public-api';
import type { V2CommandContext } from '../runtime/public-api';
const accountId = randomUUID();
const context: V2CommandContext = {
  attempt: 1,
  requestId: 'fee-test',
  businessTime: new Date('2026-10-05T00:00:00Z'),
  markChangedScopes: vi.fn()
};
function fixture() {
  const repository = {
    findFinanceAccount: vi
      .fn()
      .mockResolvedValue({ id: accountId, currency: 'USDT', status: 'active' })
  };
  const audit = { append: vi.fn() };
  const command = {
    findFxSnapshotInTransaction: vi.fn().mockResolvedValue(null),
    createFxSnapshot: vi.fn(async (_tx, data) => data)
  };
  const fx = new IdBusinessV2FinanceFxService(
    {} as never,
    command as never,
    {} as never,
    audit as never,
    {} as never
  );
  const service = new BankRechargeFeesService(repository as never, fx);
  return { repository, audit, service };
}
describe('订阅费用核对和快照', () => {
  it('未知费用保持空值；明确零费用无需账户', async () => {
    const { service } = fixture();
    const pending = await service.prepare(
      {} as never,
      {} as never,
      {},
      {
        id: 'operator'
      } as never,
      context
    );
    expect(pending.usdtFeeAmount).toBeNull();
    expect(pending.shoppingFeeAmount).toBeNull();
    const known = await service.prepare(
      {} as never,
      {} as never,
      { usdtFeeAmount: '0', shoppingFeeAmount: '0' },
      { id: 'operator' } as never,
      context
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
      { id: 'operator' } as never,
      context
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
        {} as never,
        context
      )
    ).rejects.toThrow('缺少有效汇率');
    await expect(
      f.service.prepare(
        {} as never,
        {} as never,
        { shoppingFeeAmount: '1', shoppingFeeFinanceAccountId: accountId },
        {} as never,
        context
      )
    ).rejects.toThrow('同币种');
    await expect(
      f.service.prepare(
        {} as never,
        {} as never,
        { usdtFeeAmount: '1', usdtFeeFinanceAccountId: accountId, usdtFeeFxRateToCny: 'invalid' },
        {} as never,
        context
      )
    ).rejects.toThrow('汇率');
    await expect(f.service.postingLines({} as never, {} as never)).rejects.toThrow('请核对');
  });
});
