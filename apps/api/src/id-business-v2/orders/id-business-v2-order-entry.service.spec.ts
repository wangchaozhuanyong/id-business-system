import { BadRequestException, ConflictException } from '@nestjs/common';
import { IdBusinessV2AccountLockScope, Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2OrderEntryService } from './id-business-v2-order-entry.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const serviceOptionId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const settlementPlatformOptionId = '55555555-5555-4555-8555-555555555555';
const lockId = '66666666-6666-4666-8666-666666666666';
const openedAt = new Date('2030-07-26T12:00:00.000Z');
const dueAt = new Date('2030-08-26T12:00:00.000Z');
const operator = {
  id: '77777777-7777-4777-8777-777777777777',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.create']
};

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeDto(overrides: Record<string, unknown> = {}) {
  return {
    customerId,
    serviceOptionId,
    accountId,
    settlementPlatformOptionId,
    platformOrderNo: 'PLATFORM-1001',
    websiteAccount: 'customer@example.com',
    receivedAmount: '100',
    accountDisposition: 'retained',
    balanceAmount: '20',
    openedAt: openedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    lockScope: IdBusinessV2AccountLockScope.by_service,
    idempotencyKey: 'order-request-1001',
    remark: '待处理订单',
    ...overrides
  };
}

function makeLock(overrides: Record<string, unknown> = {}) {
  return {
    id: lockId,
    accountId,
    serviceOptionId,
    orderId,
    lockScope: IdBusinessV2AccountLockScope.by_service,
    status: 'active',
    lockToken: 'must-not-leak',
    reason: '订单录入',
    lockedAt: openedAt,
    expiresAt: dueAt,
    endedAt: null,
    endReason: null,
    createdByUserId: operator.id,
    endedByUserId: null,
    createdAt: openedAt,
    updatedAt: openedAt,
    ...overrides
  };
}

function makeStoredOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V220300726ABCDEF123456',
    customerId,
    serviceOptionId,
    accountId,
    settlementPlatformOptionId,
    platformOrderNo: 'PLATFORM-1001',
    websiteAccountEncrypted: 'v1:encrypted',
    websiteAccountHash: 'website-hash',
    websiteAccountMasked: 'cu***@example.com',
    receivedAmount: decimal('100'),
    platformFeeAmount: decimal('3'),
    accountDisposition: 'retained',
    accountCostAmount: decimal('0'),
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('0'),
    refundCostAmount: null,
    profitAmount: null,
    status: 'pending',
    statusChangedAt: openedAt,
    openedAt,
    dueAt,
    idempotencyKey: 'order_entry:order-request-1001',
    remark: '待处理订单',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: openedAt,
    updatedAt: openedAt,
    deletedAt: null,
    ...overrides
  };
}

