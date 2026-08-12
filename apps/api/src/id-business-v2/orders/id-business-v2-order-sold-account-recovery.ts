import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { Amount4, type V2CommandTransaction } from '../runtime/public-api';
import type { RecoverIdBusinessV2SoldAccountDto } from './dto/recover-id-business-v2-sold-account.dto';
import { releaseSoldOrderAccount } from './id-business-v2-order-account-disposition';
import type { IdBusinessV2OrderLifecycleSupport } from './id-business-v2-order-lifecycle-support';
import type { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import type {
  IdBusinessV2OrdersRepository,
  LockedAccountForSale
} from './persistence/id-business-v2-orders.repository';

export function buildSoldAccountRecoveryPreview(input: {
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  lossReportedAt: Date | null;
  recordStatus: 'active' | 'disabled';
  pendingAfterSalesOrders?: number;
  activeActivations: number;
  activeLocks: number;
}) {
  const blockers = [
    ...(input.currentBalance.isZero()
      ? []
      : [{ code: 'remaining_balance' as const, message: 'ID 余额尚未清零' }]),
    ...(input.balanceCostAmount.isZero()
      ? []
      : [{ code: 'remaining_balance_cost' as const, message: 'ID 余额成本尚未清零' }]),
    ...((input.pendingAfterSalesOrders ?? 0) === 0
      ? []
      : [{ code: 'pending_after_sales_order' as const, message: '仍有处理中的售后订单' }]),
    ...(input.activeActivations === 0
      ? []
      : [{ code: 'active_activation' as const, message: '仍有尚未到期的有效业务' }]),
    ...(input.activeLocks === 0
      ? []
      : [{ code: 'active_lock' as const, message: '仍有活动 ID 锁' }]),
    ...(input.lossReportedAt === null
      ? []
      : [{ code: 'loss_reported' as const, message: 'ID 仍处于报损冻结状态' }])
  ];
  return {
    canRecover: blockers.length === 0,
    currentBalance: input.currentBalance.toString(),
    balanceCostAmount: input.balanceCostAmount.toString(),
    recordStatus: input.recordStatus,
    counts: {
      pendingAfterSalesOrders: input.pendingAfterSalesOrders ?? 0,
      activeActivations: input.activeActivations,
      activeLocks: input.activeLocks
    },
    blockers
  };
}

export async function assertSoldAccountCanRecover(
  repository: IdBusinessV2OrdersRepository,
  tx: V2CommandTransaction,
  account: LockedAccountForSale,
  sourceOrderId: string
) {
  const preview = buildSoldAccountRecoveryPreview({
    ...account,
    ...(await repository.findSoldAccountRecoveryBlockers(tx, {
      accountId: account.id,
      sourceOrderId,
      evaluatedAt: new Date()
    }))
  });
  if (!preview.canRecover) {
    throw new ConflictException(
      `当前不能恢复库存归属：${preview.blockers.map((item) => item.message).join('；')}`
    );
  }
  return preview;
}

export async function recoverIdBusinessV2SoldAccount(
  support: IdBusinessV2OrderLifecycleSupport,
  orderLockService: IdBusinessV2OrderLockService,
  financePostingService: IdBusinessV2FinancePostingService,
  repository: IdBusinessV2OrdersRepository,
  orderIdValue: string,
  dto: RecoverIdBusinessV2SoldAccountDto,
  operator?: AuthenticatedUser
) {
  const orderId = support.normalizeUuid(orderIdValue, '订单');
  const accountId = support.normalizeUuid(dto.accountId, 'ID');
  const reason = support.normalizeReason(dto.reason);
  if (reason.length > 200) {
    throw new BadRequestException('恢复原因必须为 2 至 200 个字符');
  }

  const result = await support.runLifecycleTransaction(
    async (tx) => {
      const order = await support.lockOrder(tx, orderId);
      if (order.accountId !== accountId) {
        throw new ConflictException('该 ID 与来源订单不一致，请刷新后重试');
      }
      if (order.accountDisposition !== 'sold') {
        throw new ConflictException('该订单的 ID 已不是卖出状态，请刷新后核对');
      }

      const account = await repository.lockAccountForSale(tx, accountId);
      if (!account) throw new ConflictException('该 ID 不存在或已删除');
      if (account.lossReportedAt) {
        throw new ConflictException('已报损冻结 ID 不能恢复为可用');
      }
      if (account.soldByOrderId !== order.id) {
        throw new ConflictException('ID 售出关联已变化，请刷新后核对');
      }

      await assertSoldAccountCanRecover(repository, tx, account, order.id);

      const [consumption, completionIdCost] = await Promise.all([
        support.findConsumption(tx, order.id),
        repository.findPostedOrderCompletionIdCost(tx, order.id)
      ]);
      if (completionIdCost && !completionIdCost.amount.equals(order.accountCostAmount)) {
        throw new ConflictException('订单 ID 成本快照与已入账金额不一致，请先核对财务记录');
      }
      const profitAmount = consumption
        ? support.calculateProfit(
            order.receivedAmount,
            order.platformFeeAmount,
            Amount4.zero(),
            order.balanceCostAmount,
            order.refundCostAmount
          )
        : null;

      await releaseSoldOrderAccount(tx, repository, order, operator);
      const release = await orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `已售出 ID 恢复可用：${reason}`,
        operator
      );
      const recoveredAt = new Date();
      await repository.updateOrder(tx, order.id, {
        accountDisposition: 'recovered',
        appliedAccountCostAmount: '0',
        profitAmount: profitAmount?.toString() ?? null,
        updatedByUserId: operator?.id
      });

      const recoveredCost = completionIdCost?.amount ?? Amount4.zero();
      const financeJournal = recoveredCost.gt(0)
        ? await financePostingService.post(tx, {
            journalType: 'order_recovery',
            sourceType: 'order',
            sourceId: order.id,
            sourceReference: order.orderNo,
            occurredAt: recoveredAt,
            summary: `订单收回 ID：${order.orderNo}`,
            metadata: {
              reason,
              accountId,
              completionJournalId: completionIdCost?.journalId ?? null,
              accountCostAmountSnapshot: order.accountCostAmount.toString()
            },
            idempotencyKey: `auto:order_recovery:${order.id}:${account.soldAt?.getTime() ?? 'legacy'}`,
            operator,
            lines: [
              {
                accountCode: 'id_inventory',
                direction: 'debit',
                currency: 'CNY',
                amountOriginal: recoveredCost,
                fxRateToCny: 1,
                amountCny: recoveredCost,
                memo: '收回已售 ID 库存成本'
              },
              {
                accountCode: 'id_cost',
                direction: 'credit',
                currency: 'CNY',
                amountOriginal: recoveredCost,
                fxRateToCny: 1,
                amountCny: recoveredCost,
                memo: '冲回已售 ID 成本'
              }
            ]
          })
        : null;

      await repository.appendAudit(tx, {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.account.recover_available',
        objectType: 'id_business_v2_account',
        objectId: accountId,
        beforeData: {
          saleState: 'sold',
          soldByOrderId: order.id,
          orderNo: order.orderNo,
          accountDisposition: order.accountDisposition,
          recordStatus: account.recordStatus,
          disabledReason: account.disabledReason,
          disabledAt: account.disabledAt,
          profitAmount: order.profitAmount?.toString() ?? null
        },
        afterData: {
          saleState: 'available',
          soldByOrderId: null,
          orderNo: order.orderNo,
          accountDisposition: 'recovered',
          recordStatus: account.recordStatus,
          accountCostAmountSnapshot: order.accountCostAmount.toString(),
          profitAmount: profitAmount?.toString() ?? null,
          recoveredCostAmount: recoveredCost.toString(),
          financeJournalId: financeJournal?.id ?? null,
          lockReleased: release.released,
          reason
        },
        remark: `已售出 ID 恢复可用：${order.orderNo}`
      });

      return {
        accountId,
        orderId: order.id,
        recoveredAt,
        lockReleased: release.released,
        financeJournalId: financeJournal?.id ?? null
      };
    },
    'ID 售出状态已被其他操作修改，请刷新后核对',
    operator
  );

  return { ...result, recoveredAt: result.recoveredAt.toISOString() };
}
