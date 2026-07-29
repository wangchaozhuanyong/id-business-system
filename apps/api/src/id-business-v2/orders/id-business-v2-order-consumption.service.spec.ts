import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2OrderConsumptionService } from './id-business-v2-order-consumption.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const lockId = '33333333-3333-4333-8333-333333333333';
const ledgerId = '44444444-4444-4444-8444-444444444444';
const createdAt = new Date('2026-07-26T12:00:00.000Z');
const operator = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.create']
};

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V2-20260726-0001',
    serviceOptionId: '66666666-6666-4666-8666-666666666666',
    accountId,
    receivedAmount: decimal('100'),
    platformFeeAmount: decimal('3'),
    accountCostAmount: decimal('0'),
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('0'),
    refundCostAmount: null,
    profitAmount: null,
    status: 'pending',
    ...overrides
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    appleIdMasked: 'us***@example.com',
    currentBalance: decimal('30'),
    balanceCostAmount: decimal('90'),
    purchaseCost: decimal('25'),
    countryOptionId: '77777777-7777-4777-8777-777777777777',
    statusCode: 'normal',
    ...overrides
  };
}

function makeMovement(overrides: Record<string, unknown> = {}) {
  return {
    balanceAmount: decimal('20'),
    costAmount: decimal('60'),
    balanceBefore: decimal('30'),
    balanceAfter: decimal('10'),
    costBefore: decimal('90'),
    costAfter: decimal('30'),
    averageCostBefore: decimal('3'),
    averageCostAfter: decimal('3'),
    ...overrides
  };
}

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: ledgerId,
    accountId,
    giftCardId: null,
    orderId,
    entryType: 'order_consumption',
    direction: 'debit',
    ...makeMovement(),
    reversalOfEntryId: null,
    idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
    remark: '订单余额扣减：V2-20260726-0001',
    createdByUserId: operator.id,
    createdAt,
    ...overrides
  };
}

function makeOrderResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNo: 'V2-20260726-0001',
    accountCostAmount: '25',
    balanceCostAmount: '60',
    profitAmount: '37',
    status: 'processing',
    ...overrides
  };
}