describe('IdBusinessV2OrderEntryService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Customer: {
      findFirst: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2Order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2Account: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Customer: {
      findMany: vi.fn()
    },
    idBusinessV2Option: {
      findMany: vi.fn()
    },
    idBusinessV2Order: {
      findUnique: vi.fn()
    }
  };
  const fieldEncryptionService = {
    encrypt: vi.fn(),
    hash: vi.fn()
  };
  const ordersService = {
    get: vi.fn()
  };
  const orderLockService = {
    reserveAccountForOrderInTransaction: vi.fn()
  };
  const service = new IdBusinessV2OrderEntryService(
    prisma as never,
    fieldEncryptionService as never,
    ordersService as never,
    orderLockService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (argument: unknown) => {
      if (Array.isArray(argument)) return Promise.all(argument);
      return (argument as (client: typeof tx) => Promise<unknown>)(tx);
    });
    tx.idBusinessV2Order.findUnique.mockResolvedValue(null);
    tx.idBusinessV2Customer.findFirst.mockResolvedValue({ id: customerId });
    tx.idBusinessV2Option.findFirst.mockImplementation(
      async ({ where }: { where: { type: string } }) => {
        if (where.type === 'service') return { id: serviceOptionId };
        if (where.type === 'settlement_platform') {
          return {
            id: settlementPlatformOptionId,
            fixedFee: decimal('1'),
            percentageFee: decimal('2')
          };
        }
        return null;
      }
    );
    tx.idBusinessV2Order.create.mockResolvedValue(makeStoredOrder({ accountId: null }));
    tx.idBusinessV2Order.findUniqueOrThrow.mockResolvedValue(makeStoredOrder());
    tx.$queryRaw.mockResolvedValue([
      {
        id: accountId,
        purchaseCost: decimal('25'),
        soldByOrderId: null
      }
    ]);
    tx.idBusinessV2Account.findUnique.mockResolvedValue({
      purchaseCost: decimal('25'),
      soldByOrderId: null
    });
    tx.idBusinessV2Account.update.mockResolvedValue({});
    tx.idBusinessV2Order.update.mockResolvedValue({});
    orderLockService.reserveAccountForOrderInTransaction.mockResolvedValue({
      order: {
        id: orderId,
        orderNo: 'V220300726ABCDEF123456',
        serviceOptionId
      },
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: '30',
        balanceCostAmount: '180'
      },
      lock: {
        id: lockId,
        serviceOptionId,
        lockScope: 'by_service',
        status: 'active',
        lockedAt: openedAt,
        expiresAt: dueAt,
        endedAt: null,
        endReason: null,
        reason: '订单录入'
      },
      idempotentReplay: false
    });
    fieldEncryptionService.encrypt.mockReturnValue('v1:encrypted');
    fieldEncryptionService.hash.mockReturnValue('website-hash');
    ordersService.get.mockResolvedValue({
      id: orderId,
      orderNo: 'V220300726ABCDEF123456',
      status: 'pending',
      platformFeeAmount: '3'
    });
  });

  it('creates a pending order and a real ID lock in one transaction with server-calculated fees', async () => {
    const result = await service.create(makeDto(), operator);

    expect(tx.idBusinessV2Order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId,
        serviceOptionId,
        accountId: null,
        settlementPlatformOptionId,
        platformOrderNo: 'PLATFORM-1001',
        websiteAccountEncrypted: 'v1:encrypted',
        websiteAccountHash: 'website-hash',
        websiteAccountMasked: 'cu***@example.com',
        receivedAmount: decimal('100'),
        platformFeeAmount: decimal('3'),
        accountDisposition: 'retained',
        accountCostAmount: 0,
        balanceAmount: decimal('20'),
        balanceCostAmount: 0,
        refundCostAmount: null,
        profitAmount: null,
        status: 'pending',
        openedAt,
        dueAt,
        idempotencyKey: 'order_entry:order-request-1001'
      })
    });
    expect(orderLockService.reserveAccountForOrderInTransaction).toHaveBeenCalledWith(
      tx,
      {
        orderId,
        accountId,
        expiresAt: dueAt,
        lockScope: 'by_service',
        reason: '订单录入'
      },
      operator
    );
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: { id: orderId },
      data: expect.objectContaining({
        accountDisposition: 'retained',
        accountCostAmount: 0
      })
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    const auditPayload = tx.auditLog.create.mock.calls[0]?.[0];
    expect(JSON.stringify(auditPayload)).not.toContain('customer@example.com');
    expect(JSON.stringify(auditPayload)).not.toContain('order-request-1001');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(result).toMatchObject({
      order: {
        id: orderId,
        status: 'pending',
        platformFeeAmount: '3'
      },
      lock: {
        id: lockId,
        status: 'active'
      },
      idempotentReplay: false,
      nextStep: 'waiting_balance_consumption'
    });
  });

  it('globally occupies a sold ID and snapshots its purchase cost in the same transaction', async () => {
    tx.idBusinessV2Order.findUniqueOrThrow.mockResolvedValueOnce(
      makeStoredOrder({
        accountDisposition: 'sold',
        accountCostAmount: decimal('25')
      })
    );
    orderLockService.reserveAccountForOrderInTransaction.mockResolvedValueOnce({
      order: {
        id: orderId,
        orderNo: 'V220300726ABCDEF123456',
        serviceOptionId
      },
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: '30',
        balanceCostAmount: '180'
      },
      lock: {
        id: lockId,
        serviceOptionId: null,
        lockScope: 'global',
        status: 'active',
        lockedAt: openedAt,
        expiresAt: dueAt,
        endedAt: null,
        endReason: null,
        reason: '订单录入'
      },
      idempotentReplay: false
    });

    await service.create(makeDto({ accountDisposition: 'sold' }), operator);

    expect(orderLockService.reserveAccountForOrderInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId,
        accountId,
        lockScope: 'global'
      }),
      operator
    );
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: expect.objectContaining({
        soldByOrderId: orderId,
        soldAt: expect.any(Date)
      })
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: { id: orderId },
      data: expect.objectContaining({
        accountDisposition: 'sold',
        accountCostAmount: decimal('25')
      })
    });
  });

  it('returns the original order for an exact idempotent replay without writing again', async () => {
    tx.idBusinessV2Order.findUnique.mockResolvedValue({
      ...makeStoredOrder(),
      locks: [makeLock()]
    });

    const result = await service.create(makeDto(), operator);

    expect(result.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2Customer.findFirst).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Option.findFirst).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.create).not.toHaveBeenCalled();
    expect(orderLockService.reserveAccountForOrderInTransaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects reusing an idempotency key for different order content', async () => {
    tx.idBusinessV2Order.findUnique.mockResolvedValue({
      ...makeStoredOrder({ receivedAmount: decimal('99') }),
      locks: [makeLock()]
    });

    await expect(service.create(makeDto(), operator)).rejects.toThrow('幂等键已用于其他订单内容');
    expect(tx.idBusinessV2Order.create).not.toHaveBeenCalled();
  });

  it('propagates a lock conflict so the surrounding order transaction rolls back', async () => {
    orderLockService.reserveAccountForOrderInTransaction.mockRejectedValue(
      new ConflictException('该 ID 的当前业务已被其他订单锁定')
    );

    await expect(service.create(makeDto(), operator)).rejects.toThrow(
      '该 ID 的当前业务已被其他订单锁定'
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(ordersService.get).not.toHaveBeenCalled();
  });

  it('rechecks active customer, service, and settlement platform before creating', async () => {
    tx.idBusinessV2Customer.findFirst.mockResolvedValue(null);
    await expect(service.create(makeDto(), operator)).rejects.toThrow('客户不存在、已停用或已删除');

    tx.idBusinessV2Customer.findFirst.mockResolvedValue({ id: customerId });
    tx.idBusinessV2Option.findFirst.mockResolvedValueOnce(null);
    await expect(service.create(makeDto(), operator)).rejects.toThrow(
      '业务不存在、已停用或尚未配置国家、金额和货币'
    );

    tx.idBusinessV2Option.findFirst
      .mockResolvedValueOnce({ id: serviceOptionId })
      .mockResolvedValueOnce(null);
    await expect(service.create(makeDto(), operator)).rejects.toThrow('结算平台不存在或已停用');
  });

  it('rejects a calculated platform fee that exceeds the order Decimal limit', async () => {
    tx.idBusinessV2Option.findFirst.mockImplementation(
      async ({ where }: { where: { type: string } }) => {
        if (where.type === 'service') return { id: serviceOptionId };
        if (where.type === 'settlement_platform') {
          return {
            id: settlementPlatformOptionId,
            fixedFee: decimal('99999999999999'),
            percentageFee: decimal('100')
          };
        }
        return null;
      }
    );

    await expect(
      service.create(
        makeDto({
          receivedAmount: '99999999999999.999'
        }),
        operator
      )
    ).rejects.toThrow('平台手续费数值过大');
    expect(tx.idBusinessV2Order.create).not.toHaveBeenCalled();
    expect(orderLockService.reserveAccountForOrderInTransaction).not.toHaveBeenCalled();
  });

  it('maps a concurrent idempotency unique race to the committed original order', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    prisma.idBusinessV2Order.findUnique.mockResolvedValue({
      ...makeStoredOrder(),
      locks: [makeLock()]
    });

    const result = await service.create(makeDto(), operator);

    expect(result.idempotentReplay).toBe(true);
    expect(ordersService.get).toHaveBeenCalledWith(orderId);
  });

  it('rejects an unrelated unique conflict instead of claiming the order was created', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    prisma.idBusinessV2Order.findUnique.mockResolvedValue(null);

    await expect(service.create(makeDto(), operator)).rejects.toThrow(
      '平台订单号已存在或订单刚被其他请求创建'
    );
    expect(ordersService.get).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts, dates, platform pairing, and lock scope before writes', async () => {
    await expect(service.create(makeDto({ balanceAmount: '0' }), operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.create(makeDto({ receivedAmount: '-1' }), operator)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(makeDto({ dueAt: openedAt.toISOString() }), operator)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        makeDto({
          settlementPlatformOptionId: null,
          platformOrderNo: 'PLATFORM-1001'
        }),
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(makeDto({ lockScope: 'unsupported' }), operator)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns only active entry options with Decimal settlement fee strings', async () => {
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([
      {
        id: customerId,
        name: '客户 A',
        wechat: 'customer-a',
        phoneMasked: '138****5678'
      }
    ]);
    prisma.idBusinessV2Option.findMany
      .mockResolvedValueOnce([
        {
          id: '88888888-8888-4888-8888-888888888888',
          code: 'us',
          name: '美国',
          currencyCode: 'USD'
        }
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: settlementPlatformOptionId,
          code: 'wechat',
          name: '微信',
          fixedFee: decimal('1.5'),
          percentageFee: decimal('2.25')
        }
      ]);

    const result = await service.getEntryOptions('13800135678');

    expect(result).toEqual({
      customers: [
        {
          id: customerId,
          name: '客户 A',
          wechat: 'customer-a',
          maskedPhone: '138****5678'
        }
      ],
      countries: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          code: 'us',
          name: '美国',
          currencyCode: 'USD',
          children: []
        }
      ],
      settlementPlatforms: [
        {
          id: settlementPlatformOptionId,
          code: 'wechat',
          name: '微信',
          fixedFee: '1.5',
          percentageFee: '2.25'
        }
      ]
    });
    expect(prisma.idBusinessV2Customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          recordStatus: 'active'
        }),
        select: {
          id: true,
          name: true,
          wechat: true,
          phoneMasked: true
        },
        take: 50
      })
    );
    expect(JSON.stringify(result)).not.toContain('phoneEncrypted');
  });
});
