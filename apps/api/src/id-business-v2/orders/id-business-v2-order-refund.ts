import { ConflictException } from '@nestjs/common';
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
import { Amount4, Rate8 } from '../runtime/public-api';
import type {
  IdBusinessV2BalanceLedgerRecord,
  IdBusinessV2OrderRecord,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';
import type { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import { assertSoldAccountCanRecover } from './id-business-v2-order-sold-account-recovery';

const REFUNDABLE_STATUSES = new Set<IdBusinessV2OrderStatus>(['completed']);

export async function refundIdBusinessV2Order(
  support: IdBusinessV2OrderLifecycleSupport,
  orderLockService: IdBusinessV2OrderLockService,
  financePostingService: IdBusinessV2FinancePostingService,
  repository: IdBusinessV2OrdersRepository,
  orderIdValue: string,
  dto: RefundIdBusinessV2OrderDto,
  operator?: AuthenticatedUser
) {
  const orderId = support.normalizeUuid(orderIdValue, '订单');
  const refundCostAmount = support.normalizeAmount(dto.refundCostAmount, '额外退款成本', true);
  const reason = support.normalizeReason(dto.reason);
  const restoreBalance = normalizeLifecycleBoolean(dto.restoreBalance, '是否恢复余额');
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
          Boolean(existingReversal) !== restoreBalance
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
        throw new ConflictException('只有已完成订单可以退款；处理中订单请按真实结果取消或先完成');
      }

      const consumption = await support.findConsumption(tx, order.id);
      if (!consumption) {
        throw new ConflictException('订单缺少真实消费流水，不能退款');
      }
      if (existingReversal) {
        throw new ConflictException('订单消费已经撤销，不能再次退款');
      }
      const activation = await repository.findActivationByOrder(tx, order.id);

      let reversalLedger: IdBusinessV2BalanceLedgerRecord | null = null;
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
      const effectiveBalanceCost = restoreBalance ? Amount4.zero() : order.balanceCostAmount;
      const release = await orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `订单退款：${reason}`,
        operator
      );
      const accountRecovered = order.accountDisposition === 'sold';
      if (accountRecovered) {
        if (!order.accountId) throw new ConflictException('已售订单缺少 ID 关联');
        const account = await repository.lockAccountForSale(tx, order.accountId);
        if (!account || account.soldByOrderId !== order.id) {
          throw new ConflictException('ID 售出归属已变更，请刷新后核对');
        }
        await assertSoldAccountCanRecover(repository, tx, account, order.id);
        await releaseSoldOrderAccount(tx, repository, order, operator);
      }
      const nextAccountDisposition = accountRecovered ? 'recovered' : order.accountDisposition;
      const appliedAccountCostAmount =
        nextAccountDisposition === 'sold' ? order.appliedAccountCostAmount : Amount4.zero();
      const profitAmount = support.calculateProfit(
        Amount4.zero(),
        order.platformFeeAmount,
        appliedAccountCostAmount,
        effectiveBalanceCost,
        refundCostAmount
      );
      const statusChangedAt = new Date();
      const activationCancelled = Boolean(activation && activation.status !== 'cancelled');
      if (activationCancelled && activation) {
        const activationRemark = appendRefundRemark(activation.remark, reason);
        await repository.updateActivation(tx, order.id, {
          status: 'cancelled',
          statusChangedAt,
          remark: activationRemark,
          updatedByUserId: operator?.id
        });
        await repository.appendAudit(tx, {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.activation.cancel_by_order_refund',
          objectType: 'id_business_v2_activation',
          objectId: activation.id,
          beforeData: {
            orderId: order.id,
            status: activation.status,
            statusChangedAt: activation.statusChangedAt,
            remark: activation.remark
          },
          afterData: {
            orderId: order.id,
            status: 'cancelled',
            statusChangedAt,
            remark: activationRemark,
            reason
          },
          remark: `订单全额退款取消开通：${order.orderNo}`
        });
      }
      await repository.updateOrder(tx, order.id, {
        refundCostAmount: refundCostAmount.toString(),
        balanceCostAmount: effectiveBalanceCost.toString(),
        accountDisposition: nextAccountDisposition,
        appliedAccountCostAmount: appliedAccountCostAmount.toString(),
        profitAmount: profitAmount.toString(),
        status: 'refunded',
        statusChangedAt,
        updatedByUserId: operator?.id
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
          accountRecovered,
          activationCancelled,
          originalStatus: order.status
        },
        idempotencyKey: `auto:order_refund:${order.id}`,
        operator,
        lines: buildRefundFinanceLines(order, refundCostAmount, restoreBalance, accountRecovered)
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
          accountRecovered,
          activationCancelled,
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
    '订单已经退款或消费撤销正在并发处理，请刷新后核对',
    operator
  );

  return support.buildLifecycleResponse(result);
}

