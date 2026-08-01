import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const orderId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const serviceOptionId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const settlementPlatformOptionId = '55555555-5555-4555-8555-555555555555';
const createdAt = new Date('2026-07-26T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V2-20260726-0001',
    customerId,
    serviceOptionId,
    accountId,
    settlementPlatformOptionId,
    platformOrderNo: 'PLATFORM-1001',
    websiteAccountEncrypted: 'v1:encrypted',
    websiteAccountHash: 'website-account-hash',
    websiteAccountMasked: 'cu***@example.com',
    receivedAmount: decimal('99.9'),
    receivedOriginalAmount: decimal('99.9'),
    receivedCurrency: 'CNY',
    receivedFxRateToCny: decimal('1'),
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedAt: createdAt,
    platformFeeAmount: decimal('2.5'),
    accountDisposition: 'retained',
    accountCostAmount: decimal('10'),
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('50'),
    refundCostAmount: null,
    profitAmount: decimal('47.4'),
    status: 'completed',
    statusChangedAt: createdAt,
    openedAt: createdAt,
    dueAt: new Date('2026-08-26T12:00:00.000Z'),
    idempotencyKey: 'secret-idempotency-key',
    remark: '真实订单',
    createdByUserId: null,
    updatedByUserId: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    customer: {
      id: customerId,
      name: '测试客户'
    },
    serviceOption: {
      id: serviceOptionId,
      code: 'chatgpt-plus',
      name: 'ChatGPT Plus',
      parent: {
        id: '66666666-6666-4666-8666-666666666666',
        name: 'AI 服务'
      }
    },
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      countryOption: {
        id: '77777777-7777-4777-8777-777777777777',
        code: 'us',
        name: '美国'
      }
    },
    settlementPlatform: {
      id: settlementPlatformOptionId,
      code: 'wechat',
      name: '微信'
    },
    ...overrides
  };
}

