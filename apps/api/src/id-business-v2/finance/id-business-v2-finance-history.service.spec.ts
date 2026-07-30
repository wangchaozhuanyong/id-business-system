import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { FinancePostingLineInput } from './id-business-v2-finance-posting.service';
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

  it('rejects a stale preview fingerprint inside the transaction without producing writes', async () => {
    const previewAsOf = new Date('2026-07-30T00:00:00.000Z');
    const tx = {
      idBusinessV2FinanceSettings: {
        upsert: vi.fn()
      }
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const historyPreviewService = {
      previewInTransaction: vi.fn().mockResolvedValue({
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
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(historyPreviewService.previewInTransaction).toHaveBeenCalledWith(tx, previewAsOf);
    expect(tx.idBusinessV2FinanceSettings.upsert).not.toHaveBeenCalled();
  });

  it('posts the exact asset opening adjustments from the transaction preview', async () => {
    const previewAsOf = new Date('2026-07-30T00:00:00.000Z');
    const fingerprint = 'a'.repeat(64);
    const tx = {
      idBusinessV2FinanceSettings: {
        upsert: vi.fn().mockResolvedValue({
          enabledAt: null,
          historyStatus: 'incomplete'
        }),
        update: vi.fn().mockResolvedValue({})
      },
      idBusinessV2FinanceFxRateSnapshot: {
        findFirst: vi.fn().mockResolvedValue({ id: 'legacy-rate' })
      },
      idBusinessV2Account: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 })
      },
      idBusinessV2GiftCard: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
        findMany: vi.fn().mockResolvedValue([])
      },
      idBusinessV2Order: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([])
      },
      idBusinessV2AccountLoss: {
        findMany: vi.fn().mockResolvedValue([])
      },
      idBusinessV2FinanceJournal: {
        findUnique: vi.fn().mockResolvedValue(null)
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const postingService = {
      post: vi.fn().mockResolvedValue({})
    };
    const historyPreviewService = {
      previewInTransaction: vi.fn().mockResolvedValue({
        canBackfill: true,
        fingerprint,
        asOf: previewAsOf,
        assetOpening: {
          willCreate: true,
          adjustmentTotalCny: '1185.6',
          journalLineCount: 4,
          adjustments: [
            {
              accountCode: 'gift_card_inventory',
              direction: 'debit',
              amountCny: '1145.6'
            },
            {
              accountCode: 'id_inventory',
              direction: 'debit',
              amountCny: '40'
            }
          ]
        }
      })
    };
    const service = new IdBusinessV2FinanceHistoryService(
      prisma as never,
      postingService as never,
      historyPreviewService as never
    );

    await expect(service.backfill(fingerprint, previewAsOf)).resolves.toMatchObject({
      enabledAt: previewAsOf,
      historyStatus: 'incomplete',
      summary: {
        assetOpeningCreated: true
      }
    });
    expect(historyPreviewService.previewInTransaction).toHaveBeenCalledWith(tx, previewAsOf);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(postingService.post).toHaveBeenCalledTimes(1);
    const openingPosting = postingService.post.mock.calls[0]?.[1];
    expect(openingPosting).toMatchObject({
      journalType: 'opening_balance',
      idempotencyKey: 'legacy:asset_opening:v1'
    });
    expect(
      openingPosting.lines.map((line: FinancePostingLineInput) => ({
        accountCode: line.accountCode,
        direction: line.direction,
        amountCny: line.amountCny.toString()
      }))
    ).toEqual([
      { accountCode: 'gift_card_inventory', direction: 'debit', amountCny: '1145.6' },
      { accountCode: 'opening_equity', direction: 'credit', amountCny: '1145.6' },
      { accountCode: 'id_inventory', direction: 'debit', amountCny: '40' },
      { accountCode: 'opening_equity', direction: 'credit', amountCny: '40' }
    ]);
  });
});
