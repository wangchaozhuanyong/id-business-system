import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { IdBusinessV2Order } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const platformId = '55555555-5555-4555-8555-555555555555';
const consumptionId = '77777777-7777-4777-8777-777777777777';
const operator = {
  id: '66666666-6666-4666-8666-666666666666',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.update', 'apple.order.delete']
};
const updatedAt = new Date('2026-07-26T12:00:00.000Z');
const openedAt = new Date('2026-07-26T11:00:00.000Z');
const dueAt = new Date('2026-08-26T11:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeOrder(overrides: Record<string, unknown> = {}): IdBusinessV2Order {
  return {
    id: orderId,
    orderNo: 'V220260726TESTORDER001',
    customerId,
    serviceOptionId: serviceId,
    accountId,
    settlementPlatformOptionId: platformId,
    platformOrderNo: 'PLATFORM-1',
    websiteAccountEncrypted: 'v1:encrypted',
    websiteAccountHash: 'website-hash',
    websiteAccountMasked: 'te***@example.com',
    receivedAmount: decimal('100'),
    platformFeeAmount: decimal('3'),
    accountCostAmount: decimal('25'),
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('60'),
    refundCostAmount: null,
    profitAmount: decimal('37'),
    status: 'processing',
    statusChangedAt: updatedAt,
    openedAt,
    dueAt,
    idempotencyKey: 'order_entry:secret-entry-key',
    remark: '原备注',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: openedAt,
    updatedAt,
    deletedAt: null,
    ...overrides
  } as IdBusinessV2Order;
}

function makeConsumption(overrides: Record<string, unknown> = {}) {
  return {
    id: consumptionId,
    accountId,
    giftCardId: null,
    orderId,
    entryType: 'order_consumption',
    direction: 'debit',
    balanceAmount: decimal('20'),
    costAmount: decimal('60'),
    balanceBefore: decimal('30'),
    balanceAfter: decimal('10'),
    costBefore: decimal('90'),
    costAfter: decimal('30'),
    averageCostBefore: decimal('3'),
    averageCostAfter: decimal('3'),
    reversalOfEntryId: null,
    idempotencyKey: `order_consumption:${orderId}:consume-key-1`,
    remark: '订单余额扣减',
    createdByUserId: operator.id,
    createdAt: updatedAt,
    ...overrides
  };
}

function makeReversal(overrides: Record<string, unknown> = {}) {
  return {
    ...makeConsumption(),
    id: '88888888-8888-4888-8888-888888888888',
    entryType: 'order_consumption_reversal',
    direction: 'credit',
    balanceBefore: decimal('10'),
    balanceAfter: decimal('30'),
    costBefore: decimal('30'),
    costAfter: decimal('90'),
    reversalOfEntryId: consumptionId,
    idempotencyKey: `order_reversal:${orderId}:lifecycle-key-1`,
    ...overrides
  };
}

