import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  IdBusinessV2Activation,
  IdBusinessV2BalanceLedger,
  IdBusinessV2Order
} from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as financeApi from '../finance/public-api';
import { Amount4 as ReceiptAmount4 } from '../runtime/public-api';
import { Amount4, V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const financeAccountId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const financeAccountLock = vi.spyOn(financeApi, 'lockFinanceAccount');

const orderId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const serviceId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const operator = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.update']
};
const openedAt = new Date('2026-07-26T12:00:00.000Z');
const dueAt = new Date('2026-08-26T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeOrder(overrides: Partial<IdBusinessV2Order> = {}): IdBusinessV2Order {
  return {
    id: orderId,
    orderNo: 'V220260726TEST001',
    customerId,
    serviceOptionId: serviceId,
    accountId,
    balanceCurrencyCode: 'USD',
    settlementPlatformOptionId: null,
    platformOrderNo: null,
    websiteAccountEncrypted: 'encrypted',
    websiteAccountHash: 'hash',
    websiteAccountMasked: 'cu***@example.com',
    websiteAccountSearchTokens: ['website-search-token'],
    receivedAmount: decimal('100'),
    receivedOriginalAmount: decimal('100'),
    receivedCurrency: 'CNY',
    receivedFxRateToCny: decimal('1'),
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: financeAccountId,
    receivedAt: openedAt,
    platformFeeAmount: decimal('3'),
    accountDisposition: 'sold',
    accountCostAmount: decimal('25'),
    appliedAccountCostAmount: decimal('25'),
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    balanceAmount: decimal('20'),
    balanceCostAmount: decimal('60'),
    transferredBalanceCostAmount: decimal('0'),
    appliedBalanceCostAmount: decimal('60'),
    refundCostAmount: null,
    profitAmount: decimal('37'),
    status: 'processing',
    statusChangedAt: openedAt,
    openedAt,
    dueAt,
    idempotencyKey: 'order-secret',
    remark: '真实开通',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: openedAt,
    updatedAt: openedAt,
    deletedAt: null,
    ...overrides
  };
}

function makeConsumption(
  overrides: Partial<IdBusinessV2BalanceLedger> = {}
): IdBusinessV2BalanceLedger {
  return {
    id: '66666666-6666-4666-8666-666666666666',
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
    idempotencyKey: 'order-consumption-secret',
    remark: '扣款',
    createdByUserId: operator.id,
    createdAt: openedAt,
    ...overrides
  };
}

function makeActivation(overrides: Partial<IdBusinessV2Activation> = {}): IdBusinessV2Activation {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    orderId,
    renewedFromActivationId: null,
    customerId,
    accountId,
    serviceOptionId: serviceId,
    openedAt,
    dueAt,
    status: 'active',
    statusChangedAt: openedAt,
    autoRenewalStatus: 'unknown',
    autoRenewalChangedAt: null,
    remark: '真实开通',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt: openedAt,
    updatedAt: openedAt,
    ...overrides
  };
}

