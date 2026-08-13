import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import {
  buildSoldAccountRecoveryPreview,
  recoverIdBusinessV2SoldAccount
} from './id-business-v2-order-sold-account-recovery';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const orderId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const operator = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.order.update']
};

function makeAccount() {
  return {
    id: accountId,
    purchaseCost: Amount4.from('25'),
    soldByOrderId: orderId,
    soldAt: new Date('2026-08-01T00:00:00.000Z'),
    lossReportedAt: null,
    recordStatus: 'active' as const,
    disabledReason: null,
    disabledAt: null,
    currentBalance: Amount4.from('8'),
    balanceCostAmount: Amount4.from('12')
  };
}

function makeOrder() {
  return {
    id: orderId,
    orderNo: 'V220260801SOLD001',
    accountId,
    accountDisposition: 'sold' as const,
    accountCostAmount: Amount4.from('25'),
    appliedAccountCostAmount: Amount4.from('25'),
    accountSource: 'inventory' as const,
    receivedAmount: Amount4.from('100'),
    platformFeeAmount: Amount4.from('3'),
    balanceCostAmount: Amount4.from('40'),
    refundCostAmount: null,
    profitAmount: Amount4.from('32')
  };
}

describe('sold account recovery', () => {
  it('returns every blocking reason needed by the recovery dialog', () => {
    expect(
      buildSoldAccountRecoveryPreview({
        currentBalance: Amount4.from('1'),
        balanceCostAmount: Amount4.from('2'),
        lossReportedAt: new Date('2026-08-02T00:00:00.000Z'),
        recordStatus: 'disabled',
        pendingAfterSalesOrders: 1,
        activeActivations: 2,
        activeLocks: 3
      })
    ).toMatchObject({
      canRecover: false,
      recordStatus: 'disabled',
      blockers: [
        { code: 'pending_after_sales_order' },
        { code: 'active_activation' },
        { code: 'active_lock' },
        { code: 'loss_reported' }
      ]
    });
  });

  it('rechecks blockers in the transaction and leaves ownership unchanged on conflict', async () => {
    const { support, orderLockService, financePostingService, repository } = makeDependencies();
    repository.findSoldAccountRecoveryBlockers.mockResolvedValue({
      pendingAfterSalesOrders: 1,
      activeActivations: 0,
      activeLocks: 0
    });

    await expect(
      recoverIdBusinessV2SoldAccount(
        support as never,
        orderLockService as never,
        financePostingService as never,
        repository as never,
        orderId,
        { accountId, reason: '客户退回并已核对' },
        operator
      )
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.releaseSoldAccount).not.toHaveBeenCalled();
    expect(repository.updateOrder).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
  });

  it('recovers ownership and reverses the ID cost exactly once after all checks pass', async () => {
    const { support, orderLockService, financePostingService, repository } = makeDependencies();

    const result = await recoverIdBusinessV2SoldAccount(
      support as never,
      orderLockService as never,
      financePostingService as never,
      repository as never,
      orderId,
      { accountId, reason: '客户退回并已核对' },
      operator
    );

    expect(repository.releaseSoldAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId, orderId })
    );
    expect(repository.updateOrder).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      expect.objectContaining({
        accountDisposition: 'recovered',
        appliedAccountCostAmount: '0'
      })
    );
    expect(financePostingService.post).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        journalType: 'order_recovery',
        lines: [
          expect.objectContaining({
            accountCode: 'id_inventory',
            direction: 'debit',
            amountCny: Amount4.from('25')
          }),
          expect.objectContaining({
            accountCode: 'id_cost',
            direction: 'credit',
            amountCny: Amount4.from('25')
          })
        ]
      })
    );
    expect(orderLockService.releaseOrderLockInTransaction).not.toHaveBeenCalled();
    expect(orderLockService.narrowOrderLockToServiceInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      orderId,
      expect.stringContaining('纠正 ID 售出记录'),
      operator
    );
    expect(result).toMatchObject({
      accountId,
      orderId,
      lockReleased: false,
      financeJournalId: 'journal-recovery'
    });
  });

  it('counts every pending customer-owned order on the ID before recovery', async () => {
    const countOrders = vi.fn().mockResolvedValue(2);
    const countActivations = vi.fn().mockResolvedValue(0);
    const countLocks = vi.fn().mockResolvedValue(0);
    const repository = new IdBusinessV2OrdersRepository({} as never);

    await repository.findSoldAccountRecoveryBlockers(
      {
        idBusinessV2Order: { count: countOrders },
        idBusinessV2Activation: { count: countActivations },
        idBusinessV2AccountLock: { count: countLocks }
      } as never,
      {
        accountId,
        sourceOrderId: orderId,
        evaluatedAt: new Date('2026-08-03T00:00:00.000Z')
      }
    );

    expect(countOrders).toHaveBeenCalledWith({
      where: {
        accountId,
        accountSource: 'customer_owned',
        sourceSoldOrderId: orderId,
        deletedAt: null,
        status: { in: ['draft', 'pending', 'waiting_external', 'processing', 'completed'] }
      }
    });
    expect(countActivations).toHaveBeenCalledWith({
      where: expect.objectContaining({ accountId, orderId: { not: orderId }, status: 'active' })
    });
    expect(countLocks).toHaveBeenCalledWith({
      where: expect.objectContaining({ accountId, orderId: { not: orderId }, status: 'active' })
    });
  });
});

function makeDependencies() {
  const tx = {};
  const order = makeOrder();
  const support = {
    normalizeUuid: vi.fn((value) => value),
    normalizeReason: vi.fn((value) => value),
    runLifecycleTransaction: vi.fn(async (callback) => callback(tx)),
    lockOrder: vi.fn().mockResolvedValue(order),
    findConsumption: vi.fn().mockResolvedValue({ id: 'consumption-1' }),
    calculateProfit: vi.fn().mockReturnValue(Amount4.from('57'))
  };
  const repository = {
    lockAccountForSale: vi.fn().mockResolvedValue(makeAccount()),
    findSoldAccountRecoveryBlockers: vi.fn().mockResolvedValue({
      pendingAfterSalesOrders: 0,
      activeActivations: 0,
      activeLocks: 0
    }),
    findPostedOrderCompletionIdCost: vi.fn().mockResolvedValue({
      journalId: 'journal-completion',
      amount: Amount4.from('25')
    }),
    releaseSoldAccount: vi.fn().mockResolvedValue({ count: 1 }),
    updateOrder: vi.fn().mockResolvedValue(order),
    appendAudit: vi.fn().mockResolvedValue({ id: 'audit-1' })
  };
  const orderLockService = {
    releaseOrderLockInTransaction: vi.fn().mockResolvedValue({ released: true }),
    narrowOrderLockToServiceInTransaction: vi.fn().mockResolvedValue({
      changed: true,
      lock: { id: 'lock-1', lockScope: 'by_service' }
    })
  };
  const financePostingService = {
    post: vi.fn().mockResolvedValue({ id: 'journal-recovery' })
  };
  return { support, orderLockService, financePostingService, repository };
}
