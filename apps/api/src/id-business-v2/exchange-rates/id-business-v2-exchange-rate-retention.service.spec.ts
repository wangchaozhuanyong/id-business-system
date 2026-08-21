import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateRetentionService } from './id-business-v2-exchange-rate-retention.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';

describe('IdBusinessV2ExchangeRateRetentionService', () => {
  const result = {
    cutoff: '2026-06-28T10:00:00.000Z',
    retentionDays: 30,
    deletedRuns: 2,
    deletedSnapshots: 1,
    deletedProviderSnapshots: 4,
    deletedQuoteSamples: 96,
    deletedFxRateSnapshots: 3,
    preservedReferencedRuns: 1,
    preservedReferencedFxRateSnapshots: 2
  };
  const tx = {
    auditLog: { create: vi.fn() }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const repository = {
    cleanupHistory: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateRetentionService(
    repository as never,
    new V2CommandTransactionManager(prisma as never),
    new V2TransactionalAuditService()
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    repository.cleanupHistory.mockResolvedValue(result);
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('runs configured retention cleanup and records aggregate audit evidence', async () => {
    await expect(service.cleanup()).resolves.toEqual(result);
    expect(repository.cleanupHistory).toHaveBeenCalledWith(tx);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.exchange_rate.retention_cleanup',
        afterData: result
      })
    });
  });

  it('rejects malformed database cleanup results', async () => {
    repository.cleanupHistory.mockResolvedValue({ cutoff: '' });
    await expect(service.cleanup()).rejects.toThrow('汇率保留清理');
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not create a repetitive audit row when nothing was deleted', async () => {
    const emptyResult = {
      ...result,
      deletedRuns: 0,
      deletedSnapshots: 0,
      deletedProviderSnapshots: 0,
      deletedQuoteSamples: 0,
      deletedFxRateSnapshots: 0
    };
    repository.cleanupHistory.mockResolvedValue(emptyResult);

    await expect(service.cleanup()).resolves.toEqual(emptyResult);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