describe('IdBusinessV2OrderCompletionService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Order: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findFirst: vi.fn()
    },
    idBusinessV2Activation: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2AccountLock: {
      updateMany: vi.fn()
    },
    idBusinessV2Account: {
      updateMany: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const ordersService = {
    get: vi.fn()
  };
  const financePostingService = {
    post: vi.fn(),
    reserveOrderIncomeReferences: vi.fn()
  };
  const service = new IdBusinessV2OrderCompletionService(
    ordersService as never,
    financePostingService as never,
    new IdBusinessV2OrdersRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never)
  );
  let order = makeOrder();
  let consumption: IdBusinessV2BalanceLedger | null = makeConsumption();
  let reversal: IdBusinessV2BalanceLedger | null = null;
  let activation: IdBusinessV2Activation | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    financeAccountLock.mockResolvedValue({
      id: financeAccountId,
      status: 'active',
      currency: 'CNY',
      currentBalance: ReceiptAmount4.from('1000'),
      currentBalanceCny: ReceiptAmount4.from('1000')
    });

    vi.spyOn(IdBusinessV2OrdersRepository.prototype, 'synchronizePostedProfit').mockImplementation(
      async () => Amount4.from(order.profitAmount!.toString())
    );
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
    financePostingService.reserveOrderIncomeReferences.mockResolvedValue(undefined);
    order = makeOrder();
    consumption = makeConsumption();
    reversal = null;
    activation = null;
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_accounts')) {
        return [
          {
            id: accountId,
            purchaseCost: decimal('25'),
            soldByOrderId: orderId,
            soldAt: openedAt,
            ownershipTransferredAt: null,
            lossReportedAt: null,
            recordStatus: 'active',
            disabledReason: null,
            disabledAt: null,
            currentBalance: decimal('10'),
            balanceCostAmount: decimal('30')
          }
        ];
      }
      return [{ id: orderId }];
    });
    tx.idBusinessV2Order.findUnique.mockImplementation(async () => order);
    tx.idBusinessV2BalanceLedger.findFirst.mockImplementation(async ({ where }) => {
      return where.entryType === 'order_consumption' ? consumption : reversal;
    });
    tx.idBusinessV2Activation.findUnique.mockImplementation(async () => activation);
    tx.idBusinessV2Activation.create.mockImplementation(async ({ data }) => {
      activation = makeActivation(data);
      return activation;
    });
    tx.idBusinessV2AccountLock.updateMany.mockResolvedValue({ count: 1 });
    tx.idBusinessV2Account.updateMany.mockResolvedValue({ count: 1 });
    tx.idBusinessV2Order.update.mockImplementation(async ({ data }) => {
      order = makeOrder({
        ...order,
        ...data,
        updatedAt: new Date('2026-07-26T13:00:00.000Z')
      });
      return order;
    });
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    ordersService.get.mockImplementation(async () => ({
      id: order.id,
      status: order.status
    }));
  });

  it('creates one activation and completes the order in the same transaction', async () => {
    const result = await service.complete(orderId, operator);

    expect(tx.idBusinessV2Activation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId,
        customerId,
        accountId,
        serviceOptionId: serviceId,
        openedAt,
        dueAt,
        status: 'active'
      })
    });
    expect(financePostingService.reserveOrderIncomeReferences).toHaveBeenCalledWith(tx, {
      orderId,
      references: ['V220260726TEST001', null]
    });
    expect(tx.idBusinessV2Order.update).toHaveBeenCalledWith({
      where: { id: orderId },
      data: expect.objectContaining({
        status: 'completed',
        updatedByUserId: operator.id
      })
    });
    expect(tx.idBusinessV2AccountLock.updateMany).toHaveBeenCalledWith({
      where: {
        orderId,
        status: 'active'
      },
      data: {
        status: 'released',
        endedAt: expect.any(Date),
        endReason: '订单完成后释放'
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(financePostingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'gift_card_cost',
            direction: 'debit',
            amountCny: Amount4.from('60')
          }),
          expect.objectContaining({
            accountCode: 'customer_owned_balance_cost',
            direction: 'debit',
            amountCny: Amount4.from('30')
          })
        ])
      })
    );
    expect(result).toMatchObject({
      order: {
        id: orderId,
        status: 'completed'
      },
      activation: {
        orderId,
        status: 'active'
      },
      consumptionLedgerId: consumption!.id,
      idempotentReplay: false
    });
  });

  it('rejects completion when no immutable consumption ledger exists', async () => {
    consumption = null;

    await expect(service.complete(orderId, operator)).rejects.toThrow(
      new ConflictException('订单没有真实扣款流水，不能生成开通记录')
    );
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
  });

  it('rejects completion after the consumption has been reversed', async () => {
    reversal = makeConsumption({
      id: '88888888-8888-4888-8888-888888888888',
      entryType: 'order_consumption_reversal',
      direction: 'credit',
      reversalOfEntryId: consumption!.id
    });

    await expect(service.complete(orderId, operator)).rejects.toThrow(
      new ConflictException('订单消费已经撤销，不能生成开通记录')
    );
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
  });

  it('does not complete an order whose income reference is occupied by manual income', async () => {
    financePostingService.reserveOrderIncomeReferences.mockRejectedValue(
      new ConflictException('订单收款标识已用于手工收入')
    );

    await expect(service.complete(orderId, operator)).rejects.toThrow('已用于手工收入');
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
  });

  it('returns the existing activation for a consistent completed-order retry', async () => {
    order = makeOrder({ status: 'completed' });
    activation = makeActivation();

    const result = await service.complete(orderId, operator);

    expect(result.idempotentReplay).toBe(true);
    expect(result.activation.id).toBe(activation.id);
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
  it('blocks a legacy positive order without an account before completion writes', async () => {
    order = makeOrder({ receivedFinanceAccountId: null });
    await expect(service.complete(orderId, operator)).rejects.toThrow('缺少真实收款账户');
    expect(tx.idBusinessV2Activation.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Order.update).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
  });

  it('posts no zero cash lines when the receipt and fee are both zero', async () => {
    order = makeOrder({
      receivedFinanceAccountId: null,
      receivedCurrency: 'USDT',
      receivedFxRateToCny: decimal('7'),
      receivedAmount: decimal('0'),
      receivedOriginalAmount: decimal('0'),
      platformFeeAmount: decimal('0')
    });
    await service.complete(orderId, operator);
    const lines = financePostingService.post.mock.calls[0]![1].lines;
    expect(lines.some((line: { accountCode: string }) => line.accountCode === 'cash')).toBe(false);
    expect(
      lines.find((line: { accountCode: string }) => line.accountCode === 'sales_revenue')
    ).toMatchObject({ currency: 'CNY' });
    expect(financeAccountLock).not.toHaveBeenCalled();
  });
  it('keeps the frozen foreign currency for a fee-only zero receipt with a real account', async () => {
    financeAccountLock.mockResolvedValue({
      id: financeAccountId,
      status: 'active',
      currency: 'USDT',
      currentBalance: ReceiptAmount4.from('1000'),
      currentBalanceCny: ReceiptAmount4.from('7000')
    });
    order = makeOrder({
      receivedCurrency: 'USDT',
      receivedAmount: decimal('0'),
      receivedOriginalAmount: decimal('0'),
      receivedFxRateToCny: decimal('7'),
      platformFeeAmount: decimal('7')
    });
    await service.complete(orderId, operator);
    const lines = financePostingService.post.mock.calls[0]![1].lines;
    const cash = lines.filter((line: { accountCode: string }) => line.accountCode === 'cash');
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({ direction: 'credit', currency: 'USDT', financeAccountId });
    expect(cash[0].amountOriginal.toString()).toBe('1');
    expect(cash[0].amountCny.toString()).toBe('7');
    expect(cash[0].fxRateToCny.toString()).toBe('7');
  });
  it('preserves the old CNY amount fallback when a receipt account is explicitly known', async () => {
    order = makeOrder({ receivedOriginalAmount: decimal('0') });
    await service.complete(orderId, operator);
    const cash = financePostingService.post.mock.calls[0]![1].lines.find(
      (line: { accountCode: string; direction: string }) =>
        line.accountCode === 'cash' && line.direction === 'debit'
    );
    expect(cash.currency).toBe('CNY');
    expect(cash.amountOriginal.toString()).toBe('100');
    expect(cash.amountCny.toString()).toBe('100');
  });
});
