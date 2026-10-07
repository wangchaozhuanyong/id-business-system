import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import {
  IdBusinessV2FinanceFxService,
  type ResolveStoredFinanceRateInput
} from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';

const businessTime = new Date('2026-10-05T00:00:00Z');
function fixture() {
  const tx = {
    idBusinessV2FinanceFxRateSnapshot: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ ...data, expiresAt: null }))
    },
    auditLog: { create: vi.fn(async ({ data }) => data) },
    idBusinessV2ScopeVersion: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) }
  };
  const prisma = { $transaction: vi.fn(async (work) => work(tx)) };
  const publish = vi.fn();
  const manager = new V2CommandTransactionManager(
    prisma as never,
    { publishCommittedChangeBestEffort: publish } as never
  );
  const service = new IdBusinessV2FinanceFxService(
    manager,
    new IdBusinessV2FinanceCommandRepository(),
    {} as never,
    new V2TransactionalAuditService(),
    {} as never
  );
  const input: ResolveStoredFinanceRateInput = {
    currency: 'USDT',
    label: 'USDT 手续费',
    manualRate: '6',
    manualReason: '实际凭据',
    auditRemark: '订阅手续费人工汇率'
  };
  const resolve = (patch: Partial<ResolveStoredFinanceRateInput> = {}) =>
    manager.execute(
      (transaction, context) =>
        service.resolveStoredRateInTransaction(transaction, context, { ...input, ...patch }),
      { changedScopes: ['auto-recharge'], requestId: 'fee-rate', businessTime }
    );
  return { tx, prisma, publish, resolve };
}

describe('财务汇率复用外层事务', () => {
  it('creates normalized snapshot, audit and exact scopes in one transaction', async () => {
    const f = fixture();
    const result = await f.resolve();
    expect(result.rateToCny).toBe('6');
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.idBusinessV2FinanceFxRateSnapshot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        currency: 'USDT',
        source: 'manual',
        rateToCny: '6',
        capturedAt: businessTime
      })
    });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.finance.fx_rate.manual',
        remark: '订阅手续费人工汇率'
      })
    });
    expect(f.publish).toHaveBeenCalledExactlyOnceWith([
      'auto-recharge',
      'exchange-rates',
      'finance-reports'
    ]);
  });

  it.each([undefined, '', '6'])(
    'preserves a previously locked historical snapshot for unchanged rate %s',
    async (manualRate) => {
      const f = fixture();
      f.tx.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue({
        id: 'previous',
        currency: 'USDT',
        rateToCny: { toString: () => '6' },
        expiresAt: new Date('2020-01-01')
      });
      const result = await f.resolve({
        previousSnapshotId: 'previous',
        manualRate,
        manualReason: undefined
      });
      expect(result).toMatchObject({ id: 'previous', rateToCny: '6' });
      expect(f.tx.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
      expect(f.tx.auditLog.create).not.toHaveBeenCalled();
      expect(f.publish).toHaveBeenCalledExactlyOnceWith(['auto-recharge']);
    }
  );

  it('requires a reason only when replacing the locked rate and does not publish failed writes', async () => {
    const f = fixture();
    f.tx.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue({
      id: 'previous',
      currency: 'USDT',
      rateToCny: '6',
      expiresAt: null
    });
    await expect(
      f.resolve({ previousSnapshotId: 'previous', manualRate: '7', manualReason: '' })
    ).rejects.toThrow('人工汇率原因');
    expect(f.tx.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('adopts a valid latest rate without creating a snapshot or announcing an FX change', async () => {
    const f = fixture();
    f.tx.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue({
      id: 'latest',
      currency: 'USDT',
      rateToCny: '7',
      expiresAt: new Date(businessTime.getTime() + 1000)
    });
    expect((await f.resolve({ manualRate: undefined })).rateToCny).toBe('7');
    expect(f.publish).toHaveBeenCalledExactlyOnceWith(['auto-recharge']);
    expect(f.tx.idBusinessV2FinanceFxRateSnapshot.create).not.toHaveBeenCalled();
  });

  it('rejects expired new snapshots and keeps snapshot reads restricted to the requested currency', async () => {
    const f = fixture();
    f.tx.idBusinessV2FinanceFxRateSnapshot.findFirst.mockResolvedValue({
      id: 'expired',
      currency: 'USDT',
      rateToCny: '6',
      expiresAt: businessTime
    });
    await expect(f.resolve({ manualRate: undefined })).rejects.toThrow('缺少有效汇率');
    expect(f.tx.idBusinessV2FinanceFxRateSnapshot.findFirst).toHaveBeenCalledWith({
      where: { currency: 'USDT' },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
    });
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('propagates audit failure without scope changes or nested transactions', async () => {
    const f = fixture();
    f.tx.auditLog.create.mockRejectedValueOnce(new Error('audit failed'));
    await expect(f.resolve()).rejects.toThrow('audit failed');
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.tx.idBusinessV2ScopeVersion.updateMany).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
});
