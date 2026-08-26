import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { IdBusinessV2Order } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { Amount4, V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const orderId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const platformId = '55555555-5555-4555-8555-555555555555';
const consumptionId = '77777777-7777-4777-8777-777777777777';
const sourceOrderId = '99999999-9999-4999-8999-999999999999';
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

function cloudflareDecimal(value: Prisma.Decimal.Value) {
  return new CloudflarePrisma.Decimal(String(value));
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
    receivedOriginalAmount: decimal('100'),
    receivedCurrency: 'CNY',
    receivedFxRateToCny: decimal('1'),
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedAt: openedAt,
    platformFeeAmount: decimal('3'),
    accountDisposition: 'retained',
    accountCostAmount: decimal('25'),
    appliedAccountCostAmount: decimal('0'),
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('60'),
    transferredBalanceCostAmount: decimal('0'),
    appliedBalanceCostAmount: decimal('60'),
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
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2OrderBalanceReturn: {
      findFirst: vi.fn()
    },
    idBusinessV2Activation: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2AccountLock: {
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2Customer: {
      findFirst: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2Account: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
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
  const financePostingService = {
    post: vi.fn()
  };
  const service = new IdBusinessV2OrderLifecycleService(
    fieldEncryption as never,
    new IdBusinessV2BalanceCalculatorService(),
    orderLockService as never,
    ordersService as never,
    financePostingService as never,
    new V2CommandTransactionManager(prisma as never),
    new IdBusinessV2OrdersRepository(prisma as never)
  );
  let storedOrder = makeOrder();
  let consumption: ReturnType<typeof makeConsumption> | null = makeConsumption();
  let reversal: ReturnType<typeof makeReversal> | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
    storedOrder = makeOrder();
    consumption = makeConsumption();
    reversal = null;
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_accounts')) {
        const isSold = storedOrder.accountDisposition === 'sold';
        return [
          {
            id: accountId,
            appleIdMasked: 'us***@example.com',
            currentBalance: decimal(isSold ? '0' : '10'),
            balanceCostAmount: decimal(isSold ? '0' : '30'),
            purchaseCost: decimal('25'),
            soldByOrderId: isSold ? orderId : null,
            soldAt: isSold ? updatedAt : null,
            ownershipTransferredAt: isSold ? updatedAt : null,
            lossReportedAt: null
          }
        ];
      }
      return [{ id: orderId }];
    });
    tx.idBusinessV2Order.findUnique.mockImplementation(async () => storedOrder);
    tx.idBusinessV2Order.findFirst.mockResolvedValue(null);
    tx.idBusinessV2Order.update.mockImplementation(async ({ data }) => {
      storedOrder = {
        ...storedOrder,
        ...data,
        updatedAt: new Date('2026-07-26T13:00:00.000Z')
      };
      return storedOrder;
    });
    tx.idBusinessV2BalanceLedger.findFirst.mockImplementation(async ({ where }) => {
      const type = where.entryType;
      if (type === 'order_consumption') return consumption;
      if (type === 'order_consumption_reversal') return reversal;
      return null;
    });
    tx.idBusinessV2OrderBalanceReturn.findFirst.mockResolvedValue(null);
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) => {
      reversal = makeReversal({
        ...data,
        createdAt: new Date('2026-07-26T13:00:00.000Z')
      });
      return reversal;
    });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue(null);
    tx.idBusinessV2Activation.update.mockResolvedValue({ id: 'activation-1' });
    tx.idBusinessV2Activation.count.mockResolvedValue(0);
    tx.idBusinessV2Order.count.mockResolvedValue(0);
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
    tx.idBusinessV2AccountLock.count.mockResolvedValue(0);
    tx.idBusinessV2Account.findFirst.mockResolvedValue(null);
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
    tx.idBusinessV2Account.updateMany.mockResolvedValue({ count: 1 });
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
      receivedAmount: cloudflareDecimal('100'),
      platformFeeAmount: cloudflareDecimal('3'),
      accountCostAmount: cloudflareDecimal('0'),
      balanceAmount: cloudflareDecimal('20'),
      balanceCostAmount: cloudflareDecimal('0'),
      profitAmount: null
    });
    consumption = null;
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'settlement_platform') {
        return {
          fixedFee: cloudflareDecimal('1'),
          percentageFee: cloudflareDecimal('2')
        };
      }
      return { id: where.id };
    });
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
          receivedAmount: '200',
          platformFeeAmount: '5',
          balanceAmount: '25',
          profitAmount: null
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.id).toBe(orderId);
  });

  it('allows a pending order to switch to sold and forces a global sale lock', async () => {
    storedOrder = makeOrder({
      status: 'pending',
      accountDisposition: 'retained',
      accountCostAmount: decimal('0'),
      balanceCostAmount: decimal('0'),
      profitAmount: null,
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    consumption = null;
    tx.$queryRaw.mockResolvedValueOnce([{ id: orderId }]).mockResolvedValueOnce([
      {
        id: accountId,
        purchaseCost: decimal('25'),
        soldByOrderId: null
      }
    ]);

    await service.update(
      orderId,
      {
        accountDisposition: 'sold',
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: expect.objectContaining({
        soldByOrderId: orderId,
        soldAt: expect.any(Date)
      })
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountDisposition: 'sold',
          accountCostAmount: '25'
        })
      })
    );
    expect(orderLockService.reserveAccountForOrderInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        lockScope: 'global'
      }),
      operator
    );
  });

  it('recalculates processing order profit while protecting consumed core fields', async () => {
    storedOrder = makeOrder({
      receivedAmount: cloudflareDecimal('100'),
      platformFeeAmount: cloudflareDecimal('3'),
      accountCostAmount: cloudflareDecimal('25'),
      balanceAmount: cloudflareDecimal('20'),
      balanceCostAmount: cloudflareDecimal('60'),
      refundCostAmount: cloudflareDecimal('0'),
      profitAmount: cloudflareDecimal('37')
    });
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'settlement_platform') {
        return {
          fixedFee: cloudflareDecimal('1'),
          percentageFee: cloudflareDecimal('2')
        };
      }
      return { id: where.id };
    });

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
          receivedAmount: '120',
          platformFeeAmount: '3.4',
          profitAmount: '56.6',
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

  it('locks price and settlement-platform evidence after completion', async () => {
    storedOrder = makeOrder({
      status: 'completed'
    });

    await expect(
      service.update(
        orderId,
        {
          receivedAmount: '120',
          settlementPlatformOptionId: platformId,
          expectedUpdatedAt: updatedAt.toISOString()
        },
        operator
      )
    ).rejects.toThrow('已完成或已退款订单的价格和结算平台不可直接修改');

    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('reprices a non-CNY processing order with its locked exchange rate', async () => {
    storedOrder = makeOrder({
      receivedAmount: decimal('80'),
      receivedOriginalAmount: decimal('50'),
      receivedCurrency: 'MYR',
      receivedFxRateToCny: decimal('1.6'),
      platformFeeAmount: decimal('2.6'),
      profitAmount: decimal('17.4')
    });

    await service.update(
      orderId,
      {
        receivedOriginalAmount: '60',
        expectedUpdatedAt: updatedAt.toISOString()
      },
      operator
    );

    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receivedOriginalAmount: '60',
          receivedAmount: '96',
          platformFeeAmount: '2.92',
          profitAmount: '33.08'
        })
      })
    );
  });

  it('requires a settlement platform before repricing a legacy order', async () => {
    storedOrder = makeOrder({
      status: 'pending',
      settlementPlatformOptionId: null,
      platformOrderNo: null,
      balanceCostAmount: decimal('0'),
      profitAmount: null
    });
    consumption = null;

    await expect(
      service.update(
        orderId,
        {
          receivedAmount: '120',
          expectedUpdatedAt: updatedAt.toISOString()
        },
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
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

  it('recovers a sold ID when an unfinished order is cancelled', async () => {
    storedOrder = makeOrder({
      status: 'pending',
      accountDisposition: 'sold',
      accountCostAmount: decimal('25'),
      balanceCostAmount: decimal('0'),
      profitAmount: null
    });
    consumption = null;

    await service.cancel(
      orderId,
      {
        reason: '客户取消，ID 已收回',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(tx.idBusinessV2Account.updateMany).toHaveBeenCalledWith({
      where: {
        id: accountId,
        soldByOrderId: orderId,
        lossReportedAt: null
      },
      data: {
        soldByOrderId: null,
        soldAt: null,
        ownershipTransferredAt: null,
        updatedByUserId: operator.id
      }
    });
    expect(storedOrder.accountDisposition).toBe('recovered');
    expect(storedOrder.accountCostAmount.toString()).toBe('25');
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
        balanceAmount: '20',
        costAmount: '60',
        balanceBefore: '10',
        balanceAfter: '30',
        costBefore: '30',
        costAfter: '90',
        reversalOfEntryId: consumptionId,
        idempotencyKey: `order_reversal:${orderId}:lifecycle-key-1`
      })
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: '30',
        balanceCostAmount: '90',
        updatedByUserId: operator.id
      }
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'cancelled',
          balanceCostAmount: '0',
          profitAmount: '97'
        })
      })
    );
    expect(result.balanceRestored).toBe(true);
    expect(result.reversalLedger?.reversalOfEntryId).toBe(consumptionId);
  });

  it('restores company inventory when a consumed after-sales order is cancelled after sale correction', async () => {
    storedOrder = makeOrder({
      accountSource: 'customer_owned',
      sourceSoldOrderId: sourceOrderId,
      appliedBalanceCostAmount: decimal('0')
    });
    let sourceOrder = makeOrder({
      id: sourceOrderId,
      status: 'completed',
      accountDisposition: 'recovered',
      accountSource: 'inventory',
      sourceSoldOrderId: null,
      appliedAccountCostAmount: decimal('0'),
      appliedBalanceCostAmount: decimal('120'),
      profitAmount: decimal('-23')
    });
    tx.idBusinessV2Order.findUnique.mockImplementation(async ({ where }) =>
      where.id === sourceOrderId ? sourceOrder : storedOrder
    );
    tx.idBusinessV2Order.findFirst.mockResolvedValue({ id: sourceOrderId });
    tx.idBusinessV2Order.update.mockImplementation(async ({ where, data }) => {
      if (where.id === sourceOrderId) {
        sourceOrder = { ...sourceOrder, ...data };
        return sourceOrder;
      }
      storedOrder = { ...storedOrder, ...data };
      return storedOrder;
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_accounts')) {
        return [
          {
            id: accountId,
            appleIdMasked: 'us***@example.com',
            currentBalance: decimal('10'),
            balanceCostAmount: decimal('30'),
            purchaseCost: decimal('25'),
            soldByOrderId: null,
            soldAt: null,
            ownershipTransferredAt: null,
            lossReportedAt: null
          }
        ];
      }
      return [{ id: orderId }];
    });

    await service.cancel(
      orderId,
      {
        reason: '原出售已纠正，取消未开通售后单',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(sourceOrder.appliedBalanceCostAmount.toString()).toBe('60');
    expect(storedOrder.appliedBalanceCostAmount.toString()).toBe('0');
    expect(financePostingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'order_cancel',
        lines: [
          expect.objectContaining({
            accountCode: 'gift_card_inventory',
            direction: 'debit',
            amountCny: Amount4.from('60')
          }),
          expect.objectContaining({
            accountCode: 'customer_owned_balance_cost',
            direction: 'credit',
            amountCny: Amount4.from('60')
          })
        ]
      })
    );
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

  it('rejects full refunds before the order is completed', async () => {
    storedOrder = makeOrder({ status: 'processing' });

    await expect(
      service.refund(
        orderId,
        {
          refundCostAmount: '0',
          reason: '尚未完成时误点退款',
          idempotencyKey: 'lifecycle-key-1'
        },
        operator
      )
    ).rejects.toThrow('只有已完成订单可以退款');

    expect(financePostingService.post).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
  });

  it('refunds a completed order, cancels its activation and keeps the current ID balance by default', async () => {
    storedOrder = makeOrder({
      status: 'completed'
    });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({
      id: 'activation-1',
      status: 'active',
      statusChangedAt: openedAt,
      remark: '原开通记录'
    });

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
          refundCostAmount: '100',
          balanceCostAmount: '60',
          profitAmount: '-163',
          status: 'refunded'
        })
      })
    );
    expect(tx.idBusinessV2Activation.update).toHaveBeenCalledWith({
      where: { orderId },
      data: expect.objectContaining({
        status: 'cancelled',
        statusChangedAt: expect.any(Date),
        remark: expect.stringContaining('订单全额退款并取消开通')
      })
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.activation.cancel_by_order_refund',
          objectId: 'activation-1'
        })
      })
    );
    expect(result).toMatchObject({
      balanceRestored: false,
      lockReleased: true,
      idempotentReplay: false
    });
  });

  it('automatically recovers a sold ID and reverses its applied ID cost on full refund', async () => {
    storedOrder = makeOrder({
      status: 'completed',
      accountDisposition: 'sold',
      accountCostAmount: decimal('25'),
      appliedAccountCostAmount: decimal('25'),
      profitAmount: decimal('12')
    });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({
      id: 'activation-1',
      status: 'active',
      statusChangedAt: openedAt,
      remark: null
    });
    tx.idBusinessV2Order.count.mockResolvedValue(2);
    tx.idBusinessV2Activation.count.mockResolvedValue(1);
    tx.idBusinessV2AccountLock.count.mockResolvedValue(1);

    await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '客户整单退款',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(tx.idBusinessV2Account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: accountId,
          soldByOrderId: orderId,
          lossReportedAt: null
        }
      })
    );
    expect(storedOrder.accountDisposition).toBe('recovered');
    expect(storedOrder.accountCostAmount.toString()).toBe('25');
    expect(storedOrder.profitAmount?.toString()).toBe('-163');
    expect(financePostingService.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        journalType: 'order_refund',
        metadata: expect.objectContaining({ accountRecovered: true }),
        lines: expect.arrayContaining([
          expect.objectContaining({ accountCode: 'id_inventory', direction: 'debit' }),
          expect.objectContaining({ accountCode: 'id_cost', direction: 'credit' })
        ])
      })
    );
    expect(tx.idBusinessV2Order.count).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Activation.count).not.toHaveBeenCalled();
    expect(tx.idBusinessV2AccountLock.count).not.toHaveBeenCalled();
  });

  it('restores balance from the exact consumption ledger when explicitly confirmed', async () => {
    storedOrder = makeOrder({ status: 'completed' });
    tx.idBusinessV2Activation.findUnique.mockResolvedValue({
      id: 'activation-1',
      status: 'active',
      statusChangedAt: openedAt,
      remark: null
    });

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
    expect(storedOrder.profitAmount?.toString()).toBe('-103');
    expect(tx.idBusinessV2Activation.update).toHaveBeenCalled();
  });

  it('refunds a custom amount to the ID balance with proportional CNY cost', async () => {
    storedOrder = makeOrder({ status: 'completed' });

    const result = await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '部分余额实际退回',
        balanceRefundMode: 'custom',
        customRefundBalanceAmount: '8',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(result.balanceRestored).toBe(true);
    expect(result.reversalLedger).toMatchObject({
      balanceAmount: '8',
      costAmount: '24'
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: '18',
        balanceCostAmount: '54',
        updatedByUserId: operator.id
      }
    });
    expect(storedOrder.balanceCostAmount.toString()).toBe('36');
    expect(storedOrder.profitAmount?.toString()).toBe('-139');
    expect(financePostingService.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          balanceRefundMode: 'custom',
          refundedBalanceAmount: '8',
          restoredBalanceCostAmount: '24'
        }),
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'gift_card_inventory',
            amountCny: Amount4.from('24')
          })
        ])
      })
    );
  });

  it('refunds only the balance and cost still remaining after an active upgrade return', async () => {
    storedOrder = makeOrder({
      status: 'completed',
      balanceCostAmount: decimal('36'),
      appliedBalanceCostAmount: decimal('36'),
      profitAmount: decimal('61')
    });
    tx.idBusinessV2OrderBalanceReturn.findFirst.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orderId,
      accountId,
      activeKey: orderId,
      status: 'active',
      currencyCode: 'USD',
      returnedBalanceAmount: decimal('8'),
      restoredBalanceCostAmount: decimal('24'),
      restoredAppliedBalanceCostAmount: decimal('24'),
      originalProfitAmount: decimal('37'),
      adjustedProfitAmount: decimal('61'),
      balanceLedgerEntryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      financeJournalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      idempotencyKey: 'upgrade-return-test-key',
      reason: '升级 Pro 后平台实际退回',
      createdByUserId: operator.id,
      createdAt: updatedAt,
      reversalBalanceLedgerEntryId: null,
      reversalFinanceJournalId: null,
      reversalIdempotencyKey: null,
      reversalReason: null,
      reversedByUserId: null,
      reversedAt: null
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_accounts')) {
        return [
          {
            id: accountId,
            appleIdMasked: 'us***@example.com',
            currentBalance: decimal('18'),
            balanceCostAmount: decimal('54'),
            purchaseCost: decimal('25'),
            soldByOrderId: null,
            ownershipTransferredAt: null,
            lossReportedAt: null
          }
        ];
      }
      return [{ id: orderId }];
    });

    const result = await service.refund(
      orderId,
      {
        refundCostAmount: '100',
        reason: '客户整单退款',
        balanceRefundMode: 'full',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(result.reversalLedger).toMatchObject({
      balanceAmount: '12',
      costAmount: '36'
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: '30',
        balanceCostAmount: '90',
        updatedByUserId: operator.id
      }
    });
    expect(financePostingService.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          refundedBalanceAmount: '12',
          restoredBalanceCostAmount: '36',
          priorUpgradeReturnedBalanceAmount: '8',
          priorUpgradeRestoredBalanceCostAmount: '24'
        })
      })
    );
  });

  it('returns restored after-sales balance cost to company inventory after the sale was corrected', async () => {
    storedOrder = makeOrder({
      status: 'completed',
      accountSource: 'customer_owned',
      sourceSoldOrderId: sourceOrderId,
      balanceCostAmount: decimal('60'),
      appliedBalanceCostAmount: decimal('0'),
      profitAmount: decimal('97')
    });
    let sourceOrder = makeOrder({
      id: sourceOrderId,
      orderNo: 'V220260726SOLD001',
      status: 'completed',
      accountDisposition: 'recovered',
      accountSource: 'inventory',
      sourceSoldOrderId: null,
      balanceCostAmount: decimal('60'),
      transferredBalanceCostAmount: decimal('60'),
      appliedBalanceCostAmount: decimal('80'),
      profitAmount: decimal('17')
    });
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: sourceOrderId }])
      .mockResolvedValueOnce([
        {
          id: accountId,
          appleIdMasked: 'us***@example.com',
          currentBalance: decimal('0'),
          balanceCostAmount: decimal('0'),
          soldByOrderId: null,
          ownershipTransferredAt: null,
          lossReportedAt: null
        }
      ]);
    tx.idBusinessV2Order.findUnique.mockImplementation(async ({ where }) =>
      where.id === sourceOrderId ? sourceOrder : storedOrder
    );
    tx.idBusinessV2Order.findFirst.mockResolvedValue({ id: sourceOrderId });
    tx.idBusinessV2Order.update.mockImplementation(async ({ where, data }) => {
      if (where.id === sourceOrderId) {
        sourceOrder = makeOrder({ ...sourceOrder, ...data, id: sourceOrderId });
        return sourceOrder;
      }
      storedOrder = makeOrder({ ...storedOrder, ...data });
      return storedOrder;
    });

    await service.refund(
      orderId,
      {
        refundCostAmount: '0',
        reason: '后续业务退款并恢复余额',
        balanceRefundMode: 'full',
        idempotencyKey: 'lifecycle-key-1'
      },
      operator
    );

    expect(sourceOrder.appliedBalanceCostAmount.toString()).toBe('60');
    expect(sourceOrder.profitAmount?.toString()).toBe('37');
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.order.restore_recovered_balance_cost',
        objectId: sourceOrderId
      })
    });
    expect(financePostingService.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          restoredAppliedBalanceCostAmount: '0',
          restoredCustomerOwnedBalanceCostAmount: '60',
          restoredSourceOrderId: sourceOrderId,
          restoredSourceOrderCostAmount: '20'
        }),
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'gift_card_inventory',
            direction: 'debit',
            amountCny: Amount4.from('60')
          }),
          expect.objectContaining({
            accountCode: 'customer_owned_balance_cost',
            direction: 'credit',
            amountCny: Amount4.from('60')
          })
        ])
      })
    );
  });

  it('rejects restoring after-sales balance after the ID has been resold', async () => {
    const resaleOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    storedOrder = makeOrder({
      status: 'completed',
      accountSource: 'customer_owned',
      sourceSoldOrderId: sourceOrderId,
      appliedBalanceCostAmount: decimal('0')
    });
    const sourceOrder = makeOrder({
      id: sourceOrderId,
      accountDisposition: 'recovered',
      status: 'completed'
    });
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: orderId }])
      .mockResolvedValueOnce([{ id: sourceOrderId }])
      .mockResolvedValueOnce([
        {
          id: accountId,
          appleIdMasked: 'us***@example.com',
          currentBalance: decimal('10'),
          balanceCostAmount: decimal('30'),
          soldByOrderId: resaleOrderId,
          ownershipTransferredAt: updatedAt,
          lossReportedAt: null
        }
      ]);
    tx.idBusinessV2Order.findUnique.mockImplementation(async ({ where }) =>
      where.id === sourceOrderId ? sourceOrder : storedOrder
    );

    await expect(
      service.refund(
        orderId,
        {
          refundCostAmount: '0',
          reason: '旧客户业务退款',
          balanceRefundMode: 'full',
          idempotencyKey: 'lifecycle-key-1'
        },
        operator
      )
    ).rejects.toThrow('该 ID 已转售或归属已变化，订单只能退款，不能恢复 ID 余额');

    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
  });

  it('rejects a custom ID balance refund above the original consumption', async () => {
    storedOrder = makeOrder({ status: 'completed' });

    await expect(
      service.refund(
        orderId,
        {
          refundCostAmount: '0',
          reason: '输入错误',
          balanceRefundMode: 'custom',
          customRefundBalanceAmount: '20.0001',
          idempotencyKey: 'lifecycle-key-1'
        },
        operator
      )
    ).rejects.toThrow('退回 ID 余额不能超过本单尚未退回的余额');

    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
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