describe('IdBusinessV2OrderConsumptionService', () => {
  const tx = {
    idBusinessV2BalanceLedger: {
      create: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    idBusinessV2Order: {
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const orderLockService = {
    prepareOrderConsumptionInTransaction: vi.fn()
  };
  const balanceCalculator = {
    calculateConsumption: vi.fn()
  };
  const ordersService = {
    get: vi.fn()
  };
  const service = new IdBusinessV2OrderConsumptionService(
    prisma as never,
    orderLockService as never,
    balanceCalculator as never,
    ordersService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
    );
    orderLockService.prepareOrderConsumptionInTransaction.mockResolvedValue({
      idempotentReplay: false,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: makeOrder(),
      account: makeAccount(),
      activeLock: {
        id: lockId
      },
      existingEntry: null
    });
    balanceCalculator.calculateConsumption.mockReturnValue(makeMovement());
    tx.idBusinessV2BalanceLedger.create.mockResolvedValue(makeLedger());
    tx.idBusinessV2Account.update.mockResolvedValue({
      id: accountId
    });
    tx.idBusinessV2Order.update.mockResolvedValue({
      id: orderId
    });
    tx.auditLog.create.mockResolvedValue({
      id: 'audit-1'
    });
    ordersService.get.mockResolvedValue(makeOrderResponse());
  });

  it('atomically deducts balance, writes an immutable ledger, and calculates server-side profit', async () => {
    const result = await service.consume(
      orderId,
      {
        idempotencyKey: 'consume-request-1'
      },
      operator
    );

    expect(orderLockService.prepareOrderConsumptionInTransaction).toHaveBeenCalledWith(
      tx,
      {
        orderId,
        idempotencyKey: 'consume-request-1'
      },
      operator
    );
    expect(balanceCalculator.calculateConsumption).toHaveBeenCalledWith(
      {
        currentBalance: decimal('30'),
        balanceCostAmount: decimal('90')
      },
      decimal('20')
    );
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId,
        orderId,
        entryType: 'order_consumption',
        direction: 'debit',
        balanceAmount: decimal('20'),
        costAmount: decimal('60'),
        balanceBefore: decimal('30'),
        balanceAfter: decimal('10'),
        costBefore: decimal('90'),
        costAfter: decimal('30'),
        idempotencyKey: `order_consumption:${orderId}:consume-request-1`
      })
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: {
        id: accountId
      },
      data: {
        currentBalance: decimal('10'),
        balanceCostAmount: decimal('30'),
        updatedByUserId: operator.id
      }
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: {
        id: orderId
      },
      data: {
        accountCostAmount: decimal('25'),
        balanceCostAmount: decimal('60'),
        profitAmount: decimal('37'),
        status: 'processing',
        statusChangedAt: expect.any(Date),
        updatedByUserId: operator.id
      }
    });
    expect(result).toEqual({
      order: makeOrderResponse(),
      ledgerEntry: {
        id: ledgerId,
        accountId,
        balanceAmount: '20',
        costAmount: '60',
        balanceBefore: '30',
        balanceAfter: '10',
        costBefore: '90',
        costAfter: '30',
        averageCostBefore: '3',
        averageCostAfter: '3',
        createdAt
      },
      idempotentReplay: false,
      nextStep: 'waiting_activation_record'
    });
  });

  it('stores ID purchase cost as an asset snapshot without charging it again in every order profit', async () => {
    await service.consume(orderId, {
      idempotencyKey: 'consume-request-1'
    });

    const orderUpdate = tx.idBusinessV2Order.update.mock.calls[0]?.[0];
    expect(orderUpdate.data.accountCostAmount.toString()).toBe('25');
    expect(orderUpdate.data.profitAmount.toString()).toBe('37');
    expect(orderUpdate.data.profitAmount.toString()).not.toBe('12');
  });

  it('allows a real negative profit and records it instead of claiming success with zero', async () => {
    orderLockService.prepareOrderConsumptionInTransaction.mockResolvedValueOnce({
      idempotentReplay: false,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: makeOrder({
        receivedAmount: decimal('50'),
        platformFeeAmount: decimal('5')
      }),
      account: makeAccount(),
      activeLock: {
        id: lockId
      },
      existingEntry: null
    });
    ordersService.get.mockResolvedValueOnce(
      makeOrderResponse({
        profitAmount: '-15'
      })
    );

    const result = await service.consume(orderId, {
      idempotencyKey: 'consume-request-1'
    });

    expect(tx.idBusinessV2Order.update.mock.calls[0]?.[0].data.profitAmount.toString()).toBe('-15');
    expect(result.order.profitAmount).toBe('-15');
  });

  it('returns the original evidence for an exact replay without writing balances again', async () => {
    orderLockService.prepareOrderConsumptionInTransaction.mockResolvedValueOnce({
      idempotentReplay: true,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: makeOrder({
        accountCostAmount: decimal('25'),
        balanceCostAmount: decimal('60'),
        profitAmount: decimal('37'),
        status: 'processing'
      }),
      account: null,
      activeLock: null,
      existingEntry: makeLedger()
    });

    const result = await service.consume(orderId, {
      idempotencyKey: 'consume-request-1'
    });

    expect(result.idempotentReplay).toBe(true);
    expect(result.ledgerEntry.id).toBe(ledgerId);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a replay whose ledger, cost, or order status evidence is inconsistent', async () => {
    orderLockService.prepareOrderConsumptionInTransaction.mockResolvedValueOnce({
      idempotentReplay: true,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: makeOrder({
        balanceCostAmount: decimal('0'),
        profitAmount: null,
        status: 'pending'
      }),
      account: null,
      activeLock: null,
      existingEntry: makeLedger()
    });

    await expect(
      service.consume(orderId, {
        idempotencyKey: 'consume-request-1'
      })
    ).rejects.toThrow('订单已有扣款流水，但成本或状态证据不完整，请人工检查');
    expect(ordersService.get).not.toHaveBeenCalled();
  });

  it('propagates balance validation errors before any ledger or order write', async () => {
    balanceCalculator.calculateConsumption.mockImplementationOnce(() => {
      throw new BadRequestException('扣减余额不能超过当前余额');
    });

    await expect(
      service.consume(orderId, {
        idempotencyKey: 'consume-request-1'
      })
    ).rejects.toThrow('扣减余额不能超过当前余额');
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
  });

  it('rejects a profit outside Decimal(18,4) before writing any financial state', async () => {
    orderLockService.prepareOrderConsumptionInTransaction.mockResolvedValueOnce({
      idempotentReplay: false,
      idempotencyKey: `order_consumption:${orderId}:consume-request-1`,
      order: makeOrder({
        receivedAmount: decimal('0'),
        platformFeeAmount: decimal('99999999999999.9999'),
        refundCostAmount: decimal('99999999999999.9999')
      }),
      account: makeAccount(),
      activeLock: {
        id: lockId
      },
      existingEntry: null
    });
    balanceCalculator.calculateConsumption.mockReturnValueOnce(
      makeMovement({
        costAmount: decimal('99999999999999.9999')
      })
    );

    await expect(
      service.consume(orderId, {
        idempotencyKey: 'consume-request-1'
      })
    ).rejects.toThrow('订单利润数值超出数据库范围');
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('maps the database duplicate-write race to an explicit conflict', async () => {
    tx.idBusinessV2BalanceLedger.create.mockRejectedValueOnce({
      code: 'P2002'
    });

    await expect(
      service.consume(orderId, {
        idempotencyKey: 'consume-request-1'
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ordersService.get).not.toHaveBeenCalled();
  });

  it('keeps idempotency keys and account secrets out of responses and audit evidence', async () => {
    const result = await service.consume(
      orderId,
      {
        idempotencyKey: 'consume-request-1'
      },
      operator
    );
    const auditPayload = tx.auditLog.create.mock.calls[0]?.[0];

    expect(JSON.stringify(result)).not.toContain('consume-request-1');
    expect(JSON.stringify(auditPayload)).not.toContain('consume-request-1');
    expect(JSON.stringify(auditPayload)).not.toContain('secret-lock-token');
    expect(auditPayload.data.action).toBe('id_business_v2.order.consume_balance');
  });
});
