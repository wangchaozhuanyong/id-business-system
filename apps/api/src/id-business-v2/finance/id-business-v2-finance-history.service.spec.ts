import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinanceHistoryConfirmationService } from './id-business-v2-finance-history-confirmation.service';
import type { FinancePostingLineInput } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceHistoryService } from './id-business-v2-finance-history.service';

describe('IdBusinessV2FinanceHistoryService confirmation audit', () => {
  it('previews Cloudflare-style decimals and stores the checked snapshot in audit data', async () => {
    const completedAt = new Date('2026-07-30T01:00:00.000Z');
    const tx = {
      idBusinessV2FinanceSettings: {
        findUnique: vi.fn().mockResolvedValue({
          baseCurrency: 'CNY',
          timezone: 'Asia/Kuala_Lumpur',
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'incomplete',
          historyCompletedAt: null,
          historyNote: '等待确认'
        }),
        update: vi.fn().mockResolvedValue({
          baseCurrency: 'CNY',
          timezone: 'Asia/Kuala_Lumpur',
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'completed',
          historyCompletedAt: completedAt,
          historyNote: '已核对全部期初资料'
        })
      },
      idBusinessV2FinanceAccount: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 2 },
          _sum: {
            openingBalanceCny: cloudflareDecimal('120.25'),
            currentBalanceCny: cloudflareDecimal('350.5')
          }
        })
      },
      idBusinessV2TopupSupplierAccount: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 1 },
          _sum: {
            openingBalanceCny: cloudflareDecimal('1000'),
            currentBalanceCny: cloudflareDecimal('18677')
          }
        })
      },
      idBusinessV2FinanceExpense: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { amountCny: null }
        })
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const service = new IdBusinessV2FinanceHistoryConfirmationService(prisma as never);

    const preview = await service.preview();
    expect(preview).toMatchObject({
      canConfirm: true,
      financeAccounts: {
        count: 2,
        openingBalanceCny: '120.25',
        currentBalanceCny: '350.5'
      },
      supplierWallets: {
        count: 1,
        openingBalanceCny: '1000',
        currentBalanceCny: '18677'
      },
      historicalExpenses: { count: 0, amountCny: '0' }
    });

    await expect(
      service.confirm({
        confirmed: true,
        financeAccountsConfirmed: true,
        supplierBalancesConfirmed: true,
        historicalExpensesConfirmed: true,
        previewFingerprint: preview.fingerprint,
        note: '已核对全部期初资料'
      })
    ).resolves.toMatchObject({
      historyStatus: 'completed',
      historyCompletedAt: completedAt,
      historyNote: '已核对全部期初资料'
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        objectType: 'id_business_v2_finance_settings',
        objectId: null,
        beforeData: expect.objectContaining({ settingsId: 1 }),
        afterData: expect.objectContaining({
          settingsId: 1,
          confirmationChecklist: {
            financeAccountsConfirmed: true,
            supplierBalancesConfirmed: true,
            historicalExpensesConfirmed: true
          },
          confirmationSnapshot: expect.objectContaining({
            fingerprint: preview.fingerprint,
            historicalExpenses: { count: 0, amountCny: '0' }
          })
        })
      })
    });
    expect(tx.idBusinessV2FinanceExpense.aggregate).toHaveBeenCalledWith({
      where: { occurredAt: { lte: new Date('2026-07-30T00:00:00.000Z') } },
      _count: { _all: true },
      _sum: { amountCny: true }
    });
  });

  it('requires every checklist item and rejects numeric-only notes before the transaction', async () => {
    const prisma = { $transaction: vi.fn() };
    const service = new IdBusinessV2FinanceHistoryConfirmationService(prisma as never);

    await expect(
      service.confirm({
        confirmed: true,
        financeAccountsConfirmed: true,
        supplierBalancesConfirmed: false,
        historicalExpensesConfirmed: true,
        previewFingerprint: 'a'.repeat(64),
        note: '已完成全部核对'
      })
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.confirm({
        confirmed: true,
        financeAccountsConfirmed: true,
        supplierBalancesConfirmed: true,
        historicalExpensesConfirmed: true,
        previewFingerprint: 'a'.repeat(64),
        note: '111111'
      })
    ).rejects.toThrow('实际核对结论');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing completed confirmation', async () => {
    const tx = {
      idBusinessV2FinanceSettings: {
        findUnique: vi.fn().mockResolvedValue({
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'completed',
          historyCompletedAt: new Date('2026-07-30T01:00:00.000Z'),
          historyNote: '已完成历史核对'
        }),
        update: vi.fn()
      },
      auditLog: { create: vi.fn() }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2FinanceHistoryConfirmationService(prisma as never);

    await expect(
      service.confirm({
        confirmed: true,
        financeAccountsConfirmed: true,
        supplierBalancesConfirmed: true,
        historicalExpensesConfirmed: true,
        previewFingerprint: 'a'.repeat(64),
        note: '再次覆盖历史确认'
      })
    ).rejects.toThrow('请先重新开启核对');
    expect(tx.idBusinessV2FinanceSettings.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a changed confirmation snapshot without writing settings or audit data', async () => {
    const settings = {
      baseCurrency: 'CNY',
      timezone: 'Asia/Kuala_Lumpur',
      enabledAt: new Date('2026-07-30T00:00:00.000Z'),
      historyStatus: 'incomplete',
      historyCompletedAt: null,
      historyNote: '等待确认'
    };
    const financeAggregate = vi
      .fn()
      .mockResolvedValueOnce({
        _count: { _all: 0 },
        _sum: { openingBalanceCny: null, currentBalanceCny: null }
      })
      .mockResolvedValueOnce({
        _count: { _all: 1 },
        _sum: {
          openingBalanceCny: cloudflareDecimal('20'),
          currentBalanceCny: cloudflareDecimal('20')
        }
      });
    const tx = {
      idBusinessV2FinanceSettings: {
        findUnique: vi.fn().mockResolvedValue(settings),
        update: vi.fn()
      },
      idBusinessV2FinanceAccount: { aggregate: financeAggregate },
      idBusinessV2TopupSupplierAccount: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { openingBalanceCny: null, currentBalanceCny: null }
        })
      },
      idBusinessV2FinanceExpense: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { amountCny: null }
        })
      },
      auditLog: { create: vi.fn() }
    };
    const prisma = {
      ...tx,
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const service = new IdBusinessV2FinanceHistoryConfirmationService(prisma as never);
    const preview = await service.preview();

    await expect(
      service.confirm({
        confirmed: true,
        financeAccountsConfirmed: true,
        supplierBalancesConfirmed: true,
        historicalExpensesConfirmed: true,
        previewFingerprint: preview.fingerprint,
        note: '已核对全部历史资料'
      })
    ).rejects.toThrow('历史财务数据已发生变化');
    expect(tx.idBusinessV2FinanceSettings.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('reopens a completed confirmation and records an independent audit event', async () => {
    const completedAt = new Date('2026-07-30T01:00:00.000Z');
    const tx = {
      idBusinessV2FinanceSettings: {
        findUnique: vi.fn().mockResolvedValue({
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'completed',
          historyCompletedAt: completedAt,
          historyNote: '111111'
        }),
        update: vi.fn().mockResolvedValue({
          baseCurrency: 'CNY',
          timezone: 'Asia/Kuala_Lumpur',
          enabledAt: new Date('2026-07-30T00:00:00.000Z'),
          historyStatus: 'incomplete',
          historyCompletedAt: null,
          historyNote: '历史确认已重新开启：原确认说明为测试值，重新核对历史资料'
        })
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2FinanceHistoryConfirmationService(prisma as never);

    await expect(service.reopen('原确认说明为测试值，重新核对历史资料')).resolves.toMatchObject({
      historyStatus: 'incomplete',
      historyCompletedAt: null
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.finance.history_reopen',
        objectId: null,
        beforeData: expect.objectContaining({ historyStatus: 'completed' }),
        afterData: expect.objectContaining({ historyStatus: 'incomplete' })
      })
    });
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

function cloudflareDecimal(value: string) {
  return { toString: () => value };
}