describe('IdBusinessV2OrderLifecycleService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Order: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2Activation: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2AccountLock: {
      findFirst: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2Customer: {
      findFirst: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const fieldEncryption = {
    encrypt: vi.fn((value) => (value ? `encrypted:${value}` : null)),
    hash: vi.fn((value) => (value ? `hash:${value}` : null))
  };
  const orderLockService = {
    releaseOrderLockInTransaction: vi.fn(),
    reserveAccountForOrderInTransaction: vi.fn()
  };
  const ordersService = {
    get: vi.fn()
  };
  const service = new IdBusinessV2OrderLifecycleService(
    prisma as never,
    fieldEncryption as never,
    new IdBusinessV2BalanceCalculatorService(),
    orderLockService as never,
    ordersService as never
  );
  let storedOrder = makeOrder();
  let consumption: ReturnType<typeof makeConsumption> | null = makeConsumption();
  let reversal: ReturnType<typeof makeReversal> | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    storedOrder = makeOrder();
    consumption = makeConsumption();
    reversal = null;
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.$queryRaw.mockResolvedValue([{ id: orderId }]);
    tx.idBusinessV2Order.findUnique.mockImplementation(async () => storedOrder);
    tx.idBusinessV2Order.update.mockImplementation(async ({ data }) => {
      storedOrder = {
        ...storedOrder,
        ...data,
        updatedAt: new Date('2026-07-26T13:00:00.000Z')
      };
      return storedOrder;
    });
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      const type = where.orderId_entryType?.entryType;
      if (type === 'order_consumption') return consumption;
      if (type === 'order_consumption_reversal') return reversal;
      return null;
    });
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) => {
      reversal = makeReversal({
        ...data,
        createdAt: new Date('2026-07-26T13:00:00.000Z')
      });
      return reversal;
    });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue(null);
    tx.idBusinessV2Activation.update.mockResolvedValue({ id: 'activation-1' });
    tx.idBusinessV2AccountLock.findFirst.mockResolvedValue({
      id: 'lock-1',
      accountId,
      serviceOptionId: serviceId,
      lockScope: 'by_service',
      status: 'active',
      lockedAt: openedAt,
      expiresAt: dueAt,
      endedAt: null,
      endReason: null,
      reason: '订单录入'
    });
    tx.idBusinessV2AccountLock.update.mockResolvedValue({ id: 'lock-1' });
    tx.idBusinessV2Customer.findFirst.mockResolvedValue({ id: customerId });
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'settlement_platform') {
        return {
          fixedFee: decimal('1'),
          percentageFee: decimal('2')
        };
      }
      return { id: where.id };
    });
    tx.idBusinessV2Account.update.mockResolvedValue({ id: accountId });
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    orderLockService.releaseOrderLockInTransaction.mockResolvedValue({
      released: true,
      alreadyEnded: false,
      lock: { id: 'lock-1', status: 'released' }
    });
    orderLockService.reserveAccountForOrderInTransaction.mockResolvedValue({
      lock: { id: 'lock-2', status: 'active' }
    });
    ordersService.get.mockImplementation(async () => ({
      id: orderId,
      status: storedOrder.status,
      balanceCostAmount: storedOrder.balanceCostAmount.toString(),
      refundCostAmount: storedOrder.refundCostAmount?.toString() ?? null,
      profitAmount: storedOrder.profitAmount?.toString() ?? null
    }));
  });

  it('updates a pending order, recalculates fees, and atomically recreates its lock', async () => {
    storedOrder = makeOrder({
      status: 'pending',
      accountCostAmount: decimal('0'),
      balanceCostAmount: decimal('0'),
      profitAmount: null
    });
    consumption = null;
    const nextDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await service.update(
      orderId,
      {
        customerId,
        serviceOptionId: '99999999-9999-4999-8999-999999999999',
        accountId,
        receivedAmount: '200',
        balanceAmount: '25',
        dueAt: nextDueAt.toISOString(),
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    expect(orderLockService.releaseOrderLockInTransaction).toHaveBeenCalledOnce();
    expect(orderLockService.reserveAccountForOrderInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orderId,
        accountId,
        expiresAt: nextDueAt,
        lockScope: 'by_service'
      }),
      operator
    );
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receivedAmount: decimal('200'),
          platformFeeAmount: decimal('5'),
          balanceAmount: decimal('25'),
          profitAmount: null
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.id).toBe(orderId);
  });

  it('recalculates processing order profit while protecting consumed core fields', async () => {
    await service.update(
      orderId,
      {
        receivedAmount: '120',
        remark: '金额校正',
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receivedAmount: decimal('120'),
          platformFeeAmount: decimal('3.4'),
          profitAmount: decimal('56.6'),
          remark: '金额校正'
        })
      })
    );
    expect(orderLockService.releaseOrderLockInTransaction).not.toHaveBeenCalled();
    expect(orderLockService.reserveAccountForOrderInTransaction).not.toHaveBeenCalled();

    await expect(
      service.update(
        orderId,
        {
          balanceAmount: '30',
          expectedUpdatedAt: storedOrder.updatedAt.toISOString()
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates a consumed order lock expiry without trying to consume or reserve balance again', async () => {
    const nextDueAt = new Date('2026-09-26T11:00:00.000Z');

    await service.update(
      orderId,
      {
        dueAt: nextDueAt.toISOString(),
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    expect(tx.idBusinessV2AccountLock.update).toHaveBeenCalledWith({
      where: {
        id: 'lock-1'
      },
      data: {
        expiresAt: nextDueAt
      }
    });
    expect(orderLockService.releaseOrderLockInTransaction).not.toHaveBeenCalled();
    expect(orderLockService.reserveAccountForOrderInTransaction).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects a stale update before any write', async () => {
    await expect(
      service.update(
        orderId,
        {
          remark: '旧页面提交',
          expectedUpdatedAt: '2026-07-26T10:00:00.000Z'
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('cancels a pending order by releasing its lock without inventing a balance reversal', async () => {
    storedOrder = makeOrder({
      status: 'pending',
      balanceCostAmount: decimal('0'),
      profitAmount: null
    });
    consumption = null;

    const result = await service.cancel(
      orderId,
      {
        reason: '客户取消下单',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(orderLockService.releaseOrderLockInTransaction).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      balanceRestored: false,
      lockReleased: true,
      idempotentReplay: false,
      reversalLedger: null
    });
  });

  it('cancels a consumed order by restoring the exact original balance and cost', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ id: orderId }]).mockResolvedValueOnce([
      {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: decimal('10'),
        balanceCostAmount: decimal('30')
      }
    ]);

    const result = await service.cancel(
      orderId,
      {
        reason: '未开通，撤销订单',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryType: 'order_consumption_reversal',
        direction: 'credit',
        balanceAmount: decimal('20'),
        costAmount: decimal('60'),
        balanceBefore: decimal('10'),
        balanceAfter: decimal('30'),
        costBefore: decimal('30'),
        costAfter: decimal('90'),
        reversalOfEntryId: consumptionId,
        idempotencyKey: `order_reversal:${orderId}:lifecycle-key-1`
      })
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: decimal('30'),
        balanceCostAmount: decimal('90'),
        updatedByUserId: operator.id
      }
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'cancelled',
          balanceCostAmount: 0,
          profitAmount: decimal('97')
        })
      })
    );
    expect(result.balanceRestored).toBe(true);
    expect(result.reversalLedger?.reversalOfEntryId).toBe(consumptionId);
  });

  it('does not cancel an order that already has an activation', async () => {
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({ id: 'activation-1' });

    await expect(
      service.cancel(
        orderId,
        {
          reason: '尝试取消',
          idempotencyKey: 'lifecycle-key-1'
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('refunds a completed order without restoring Apple balance by default', async () => {
    storedOrder = makeOrder({
      status: 'completed'
    });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({ id: 'activation-1' });

    const result = await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '客户售后退款',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          refundCostAmount: decimal('100'),
          balanceCostAmount: decimal('60'),
          profitAmount: decimal('-63'),
          status: 'refunded'
        })
      })
    );
    expect(result).toMatchObject({
      balanceRestored: false,
      lockReleased: true,
      idempotentReplay: false
    });
  });

  it('restores balance for an explicit pre-activation refund and rejects it after activation', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ id: orderId }]).mockResolvedValueOnce([
      {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: decimal('10'),
        balanceCostAmount: decimal('30')
      }
    ]);

    const result = await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '未交付，退款并恢复余额',
        restoreBalance: true,
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );
    expect(result.balanceRestored).toBe(true);
    expect(storedOrder.balanceCostAmount.toString()).toBe('0');
    expect(storedOrder.profitAmount?.toString()).toBe('-3');

    storedOrder = makeOrder({ status: 'completed' });
    reversal = null;
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({ id: 'activation-1' });
    tx.idBusinessV2Order.update.mockClear();
    await expect(
      service.refund(
        orderId,
        {
          refundCostAmount: '100',
          reason: '已有开通记录',
          restoreBalance: true,
          idempotencyKey: 'another-key-1'
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
  });

  it('returns an exact refund replay without writing a second reversal', async () => {
    storedOrder = makeOrder({
      status: 'refunded',
      refundCostAmount: decimal('100'),
      balanceCostAmount: decimal('0'),
      profitAmount: decimal('-3')
    });
    reversal = makeReversal();

    const result = await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '重复请求',
        restoreBalance: true,
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(result.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
  });

  it('soft deletes only terminal orders and preserves financial records', async () => {
    storedOrder = makeOrder({
      status: 'cancelled',
      balanceCostAmount: decimal('0'),
      profitAmount: decimal('97')
    });

    const result = await service.remove(
      orderId,
      {
        reason: '重复录入，保留审计后隐藏'
      },
      operator
    );

    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          updatedByUserId: operator.id
        })
      })
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.order.delete',
          afterData: expect.objectContaining({
            dataPreserved: true
          })
        })
      })
    );
    expect(result).toEqual({
      deleted: true,
      idempotentReplay: false
    });

    storedOrder = makeOrder({ status: 'completed' });
    await expect(
      service.remove(
        orderId,
        {
          reason: '不允许直接删除'
        },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never writes website plaintext or lifecycle idempotency keys into audit data', async () => {
    await service.update(
      orderId,
      {
        websiteAccount: 'private-user@example.com',
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    const auditPayload = JSON.stringify(tx.auditLog.create.mock.calls);
    expect(auditPayload).toContain('pr***@example.com');
    expect(auditPayload).not.toContain('private-user@example.com');
    expect(auditPayload).not.toContain('secret-entry-key');
    expect(auditPayload).not.toContain('website-hash');
  });
});
