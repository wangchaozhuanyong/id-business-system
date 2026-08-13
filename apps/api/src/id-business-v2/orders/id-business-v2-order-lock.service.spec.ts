import { BadRequestException } from '@nestjs/common';
import { IdBusinessV2AccountLockScope, Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const orderId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const serviceOptionId = '33333333-3333-4333-8333-333333333333';
const lockId = '44444444-4444-4444-8444-444444444444';
const categoryOptionId = '99999999-9999-4999-8999-999999999999';
const operator = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.create', 'apple.order.update']
};
const lockedAt = new Date('2026-07-26T12:00:00.000Z');
const expiresAt = new Date('2030-08-26T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V2-20260726-0001',
    customerId: '88888888-8888-4888-8888-888888888888',
    serviceOptionId,
    accountId: null,
    settlementPlatformOptionId: null,
    platformOrderNo: null,
    websiteAccountEncrypted: null,
    websiteAccountHash: null,
    websiteAccountMasked: null,
    receivedAmount: decimal('100'),
    receivedOriginalAmount: decimal('100'),
    receivedCurrency: 'CNY',
    receivedFxRateToCny: decimal('1'),
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedAt: lockedAt,
    platformFeeAmount: decimal('3'),
    accountDisposition: 'retained',
    accountCostAmount: decimal('0'),
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('0'),
    refundCostAmount: null,
    profitAmount: null,
    status: 'pending',
    statusChangedAt: lockedAt,
    openedAt: lockedAt,
    dueAt: expiresAt,
    idempotencyKey: 'order-lock-service-spec',
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: lockedAt,
    updatedAt: lockedAt,
    deletedAt: null,
    ...overrides
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    appleIdMasked: 'us***@example.com',
    currentBalance: decimal('30'),
    balanceCostAmount: decimal('180'),
    purchaseCost: decimal('25'),
    soldByOrderId: null,
    soldByCustomerId: null,
    lossReportedAt: null,
    countryOptionId: '66666666-6666-4666-8666-666666666666',
    statusCode: 'normal',
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
    lockToken: 'secret-lock-token',
    reason: '订单录入',
    lockedAt,
    expiresAt,
    endedAt: null,
    endReason: null,
    ...overrides
  };
}

function makeConsumption(overrides: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    accountId,
    giftCardId: null,
    orderId,
    entryType: 'order_consumption',
    direction: 'debit',
    balanceAmount: decimal('20'),
    costAmount: decimal('120'),
    balanceBefore: decimal('30'),
    balanceAfter: decimal('10'),
    costBefore: decimal('180'),
    costAfter: decimal('60'),
    averageCostBefore: decimal('6'),
    averageCostAfter: decimal('6'),
    reversalOfEntryId: null,
    idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
    remark: null,
    createdByUserId: operator.id,
    createdAt: lockedAt,
    ...overrides
  };
}

