import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';
import { IdBusinessV2TopupWorkbenchService } from './id-business-v2-topup-workbench.service';

const country = { id: 'country-1', code: 'us', name: '美国' };
const status = { id: 'status-1', code: 'normal', name: '正常', isSystem: true };
const streamingService = {
  id: 'service-1',
  code: 'streaming_monthly',
  name: '流媒体月卡',
  parent: { id: 'category-1', name: '流媒体' }
};
const storageService = {
  id: 'service-2',
  code: 'storage_monthly',
  name: '云存储月卡',
  parent: { id: 'category-2', name: '云服务' }
};
const cancelledService = {
  id: 'service-3',
  code: 'cancelled_service',
  name: '已取消业务',
  parent: null
};

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    appleIdMasked: 'us***@example.com',
    currentBalance: new Prisma.Decimal(20),
    balanceCostAmount: new Prisma.Decimal(50),
    updatedAt: new Date('2026-07-26T08:00:00.000Z'),
    countryOption: country,
    statusOption: status,
    giftCards: [{ createdAt: new Date('2026-07-26T06:00:00.000Z') }],
    activations: [
      {
        id: 'activation-current',
        status: 'active',
        openedAt: new Date('2026-07-25T08:00:00.000Z'),
        dueAt: new Date('2026-08-25T08:00:00.000Z'),
        serviceOption: streamingService
      },
      {
        id: 'activation-expired-stale-status',
        status: 'active',
        openedAt: new Date('2026-06-25T08:00:00.000Z'),
        dueAt: new Date('2026-07-25T08:00:00.000Z'),
        serviceOption: storageService
      },
      {
        id: 'activation-duplicate-history',
        status: 'expired',
        openedAt: new Date('2026-05-25T08:00:00.000Z'),
        dueAt: new Date('2026-06-25T08:00:00.000Z'),
        serviceOption: streamingService
      },
      {
        id: 'activation-cancelled',
        status: 'cancelled',
        openedAt: new Date('2026-04-25T08:00:00.000Z'),
        dueAt: null,
        serviceOption: cancelledService
      }
    ],
    _count: {
      giftCards: 2,
      balanceLedger: 3
    },
    ...overrides
  };
}

describe('IdBusinessV2TopupWorkbenchService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Account: {
      findMany: vi.fn(),
      count: vi.fn()
    }
  };
  const service = new IdBusinessV2TopupWorkbenchService(
    prisma as never,
    new IdBusinessV2BalanceCalculatorService()
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T12:00:00.000Z'));
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
    prisma.idBusinessV2Account.findMany.mockResolvedValue([makeAccount()]);
    prisma.idBusinessV2Account.count.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns real balance snapshots, counts, services and moving average cost', async () => {
    const result = await service.list({});

    expect(result).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 20,
      evaluatedAt: new Date('2026-07-26T12:00:00.000Z'),
      items: [
        {
          id: 'account-1',
          appleIdMasked: 'us***@example.com',
          currentBalance: '20',
          balanceCostAmount: '50',
          averageCost: '2.5',
          topupRecordCount: 2,
          balanceChangeCount: 3,
          lastTopupAt: new Date('2026-07-26T06:00:00.000Z'),
          historicalServices: [streamingService, storageService, cancelledService],
          currentServices: [streamingService],
          serviceDataAvailable: true
        }
      ]
    });
    expect(result.items[0]).not.toHaveProperty('sortOrder');
    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('treats an active activation without a due date as current', async () => {
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      makeAccount({
        activations: [
          {
            id: 'activation-open-ended',
            status: 'active',
            openedAt: new Date('2026-07-25T08:00:00.000Z'),
            dueAt: null,
            serviceOption: storageService
          }
        ]
      })
    ]);

    const result = await service.list({});

    expect(result.items[0]?.historicalServices).toEqual([storageService]);
    expect(result.items[0]?.currentServices).toEqual([storageService]);
  });

  it('filters active non-deleted accounts by country, zero balance and normal system status', async () => {
    await service.list({
      countryOptionId: 'country-1',
      balancePreset: 'zero',
      onlyNormal: 'true'
    });

    const call = prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0];
    expect(call).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          recordStatus: 'active',
          soldByOrderId: null,
          countryOptionId: 'country-1',
          statusOption: {
            is: {
              type: 'id_status',
              code: 'normal',
              status: 'active',
              deletedAt: null
            }
          }
        })
      })
    );
    expect(call.where.currentBalance.equals.toString()).toBe('0');
    expect(call.include.activations).toEqual(
      expect.objectContaining({
        orderBy: [{ openedAt: 'desc' }, { id: 'asc' }]
      })
    );
  });

  it('uses strict greater-than and less-than bounds for the low-balance preset', async () => {
    await service.list({ balancePreset: 'positive_under_20' });

    const balanceFilter =
      prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0].where.currentBalance;
    expect(balanceFilter.gt.toString()).toBe('0');
    expect(balanceFilter.lt.toString()).toBe('20');
  });

  it('applies a valid custom range, pagination and supported sorting', async () => {
    await service.list({
      page: '2',
      pageSize: '10',
      balancePreset: 'custom',
      balanceMin: '5.25',
      balanceMax: '40',
      sortBy: 'currentBalance',
      sortOrder: 'desc'
    });

    const call = prisma.idBusinessV2Account.findMany.mock.calls[0]?.[0];
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
    expect(call.orderBy).toEqual([
      { currentBalance: 'desc' },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ]);
    expect(call.where.currentBalance.gte.toString()).toBe('5.25');
    expect(call.where.currentBalance.lte.toString()).toBe('40');
  });

  it('rejects an inverted custom balance range before querying', async () => {
    await expect(
      service.list({
        balancePreset: 'custom',
        balanceMin: '20',
        balanceMax: '10'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.idBusinessV2Account.findMany).not.toHaveBeenCalled();
  });

  it('rejects custom bounds unless the custom preset is selected', async () => {
    await expect(service.list({ balanceMin: '10' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
