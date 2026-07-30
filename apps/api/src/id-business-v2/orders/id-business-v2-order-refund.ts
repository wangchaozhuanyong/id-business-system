import { ConflictException } from '@nestjs/common';
import { IdBusinessV2OrderAccountDisposition, Prisma as PrismaNamespace } from '@prisma/client';
import type { IdBusinessV2BalanceLedger, IdBusinessV2OrderStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { RefundIdBusinessV2OrderDto } from './dto/refund-id-business-v2-order.dto';
import { releaseSoldOrderAccount } from './id-business-v2-order-account-disposition';
import {
  buildOrderReversalIdempotencyKey,
  normalizeLifecycleBoolean
} from './id-business-v2-order-lifecycle-input';
import type {
  IdBusinessV2OrderLifecycleSupport,
  LifecycleTransactionResult
} from './id-business-v2-order-lifecycle-support';
import type { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import type { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { roundV2Decimal } from '../decimal-policy';

const REFUNDABLE_STATUSES = new Set<IdBusinessV2OrderStatus>(['processing', 'completed']);

export async function refundIdBusinessV2Order(
  support: IdBusinessV2OrderLifecycleSupport,
  orderLockService: IdBusinessV2OrderLockService,
  financePostingService: IdBusinessV2FinancePostingService,
  orderIdValue: string,
  dto: RefundIdBusinessV2OrderDto,
  operator?: AuthenticatedUser
) {
  const orderId = support.normalizeUuid(orderIdValue, '订单');
  const refundCostAmount = support.normalizeAmount(dto.refundCostAmount, '退款成本', true);
  const reason = support.normalizeReason(dto.reason);
  const restoreBalance = normalizeLifecycleBoolean(dto.restoreBalance, '是否恢复余额');
  const accountReturned = normalizeLifecycleBoolean(dto.accountReturned, 'ID 是否已收回');
  const idempotencyKey = buildOrderReversalIdempotencyKey(
    orderId,
    support.normalizeIdempotencyKey(dto.idempotencyKey)
  );

  const result = await support.runLifecycleTransaction(
    async (tx): Promise<LifecycleTransactionResult> => {
      const order = await support.lockOrder(tx, orderId);
      const existingReversal = await support.findReversal(tx, order.id);
      if (order.status === 'refunded') {
        if (
          order.refundCostAmount === null ||
          !order.refundCostAmount.equals(refundCostAmount) ||
          Boolean(existingReversal) !== restoreBalance ||
          (order.accountDisposition === IdBusinessV2OrderAccountDisposition.recovered) !==
            accountReturned
        ) {
          throw new ConflictException('订单已经按其他退款内容处理，请刷新后核对');
        }
        support.assertReversalReplay(existingReversal, idempotencyKey);
        return {
          orderId: order.id,
          reversalLedger: existingReversal,
          balanceRestored: Boolean(existingReversal),
          lockReleased: false,
          idempotentReplay: true
        };
      }
      if (!REFUNDABLE_STATUSES.has(order.status)) {
        throw new ConflictException('只有处理中或已完成订单可以退款');
      }
      if (
        accountReturned &&
        order.accountDisposition !== IdBusinessV2OrderAccountDisposition.sold
      ) {
        throw new ConflictException('只有已卖出的 ID 才能在退款时标记为已收回');
      }

      const consumption = await support.findConsumption(tx, order.id);
      if (!consumption) {
        throw new ConflictException('订单缺少真实消费流水，不能退款');
      }
      if (existingReversal) {
        throw new ConflictException('订单消费已经撤销，不能再次退款');
      }
      const activation = await tx.idBusinessV2Activation.findUnique({
        where: {
          orderId: order.id
        },
        select: {
          id: true
        }
      });
      if (restoreBalance && activation) {
        throw new ConflictException('订单已有开通记录，不能把 Apple 余额自动恢复');
      }

      let reversalLedger: IdBusinessV2BalanceLedger | null = null;
      if (restoreBalance) {
        const restoration = await support.restoreConsumption(
          tx,
          order,
          consumption,
          idempotencyKey,
          `订单退款并恢复余额：${reason}`,
          operator
        );
        reversalLedger = restoration.ledger;
      }
      const effectiveBalanceCost = restoreBalance
        ? new PrismaNamespace.Decimal(0)
        : order.balanceCostAmount;
      if (accountReturned) {
        await releaseSoldOrderAccount(tx, order, operator);
      }
      const nextAccountDisposition = accountReturned
        ? IdBusinessV2OrderAccountDisposition.recovered
        : order.accountDisposition;
      const appliedAccountCostAmount =
        nextAccountDisposition === IdBusinessV2OrderAccountDisposition.sold
          ? order.accountCostAmount
          : new PrismaNamespace.Decimal(0);
      const profitAmount = support.calculateProfit(
        order.receivedAmount,
        order.platformFeeAmount,
        appliedAccountCostAmount,
        effectiveBalanceCost,
        refundCostAmount
      );
      const release = await orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `订单退款：${reason}`,
        operator
      );
      const statusChangedAt = new Date();
      await tx.idBusinessV2Order.update({
        where: {
          id: order.id
        },
        data: {
          refundCostAmount,
          balanceCostAmount: effectiveBalanceCost,
          accountDisposition: nextAccountDisposition,
          profitAmount,
          status: 'refunded',
          statusChangedAt,
          updatedByUserId: operator?.id
        }
      });
      const financeJournal = await financePostingService.post(tx, {
        journalType: 'order_refund',
        sourceType: 'order',
        sourceId: order.id,
        sourceReference: order.orderNo,
        occurredAt: statusChangedAt,
        summary: `订单退款：${order.orderNo}`,
        metadata: {
          reason,
          restoreBalance,
          accountReturned,
          originalStatus: order.status
        },
        idempotencyKey: `auto:order_refund:${order.id}`,
        operator,
        lines: buildRefundFinanceLines(order, refundCostAmount, restoreBalance, accountReturned)
      });
      await support.writeLifecycleAudit(
        tx,
        'refund',
        order,
        {
          status: 'refunded',
          statusChangedAt,
          reason,
          refundCostAmount: refundCostAmount.toString(),
          balanceRestored: restoreBalance,
          accountReturned,
          accountDisposition: nextAccountDisposition,
          accountCostAmountSnapshot: order.accountCostAmount.toString(),
          appliedAccountCostAmount: appliedAccountCostAmount.toString(),
          reversalLedgerId: reversalLedger?.id ?? null,
          balanceCostAmount: effectiveBalanceCost.toString(),
          profitAmount: profitAmount.toString(),
          lockReleased: release.released,
          financeJournalId: financeJournal.id
        },
        operator
      );
      return {
        orderId: order.id,
        reversalLedger,
        balanceRestored: restoreBalance,
        lockReleased: release.released,
        idempotentReplay: false
      };
    },
    '订单已经退款或消费撤销正在并发处理，请刷新后核对'
  );

  return support.buildLifecycleResponse(result);
}

function buildRefundFinanceLines(
  order: {
    receivedAmount: PrismaNamespace.Decimal;
    receivedOriginalAmount: PrismaNamespace.Decimal;
    receivedCurrency: 'CNY' | 'MYR' | 'USDT';
    receivedFxRateToCny: PrismaNamespace.Decimal;
    receivedFxSnapshotId: string | null;
    receivedFinanceAccountId: string | null;
    balanceCostAmount: PrismaNamespace.Decimal;
    accountCostAmount: PrismaNamespace.Decimal;
    status: IdBusinessV2OrderStatus;
  },
  refundCostAmount: PrismaNamespace.Decimal,
  restoreBalance: boolean,
  accountReturned: boolean
) {
  const completed = order.status === 'completed';
  const hasOriginalEvidence = order.receivedOriginalAmount.gt(0);
  const currency = hasOriginalEvidence ? order.receivedCurrency : ('CNY' as const);
  const rate = hasOriginalEvidence ? order.receivedFxRateToCny : new PrismaNamespace.Decimal(1);
  const receivedOriginal = hasOriginalEvidence
    ? order.receivedOriginalAmount
    : order.receivedAmount;
  const refundCostOriginal =
    currency === 'CNY' ? refundCostAmount : roundV2Decimal(refundCostAmount.div(rate));
  const lines = [];
  if (completed) {
    lines.push(
      {
        accountCode: 'sales_revenue' as const,
        direction: 'debit' as const,
        currency,
        amountOriginal: receivedOriginal,
        fxRateToCny: rate,
        amountCny: order.receivedAmount,
        fxRateSnapshotId: order.receivedFxSnapshotId,
        memo: '冲回已完成订单收入'
      },
      {
        accountCode: 'cash' as const,
        direction: 'credit' as const,
        currency,
        amountOriginal: receivedOriginal,
        fxRateToCny: rate,
        amountCny: order.receivedAmount,
        financeAccountId: order.receivedFinanceAccountId,
        fxRateSnapshotId: order.receivedFxSnapshotId,
        memo: '订单退款支出'
      }
    );
  }
  lines.push(
    {
      accountCode: 'refund_loss' as const,
      direction: 'debit' as const,
      currency,
      amountOriginal: refundCostOriginal,
      fxRateToCny: rate,
      amountCny: refundCostAmount,
      fxRateSnapshotId: order.receivedFxSnapshotId,
      memo: '退款附加成本'
    },
    {
      accountCode: 'cash' as const,
      direction: 'credit' as const,
      currency,
      amountOriginal: refundCostOriginal,
      fxRateToCny: rate,
      amountCny: refundCostAmount,
      financeAccountId: order.receivedFinanceAccountId,
      fxRateSnapshotId: order.receivedFxSnapshotId,
      memo: '退款成本支付'
    }
  );
  if (restoreBalance) {
    lines.push(
      {
        accountCode: 'gift_card_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: order.balanceCostAmount,
        fxRateToCny: 1,
        amountCny: order.balanceCostAmount,
        memo: '退款恢复礼品卡余额资产'
      },
      {
        accountCode: 'gift_card_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: order.balanceCostAmount,
        fxRateToCny: 1,
        amountCny: order.balanceCostAmount,
        memo: '冲回礼品卡销售成本'
      }
    );
  }
  if (accountReturned) {
    lines.push(
      {
        accountCode: 'id_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: order.accountCostAmount,
        fxRateToCny: 1,
        amountCny: order.accountCostAmount,
        memo: '退款收回 ID 库存'
      },
      {
        accountCode: 'id_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: order.accountCostAmount,
        fxRateToCny: 1,
        amountCny: order.accountCostAmount,
        memo: '冲回已卖 ID 成本'
      }
    );
  }
  return lines;
}