describe('IdBusinessV2OrdersService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Order: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn()
    }
  };
  const fieldEncryptionService = {
    hash: vi.fn()
  };
  const service = new IdBusinessV2OrdersService(
    new IdBusinessV2OrdersRepository(prisma as never),
    fieldEncryptionService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2Order.findMany.mockResolvedValue([makeOrder()]);
    prisma.idBusinessV2Order.count.mockResolvedValue(1);
    prisma.idBusinessV2Order.findFirst.mockResolvedValue(makeOrder());
    prisma.$transaction.mockImplementation(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations)
    );
    fieldEncryptionService.hash.mockReturnValue('website-account-hash');
  });

  it('returns a paginated real order list with Decimal values serialized as strings', async () => {
    const result = await service.list({
      page: '1',
      pageSize: '20',
      status: 'completed',
      sortBy: 'receivedAmount',
      sortOrder: 'desc'
    });

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          id: orderId,
          orderNo: 'V2-20260726-0001',
          receivedAmount: '99.9',
          platformFeeAmount: '2.5',
          accountDisposition: 'retained',
          accountCostAmount: '10',
          appliedAccountCostAmount: '0',
          balanceAmount: '20',
          balanceCostAmount: '50',
          profitAmount: '47.4',
          profitRate: '47.4474',
          status: 'completed'
        })
      ],
      total: 1,
      page: 1,
      pageSize: 20
    });
    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          status: 'completed'
        }),
        skip: 0,
        take: 20,
        orderBy: [{ receivedAmount: 'desc' }, { id: 'desc' }]
      })
    );
  });

  it('sorts by the newest opening time by default and keeps orders without one last', async () => {
    await service.list({});

    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { openedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' }
        ]
      })
    );
  });

  it('searches sensitive website accounts by hash without returning secrets', async () => {
    const result = await service.list({ keyword: 'customer@example.com' });
    const call = prisma.idBusinessV2Order.findMany.mock.calls[0]?.[0];

    expect(fieldEncryptionService.hash).toHaveBeenCalledWith('customer@example.com');
    expect(call.where.OR).toContainEqual({ websiteAccountHash: 'website-account-hash' });
    expect(JSON.stringify(result)).not.toContain('v1:encrypted');
    expect(JSON.stringify(result)).not.toContain('website-account-hash');
    expect(JSON.stringify(result)).not.toContain('secret-idempotency-key');
    expect(result.items[0]).toMatchObject({
      maskedWebsiteAccount: 'cu***@example.com',
      hasWebsiteAccount: true,
      account: {
        appleIdMasked: 'us***@example.com'
      }
    });
  });

  it('applies UUID and opened date filters to the database query', async () => {
    await service.list({
      customerId,
      serviceOptionId,
      accountId,
      settlementPlatformOptionId,
      openedFrom: '2026-07-01',
      openedTo: '2026-07-31'
    });

    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId,
          serviceOptionId,
          accountId,
          settlementPlatformOptionId,
          openedAt: {
            gte: new Date('2026-07-01T00:00:00.000Z'),
            lte: new Date('2026-07-31T23:59:59.999Z')
          }
        })
      })
    );
  });

  it('filters by ID handling status and returns sold ID cost as applied', async () => {
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      makeOrder({
        accountDisposition: 'sold'
      })
    ]);

    const result = await service.list({ accountDisposition: 'sold' });

    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountDisposition: 'sold'
        })
      })
    );
    expect(result.items[0]).toMatchObject({
      accountDisposition: 'sold',
      accountCostAmount: '10',
      appliedAccountCostAmount: '10'
    });
  });

  it('rejects invalid status, UUID, and date ranges before querying', async () => {
    await expect(service.list({ status: 'success' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list({ accountDisposition: 'unknown' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.list({ customerId: 'invalid' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.list({ openedFrom: '2026-08-01', openedTo: '2026-07-01' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.idBusinessV2Order.findMany).not.toHaveBeenCalled();
  });

  it('returns one order by UUID and excludes soft-deleted records', async () => {
    const result = await service.get(orderId);

    expect(prisma.idBusinessV2Order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: orderId,
          deletedAt: null
        }
      })
    );
    expect(result.orderNo).toBe('V2-20260726-0001');
  });

  it('returns not found for a missing order', async () => {
    prisma.idBusinessV2Order.findFirst.mockResolvedValue(null);

    await expect(service.get(orderId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['pending', true, false, true, true, false, true, false],
    ['processing', false, true, true, false, true, true, false],
    ['completed', false, false, true, false, true, false, false],
    ['refunded', false, false, false, false, false, false, true],
    ['cancelled', false, false, false, false, false, false, true],
    ['failed', false, false, true, false, false, true, true]
  ])(
    'returns lifecycle operation boundaries for %s orders',
    async (
      status,
      canConsume,
      canComplete,
      canEdit,
      canEditCore,
      canRefund,
      canCancel,
      canDelete
    ) => {
      prisma.idBusinessV2Order.findFirst.mockResolvedValue(makeOrder({ status }));

      const result = await service.get(orderId);

      expect(result.operations).toEqual({
        canConsume,
        canComplete,
        canEdit,
        canEditCore,
        canEditPricing: ['pending', 'processing', 'failed'].includes(status),
        canRefund,
        canCancel,
        canDelete
      });
    }
  );

  it('returns a whitelisted active lock summary without an internal lock token', async () => {
    prisma.idBusinessV2Order.findFirst.mockResolvedValue(
      makeOrder({
        locks: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            serviceOptionId,
            lockScope: 'by_service',
            status: 'active',
            lockedAt: createdAt,
            expiresAt: new Date('2026-08-26T12:00:00.000Z'),
            endedAt: null,
            endReason: null,
            reason: '订单占用',
            lockToken: 'must-not-leak'
          }
        ]
      })
    );

    const result = await service.get(orderId);

    expect(result.activeLock).toMatchObject({
      serviceOptionId,
      lockScope: 'by_service',
      status: 'active',
      reason: '订单占用'
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
});
