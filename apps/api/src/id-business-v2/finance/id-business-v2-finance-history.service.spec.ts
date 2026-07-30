import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinanceHistoryService } from './id-business-v2-finance-history.service';

describe('IdBusinessV2FinanceHistoryService confirmation audit', () => {
  it('stores the integer settings key in audit data instead of the UUID objectId column', async () => {
    const completedAt = new Date('2026-07-30T01:00:00.000Z');
    const tx = {
      idBusinessV2FinanceSettings: {
        findUnique: vi.fn().mockResolvedValue({
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'incomplete',
          historyNote: '等待确认'
        }),
        update: vi.fn().mockResolvedValue({
          historyStatus: 'completed',
          historyCompletedAt: completedAt,
          historyNote: '隔离库确认测试'
        })
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const service = new IdBusinessV2FinanceHistoryService(
      prisma as never,
      {} as never,
      {} as never
    );

    await expect(service.confirm(true, '隔离库确认测试')).resolves.toMatchObject({
      historyStatus: 'completed',
      historyCompletedAt: completedAt,
      historyNote: '隔离库确认测试'
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        objectType: 'id_business_v2_finance_settings',
        objectId: null,
        beforeData: expect.objectContaining({ settingsId: 1 }),
        afterData: expect.objectContaining({ settingsId: 1 })
      })
    });
  });

  it('requires an explicit business confirmation', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new IdBusinessV2FinanceHistoryService(
      prisma as never,
      {} as never,
      {} as never
    );

    await expect(service.confirm(false, '未确认')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a stale preview fingerprint before starting the write transaction', async () => {
    const previewAsOf = new Date('2026-07-30T00:00:00.000Z');
    const prisma = { $transaction: vi.fn() };
    const historyPreviewService = {
      preview: vi.fn().mockResolvedValue({
        canBackfill: true,
        fingerprint: 'a'.repeat(64)
      })
    };
    const service = new IdBusinessV2FinanceHistoryService(
      prisma as never,
      {} as never,
      historyPreviewService as never
    );

    await expect(service.backfill('b'.repeat(64), previewAsOf)).rejects.toThrow(
      '历史数据已发生变化，请重新预览后再执行回填'
    );
    expect(historyPreviewService.preview).toHaveBeenCalledWith(previewAsOf);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('starts backfill after recomputing the matching preview at the same cutoff', async () => {
    const previewAsOf = new Date('2026-07-30T00:00:00.000Z');
    const fingerprint = 'a'.repeat(64);
    const prisma = {
      $transaction: vi.fn().mockResolvedValue({ historyStatus: 'incomplete' })
    };
    const historyPreviewService = {
      preview: vi.fn().mockResolvedValue({
        canBackfill: true,
        fingerprint
      })
    };
    const service = new IdBusinessV2FinanceHistoryService(
      prisma as never,
      {} as never,
      historyPreviewService as never
    );

    await expect(service.backfill(fingerprint, previewAsOf)).resolves.toEqual({
      historyStatus: 'incomplete'
    });
    expect(historyPreviewService.preview).toHaveBeenCalledWith(previewAsOf);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