describe('IdBusinessV2OrderLockService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2AccountLock: {
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2Order: {
      update: vi.fn(),
      findFirst: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findUnique: vi.fn()
    },
    idBusinessV2Activation: {
      findFirst: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const service = new IdBusinessV2OrderLockService(
    new IdBusinessV2OrdersRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    );
    tx.$queryRaw.mockResolvedValueOnce([makeOrder()]).mockResolvedValueOnce([makeAccount()]);
    tx.idBusinessV2Option.findFirst.mockResolvedValue({
      countryOptionId: '66666666-6666-4666-8666-666666666666',
      parent: { id: categoryOptionId }
    });
    tx.idBusinessV2Activation.findFirst.mockResolvedValue(null);
    tx.idBusinessV2AccountLock.updateMany.mockResolvedValue({ count: 0 });
    tx.idBusinessV2AccountLock.findMany.mockResolvedValue([]);
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValue(null);
    tx.idBusinessV2AccountLock.create.mockResolvedValue(makeLock());
    tx.idBusinessV2AccountLock.update.mockImplementation(async ({ data }) =>
      makeLock({
        ...data
      })
    );
    tx.idBusinessV2Order.update.mockImplementation(async ({ data }) =>
      makeOrder({
        accountId,
        ...data
      })
    );
    tx.idBusinessV2Order.findFirst.mockResolvedValue(null);
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('locks the order and account rows, expires stale locks, and creates an audited database lock', async () => {
    tx.idBusinessV2AccountLock.findMany.mockResolvedValueOnce([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        orderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        accountId,
        expiresAt: new Date('2026-07-01T00:00:00.000Z')
      }
    ]);

    const result = await service.reserveAccountForOrder(
      {
        orderId,
        accountId,
        expiresAt,
        reason: '订单录入'
      },
      operator
    );

    const orderSql = tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    const accountSql = tx.$queryRaw.mock.calls[1]?.[0] as TemplateStringsArray;
    expect(Array.from(orderSql).join('')).toContain('FOR UPDATE');
    expect(Array.from(accountSql).join('')).toContain('FOR UPDATE OF account');
    expect(tx.idBusinessV2AccountLock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: {
            in: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
          },
          status: 'active'
        }),
        data: expect.objectContaining({
          status: 'expired',
          endedAt: expect.any(Date)
        })
      })
    );
    expect(tx.idBusinessV2AccountLock.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId,
        serviceOptionId,
        orderId,
        lockScope: 'by_service',
        status: 'active',
        lockToken: expect.stringMatching(/^[a-f0-9]{32}$/),
        expiresAt,
        createdByUserId: operator.id
      })
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: {
        id: orderId
      },
      data: {
        accountId,
        updatedByUserId: operator.id
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.order_lock.expired',
          objectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        })
      })
    );
    expect(result).toMatchObject({
      order: {
        id: orderId
      },
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com'
      },
      lock: {
        id: lockId,
        lockScope: 'by_service',
        status: 'active'
      },
      idempotentReplay: false
    });
    expect(JSON.stringify(result)).not.toContain('secret-lock-token');
  });

  it('returns an exact active lock as an idempotent replay without creating another lock', async () => {
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(makeLock());

    const result = await service.reserveAccountForOrder(
      {
        orderId,
        accountId,
        expiresAt,
        reason: '订单录入'
      },
      operator
    );

    expect(result.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2AccountLock.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects an idempotent replay when the existing order lock has different content', async () => {
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(
      makeLock({
        expiresAt: new Date('2031-08-26T12:00:00.000Z')
      })
    );

    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt,
        reason: '订单录入'
      })
    ).rejects.toThrow('订单已有不同的活动锁，不能用新内容覆盖');
    expect(tx.idBusinessV2AccountLock.create).not.toHaveBeenCalled();
  });

  it('rejects a same-service or global conflict held by another order', async () => {
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
      makeLock({
        id: '88888888-8888-4888-8888-888888888888',
        orderId: '99999999-9999-4999-8999-999999999999',
        lockScope: 'global',
        serviceOptionId: null
      })
    );

    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt
      })
    ).rejects.toThrow('该 ID 已被其他订单全局锁定');
    expect(tx.idBusinessV2AccountLock.create).not.toHaveBeenCalled();
  });

  it('treats any existing account lock as a conflict for a requested global lock', async () => {
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(
      makeLock({
        orderId: '99999999-9999-4999-8999-999999999999'
      })
    );

    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt,
        lockScope: 'global'
      })
    ).rejects.toThrow('该 ID 已有其他业务占用，不能全局锁定');

    const conflictQuery = tx.idBusinessV2AccountLock.findFirst.mock.calls[1]?.[0];
    expect(conflictQuery.where.OR).toBeUndefined();
  });

  it('rejects reserving an ID that has an active unrenewed activation in the same category', async () => {
    tx.idBusinessV2Activation.findFirst.mockResolvedValueOnce({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      dueAt: expiresAt
    });

    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt
      })
    ).rejects.toThrow('该 ID 已有同类业务未到期，不能再次匹配');

    expect(tx.idBusinessV2Activation.findFirst).toHaveBeenCalledWith({
      where: {
        accountId,
        status: 'active',
        renewedBy: { is: null },
        orderId: { not: orderId },
        serviceOption: {
          is: {
            type: 'service',
            parentId: categoryOptionId
          }
        },
        OR: [
          { dueAt: null },
          {
            dueAt: {
              gt: expect.any(Date)
            }
          }
        ]
      },
      select: { id: true, dueAt: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }]
    });
    expect(tx.idBusinessV2AccountLock.create).not.toHaveBeenCalled();
  });

  it('rechecks normal status, balance, and country after taking row locks', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([makeOrder()])
      .mockResolvedValueOnce([
        makeAccount({
          statusCode: 'frozen'
        })
      ]);
    await expect(service.reserveAccountForOrder({ orderId, accountId, expiresAt })).rejects.toThrow(
      '只有状态正常的 ID 才能锁定或扣减余额'
    );

    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([makeOrder()])
      .mockResolvedValueOnce([
        makeAccount({
          currentBalance: decimal('19.9999')
        })
      ]);
    await expect(service.reserveAccountForOrder({ orderId, accountId, expiresAt })).rejects.toThrow(
      'ID 余额不足，需要 20，当前 19.9999'
    );

    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([makeOrder()])
      .mockResolvedValueOnce([makeAccount()]);
    tx.idBusinessV2Option.findFirst.mockResolvedValueOnce({
      countryOptionId: '77777777-7777-4777-8777-777777777777',
      parent: { id: categoryOptionId }
    });
    await expect(service.reserveAccountForOrder({ orderId, accountId, expiresAt })).rejects.toThrow(
      'ID 国家与订单业务所属国家不一致'
    );

    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([makeOrder()])
      .mockResolvedValueOnce([
        makeAccount({
          soldByOrderId: '99999999-9999-4999-8999-999999999999'
        })
      ]);
    tx.idBusinessV2Option.findFirst.mockResolvedValueOnce({
      countryOptionId: '66666666-6666-4666-8666-666666666666',
      parent: { id: categoryOptionId }
    });
    await expect(service.reserveAccountForOrder({ orderId, accountId, expiresAt })).rejects.toThrow(
      '该 ID 已售出，请使用客户已购 ID 模式'
    );
  });

  it('allows an existing customer-owned order to continue after its source sale was corrected', async () => {
    const sourceSoldOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        makeOrder({
          accountId,
          accountSource: 'customer_owned',
          sourceSoldOrderId
        })
      ])
      .mockResolvedValueOnce([makeAccount()]);
    tx.idBusinessV2Order.findFirst.mockResolvedValueOnce({ id: sourceSoldOrderId });

    await service.reserveAccountForOrder({ orderId, accountId, expiresAt }, operator);

    expect(tx.idBusinessV2Order.findFirst).toHaveBeenCalledWith({
      where: {
        id: sourceSoldOrderId,
        accountId,
        customerId: '88888888-8888-4888-8888-888888888888',
        accountDisposition: 'recovered',
        status: { in: ['completed', 'refunded'] },
        deletedAt: null
      },
      select: { id: true }
    });
    expect(tx.idBusinessV2AccountLock.create).toHaveBeenCalledOnce();
  });

  it('maps a database unique-index race to an explicit concurrency conflict', async () => {
    tx.idBusinessV2AccountLock.create.mockRejectedValue({
      code: 'P2002'
    });

    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt
      })
    ).rejects.toThrow('ID 或订单刚被其他请求锁定，请重新匹配后再试');
  });

  it('releases an active lock and writes lifecycle evidence', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([
      makeOrder({
        accountId
      })
    ]);
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(makeLock());
    tx.$queryRaw.mockResolvedValueOnce([makeAccount()]);

    const result = await service.releaseOrderLock(orderId, '订单取消', operator);

    expect(tx.idBusinessV2AccountLock.update).toHaveBeenCalledWith({
      where: {
        id: lockId
      },
      data: {
        status: 'released',
        endedAt: expect.any(Date),
        endReason: '订单取消',
        endedByUserId: operator.id
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.order_lock.released',
          objectId: lockId
        })
      })
    );
    expect(result).toMatchObject({
      orderId,
      released: true,
      alreadyEnded: false,
      lock: {
        status: 'released',
        endReason: '订单取消'
      }
    });
  });

  it('narrows the source sale global lock to its service when correcting the sale flag', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([makeOrder({ accountId })]);
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(
      makeLock({ lockScope: 'global', serviceOptionId: null })
    );

    const result = await service.narrowOrderLockToServiceInTransaction(
      tx as never,
      orderId,
      '纠正 ID 售出记录',
      operator
    );

    expect(tx.idBusinessV2AccountLock.update).toHaveBeenCalledWith({
      where: { id: lockId },
      data: {
        lockScope: 'by_service',
        serviceOptionId
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.order_lock.narrow_to_service',
          objectId: lockId
        })
      })
    );
    expect(result).toMatchObject({
      changed: true,
      lock: { lockScope: 'by_service', serviceOptionId }
    });
  });

  it('returns the original consumption for a matching idempotent replay before requiring an active lock', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([
      makeOrder({
        accountId,
        status: 'completed'
      })
    ]);
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(makeConsumption());

    const result = await service.prepareOrderConsumptionInTransaction(tx as never, {
      orderId,
      idempotencyKey: 'consume-request-1'
    });

    expect(result.idempotentReplay).toBe(true);
    expect(result.existingEntry?.id).toBe('77777777-7777-4777-8777-777777777777');
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2AccountLock.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a second consumption request with a different idempotency key', async () => {
    tx.$queryRaw.mockReset().mockResolvedValueOnce([
      makeOrder({
        accountId
      })
    ]);
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(makeConsumption());

    await expect(
      service.prepareOrderConsumptionInTransaction(tx as never, {
        orderId,
        idempotencyKey: 'consume-request-2'
      })
    ).rejects.toThrow('订单余额已经扣减，不能使用新的请求重复扣款');
  });

  it('returns a locked account snapshot only when a valid active order lock exists', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        makeOrder({
          accountId,
          status: 'processing'
        })
      ])
      .mockResolvedValueOnce([makeAccount()]);
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValueOnce(makeLock());

    const result = await service.prepareOrderConsumptionInTransaction(tx as never, {
      orderId,
      idempotencyKey: 'consume-request-1'
    });

    expect(result).toMatchObject({
      idempotentReplay: false,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: {
        id: orderId,
        accountId
      },
      account: {
        id: accountId
      },
      activeLock: {
        id: lockId
      },
      existingEntry: null
    });
  });

  it('blocks consumption when the order has no valid active ID lock', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([
        makeOrder({
          accountId
        })
      ])
      .mockResolvedValueOnce([makeAccount()]);

    await expect(
      service.prepareOrderConsumptionInTransaction(tx as never, {
        orderId,
        idempotencyKey: 'consume-request-1'
      })
    ).rejects.toThrow('订单没有有效的 ID 锁，不能扣减余额');
  });

  it('rejects malformed IDs, past expirations, and short idempotency keys before writes', async () => {
    await expect(
      service.reserveAccountForOrder({
        orderId: 'invalid',
        accountId,
        expiresAt
      })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.reserveAccountForOrder({
        orderId,
        accountId,
        expiresAt: new Date('2020-01-01T00:00:00.000Z')
      })
    ).rejects.toThrow('锁定到期时间必须是未来的有效时间');
    await expect(
      service.prepareOrderConsumptionInTransaction(tx as never, {
        orderId,
        idempotencyKey: 'short'
      })
    ).rejects.toThrow('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    expect(tx.idBusinessV2AccountLock.create).not.toHaveBeenCalled();
  });
});