function appendRefundRemark(existingRemark: string | null, reason: string) {
  const refundRemark = `订单全额退款并取消开通：${reason}`;
  return existingRemark ? `${existingRemark}\n${refundRemark}` : refundRemark;
}

function buildRefundFinanceLines(
  order: Pick<
    IdBusinessV2OrderRecord,
    | 'receivedAmount'
    | 'receivedOriginalAmount'
    | 'receivedCurrency'
    | 'receivedFxRateToCny'
    | 'receivedFxSnapshotId'
    | 'receivedFinanceAccountId'
    | 'balanceCostAmount'
    | 'appliedAccountCostAmount'
    | 'status'
  >,
  refundCostAmount: Amount4,
  restoreBalance: boolean,
  accountRecovered: boolean
) {
  const completed = order.status === 'completed';
  const receivedOriginalAmount = order.receivedOriginalAmount;
  const receivedAmount = order.receivedAmount;
  const receivedFxRateToCny = order.receivedFxRateToCny;
  const balanceCostAmount = order.balanceCostAmount;
  const appliedAccountCostAmount = order.appliedAccountCostAmount;
  const hasOriginalEvidence = receivedOriginalAmount.gt(0);
  const currency = hasOriginalEvidence ? order.receivedCurrency : ('CNY' as const);
  const rate = hasOriginalEvidence ? receivedFxRateToCny : Rate8.one();
  const receivedOriginal = hasOriginalEvidence ? receivedOriginalAmount : receivedAmount;
  const refundCostOriginal = currency === 'CNY' ? refundCostAmount : refundCostAmount.div(rate);
  const lines = [];
  if (completed) {
    lines.push(
      {
        accountCode: 'sales_revenue' as const,
        direction: 'debit' as const,
        currency,
        amountOriginal: receivedOriginal,
        fxRateToCny: rate,
        amountCny: receivedAmount,
        fxRateSnapshotId: order.receivedFxSnapshotId,
        memo: '冲回已完成订单收入'
      },
      {
        accountCode: 'cash' as const,
        direction: 'credit' as const,
        currency,
        amountOriginal: receivedOriginal,
        fxRateToCny: rate,
        amountCny: receivedAmount,
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
        amountOriginal: balanceCostAmount,
        fxRateToCny: 1,
        amountCny: balanceCostAmount,
        memo: '退款恢复礼品卡余额资产'
      },
      {
        accountCode: 'gift_card_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: balanceCostAmount,
        fxRateToCny: 1,
        amountCny: balanceCostAmount,
        memo: '冲回礼品卡销售成本'
      }
    );
  }
  if (accountRecovered && !appliedAccountCostAmount.isZero()) {
    lines.push(
      {
        accountCode: 'id_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: appliedAccountCostAmount,
        fxRateToCny: 1,
        amountCny: appliedAccountCostAmount,
        memo: '退款收回 ID 库存'
      },
      {
        accountCode: 'id_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: appliedAccountCostAmount,
        fxRateToCny: 1,
        amountCny: appliedAccountCostAmount,
        memo: '冲回已卖 ID 成本'
      }
    );
  }
  return lines;
}
