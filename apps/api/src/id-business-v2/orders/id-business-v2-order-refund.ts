import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  IdBusinessV2OrderBalanceRefundMode,
  RefundIdBusinessV2OrderDto
} from './dto/refund-id-business-v2-order.dto';
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
import { Amount4, Rate8, type V2CommandTransaction } from '../runtime/public-api';
import type {
  IdBusinessV2BalanceLedgerRecord,
  IdBusinessV2OrderRecord,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';
import type { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

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
  const balanceRefundRequest = normalizeBalanceRefundRequest(support, dto);
  const idempotencyKey = buildOrderReversalIdempotencyKey(
    orderId,
    support.normalizeIdempotencyKey(dto.idempotencyKey)
  );

  const result = await support.runLifecycleTransaction(
    async (tx): Promise<LifecycleTransactionResult> => {
      const order = await support.lockOrder(tx, orderId);
      const existingReversal = await support.findReversal(tx, order.id);
      const activeUpgradeBalanceReturn = await repository.findActiveBalanceReturn(tx, order.id);
      const remainingRefundableBalanceAmount = resolveRemainingRefundableBalanceAmount(
        order.balanceAmount,
        activeUpgradeBalanceReturn?.returnedBalanceAmount ?? Amount4.zero()
      );
      if (order.status === 'refunded') {
        const requestedBalanceAmount = resolveRequestedBalanceAmount(
          balanceRefundRequest,
          remainingRefundableBalanceAmount
        );
        const restoreBalance = !requestedBalanceAmount.isZero();
        if (
          order.refundCostAmount === null ||
          !order.refundCostAmount.equals(refundCostAmount) ||
          Boolean(existingReversal) !== restoreBalance ||
          (existingReversal && !existingReversal.balanceAmount.equals(requestedBalanceAmount))
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
      if (
        activeUpgradeBalanceReturn &&
        (activeUpgradeBalanceReturn.accountId !== consumption.accountId ||
          activeUpgradeBalanceReturn.returnedBalanceAmount.gt(consumption.balanceAmount) ||
          activeUpgradeBalanceReturn.restoredBalanceCostAmount.gt(consumption.costAmount))
      ) {
        throw new ConflictException('升级退币记录与原消费流水不一致，请先核对财务记录');
      }
      const remainingRefundableBalanceCostAmount = consumption.costAmount.sub(
        activeUpgradeBalanceReturn?.restoredBalanceCostAmount ?? Amount4.zero()
      );
      const requestedBalanceAmount = resolveRequestedBalanceAmount(
        balanceRefundRequest,
        remainingRefundableBalanceAmount
      );
      const requestedBalanceCostAmount = resolveRequestedBalanceCostAmount(
        requestedBalanceAmount,
        remainingRefundableBalanceAmount,
        remainingRefundableBalanceCostAmount
      );
      const restoreBalance = !requestedBalanceAmount.isZero();
      const activation = await repository.findActivationByOrder(tx, order.id);
      const sourceOrderForRestoration =
        restoreBalance && order.accountSource === 'customer_owned' && order.sourceSoldOrderId
          ? await support.lockOrder(tx, order.sourceSoldOrderId, true)
          : null;

      let reversalLedger: IdBusinessV2BalanceLedgerRecord | null = null;
      let restoredBalanceCostAmount = Amount4.zero();
      let balanceCostBeforeRestoration: Amount4 | null = null;
      let restorationAccountWasCustomerOwned = false;
      if (restoreBalance) {
        const restoration = await support.restoreConsumption(
          tx,
          order,
          consumption,
          idempotencyKey,
          `订单退款并恢复余额：${reason}`,
          operator,
          requestedBalanceAmount,
          requestedBalanceCostAmount
        );
        reversalLedger = restoration.ledger;
        restoredBalanceCostAmount = restoration.ledger.costAmount;
        balanceCostBeforeRestoration = restoration.account.balanceCostAmount;
        restorationAccountWasCustomerOwned = Boolean(restoration.account.ownershipTransferredAt);
      }
      if (restoredBalanceCostAmount.gt(order.balanceCostAmount)) {
        throw new ConflictException('退款恢复的余额成本超过订单余额成本，请刷新后核对');
      }
      const effectiveBalanceCost = order.balanceCostAmount.sub(restoredBalanceCostAmount);
      const release = await orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `订单退款：${reason}`,
        operator
      );
      const accountRecovered = order.accountDisposition === 'sold';
      let recoveredCustomerOwnedBalanceCostAmount = Amount4.zero();
      if (accountRecovered) {
        if (!order.accountId) throw new ConflictException('已售订单缺少 ID 关联');
        const account = await repository.lockAccountForSale(tx, order.accountId);
        if (!account || account.soldByOrderId !== order.id) {
          throw new ConflictException('ID 售出归属已变更，请刷新后核对');
        }
        if (account.lossReportedAt) {
          throw new ConflictException('已报损冻结 ID 不能随订单退款恢复可用，请先解除报损');
        }
        recoveredCustomerOwnedBalanceCostAmount = account.ownershipTransferredAt
          ? (balanceCostBeforeRestoration ?? account.balanceCostAmount)
          : Amount4.zero();
        await releaseSoldOrderAccount(tx, repository, order, operator);
      }
      const nextAccountDisposition = accountRecovered ? 'recovered' : order.accountDisposition;
      const appliedAccountCostAmount =
        nextAccountDisposition === 'sold' ? order.appliedAccountCostAmount : Amount4.zero();
      const recoveredSourceTransferCost = recoveredCustomerOwnedBalanceCostAmount.gt(
        order.transferredBalanceCostAmount
      )
        ? order.transferredBalanceCostAmount
        : recoveredCustomerOwnedBalanceCostAmount;
      const restoredCostReturnsToCompany = !restorationAccountWasCustomerOwned || accountRecovered;
      const restoredAppliedBalanceCost = restoredCostReturnsToCompany
        ? restoredBalanceCostAmount.gt(order.appliedBalanceCostAmount)
          ? order.appliedBalanceCostAmount
          : restoredBalanceCostAmount
        : Amount4.zero();
      const restoredCustomerOwnedBalanceCost = restoredCostReturnsToCompany
        ? restoredBalanceCostAmount.sub(restoredAppliedBalanceCost)
        : Amount4.zero();
      const restoredSourceOrder = restoredCustomerOwnedBalanceCost.isZero()
        ? null
        : await restoreRecoveredCustomerOwnedSourceOrderCost(
            support,
            repository,
            tx,
            order,
            sourceOrderForRestoration,
            restoredCustomerOwnedBalanceCost,
            reason,
            operator
          );
      const appliedBalanceCostAmount = order.appliedBalanceCostAmount
        .sub(restoredAppliedBalanceCost)
        .sub(recoveredSourceTransferCost);
      const profitAmount = support.calculateProfit(
        Amount4.zero(),
        order.platformFeeAmount,
        appliedAccountCostAmount,
        appliedBalanceCostAmount,
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
        appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
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
          balanceRefundMode: balanceRefundRequest.mode,
          refundedBalanceAmount: requestedBalanceAmount.toString(),
          restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
          priorUpgradeReturnedBalanceAmount:
            activeUpgradeBalanceReturn?.returnedBalanceAmount.toString() ?? '0',
          priorUpgradeRestoredBalanceCostAmount:
            activeUpgradeBalanceReturn?.restoredBalanceCostAmount.toString() ?? '0',
          restoredAppliedBalanceCostAmount: restoredAppliedBalanceCost.toString(),
          restoredCustomerOwnedBalanceCostAmount: restoredCustomerOwnedBalanceCost.toString(),
          restoredSourceOrderId: restoredSourceOrder?.id ?? null,
          restoredSourceOrderCostAmount: restoredSourceOrder?.costAmount.toString() ?? '0',
          recoveredCustomerOwnedBalanceCostAmount:
            recoveredCustomerOwnedBalanceCostAmount.toString(),
          restoredCostReturnsToCompany,
          accountRecovered,
          activationCancelled,
          originalStatus: order.status
        },
        idempotencyKey: `auto:order_refund:${order.id}`,
        operator,
        lines: buildRefundFinanceLines(
          order,
          refundCostAmount,
          restoredBalanceCostAmount,
          accountRecovered,
          recoveredCustomerOwnedBalanceCostAmount,
          restoredAppliedBalanceCost,
          restoredCustomerOwnedBalanceCost
        )
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
          balanceRefundMode: balanceRefundRequest.mode,
          refundedBalanceAmount: requestedBalanceAmount.toString(),
          restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
          priorUpgradeReturnedBalanceAmount:
            activeUpgradeBalanceReturn?.returnedBalanceAmount.toString() ?? '0',
          priorUpgradeRestoredBalanceCostAmount:
            activeUpgradeBalanceReturn?.restoredBalanceCostAmount.toString() ?? '0',
          restoredAppliedBalanceCostAmount: restoredAppliedBalanceCost.toString(),
          restoredCustomerOwnedBalanceCostAmount: restoredCustomerOwnedBalanceCost.toString(),
          restoredSourceOrderId: restoredSourceOrder?.id ?? null,
          restoredSourceOrderCostAmount: restoredSourceOrder?.costAmount.toString() ?? '0',
          recoveredCustomerOwnedBalanceCostAmount:
            recoveredCustomerOwnedBalanceCostAmount.toString(),
          restoredCostReturnsToCompany,
          accountRecovered,
          activationCancelled,
          accountDisposition: nextAccountDisposition,
          accountCostAmountSnapshot: order.accountCostAmount.toString(),
          appliedAccountCostAmount: appliedAccountCostAmount.toString(),
          appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
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

export async function restoreRecoveredCustomerOwnedSourceOrderCost(
  support: IdBusinessV2OrderLifecycleSupport,
  repository: IdBusinessV2OrdersRepository,
  tx: V2CommandTransaction,
  order: IdBusinessV2OrderRecord,
  sourceOrder: IdBusinessV2OrderRecord | null,
  restoredCost: Amount4,
  reason: string,
  operator?: AuthenticatedUser
) {
  if (!order.sourceSoldOrderId || !order.accountId || !sourceOrder) {
    throw new ConflictException('客户已购 ID 订单缺少来源销售记录，不能恢复余额成本');
  }
  if (
    sourceOrder.id !== order.sourceSoldOrderId ||
    sourceOrder.accountId !== order.accountId ||
    sourceOrder.customerId !== order.customerId ||
    sourceOrder.accountDisposition !== 'recovered' ||
    (sourceOrder.status !== 'completed' && sourceOrder.status !== 'refunded')
  ) {
    throw new ConflictException('来源销售订单的 ID 收回证据不一致，请先核对财务记录');
  }
  const remainingTransferredCost = sourceOrder.appliedBalanceCostAmount.sub(
    sourceOrder.balanceCostAmount
  );
  if (remainingTransferredCost.isNegative() || restoredCost.gt(remainingTransferredCost)) {
    if (remainingTransferredCost.isNegative()) {
      throw new ConflictException('来源销售订单的未收回余额成本异常，请先核对财务记录');
    }
  }
  const sourceOrderCost = restoredCost.gt(remainingTransferredCost)
    ? remainingTransferredCost
    : restoredCost;
  if (sourceOrderCost.isZero()) return { id: sourceOrder.id, costAmount: sourceOrderCost };
  const appliedBalanceCostAmount = sourceOrder.appliedBalanceCostAmount.sub(sourceOrderCost);
  const profitAmount = support.calculateProfit(
    sourceOrder.status === 'refunded' ? Amount4.zero() : sourceOrder.receivedAmount,
    sourceOrder.platformFeeAmount,
    sourceOrder.appliedAccountCostAmount,
    appliedBalanceCostAmount,
    sourceOrder.refundCostAmount
  );
  await repository.updateOrder(tx, sourceOrder.id, {
    appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
    profitAmount: profitAmount.toString(),
    updatedByUserId: operator?.id
  });
  await repository.appendAudit(tx, {
    userId: operator?.id,
    module: 'id_business_v2',
    action: 'id_business_v2.order.restore_recovered_balance_cost',
    objectType: 'id_business_v2_order',
    objectId: sourceOrder.id,
    beforeData: {
      appliedBalanceCostAmount: sourceOrder.appliedBalanceCostAmount.toString(),
      profitAmount: sourceOrder.profitAmount?.toString() ?? null
    },
    afterData: {
      appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
      profitAmount: profitAmount.toString(),
      restoredBalanceCostAmount: sourceOrderCost.toString(),
      restoredByOrderId: order.id,
      reason
    },
    remark: `后续订单退款恢复已收回 ID 余额成本：${order.orderNo}`
  });
  return { id: sourceOrder.id, costAmount: sourceOrderCost };
}

function appendRefundRemark(existingRemark: string | null, reason: string) {
  const refundRemark = `订单全额退款并取消开通：${reason}`;
  return existingRemark ? `${existingRemark}\n${refundRemark}` : refundRemark;
}

function normalizeBalanceRefundRequest(
  support: IdBusinessV2OrderLifecycleSupport,
  dto: RefundIdBusinessV2OrderDto
) {
  if (dto.balanceRefundMode !== undefined && dto.restoreBalance !== undefined) {
    throw new BadRequestException('余额退款方式与旧版恢复余额参数不能同时提交');
  }
  const legacyRestoreBalance = normalizeLifecycleBoolean(dto.restoreBalance, '是否恢复余额');
  const mode = dto.balanceRefundMode ?? (legacyRestoreBalance ? 'full' : 'none');
  if (mode !== 'none' && mode !== 'full' && mode !== 'custom') {
    throw new BadRequestException('ID 余额退款方式无效');
  }
  if (mode !== 'custom') {
    if (dto.customRefundBalanceAmount !== undefined) {
      throw new BadRequestException('仅自定义退款到 ID 余额时可以填写退回金额');
    }
    return { mode, customAmount: null };
  }
  return {
    mode,
    customAmount: support.normalizeAmount(
      dto.customRefundBalanceAmount,
      '自定义退回 ID 余额',
      false
    )
  };
}

function resolveRequestedBalanceAmount(
  request: { mode: IdBusinessV2OrderBalanceRefundMode; customAmount: Amount4 | null },
  consumedBalanceAmount: Amount4
) {
  if (request.mode === 'none') return Amount4.zero();
  if (request.mode === 'full') return consumedBalanceAmount;
  if (!request.customAmount) {
    throw new BadRequestException('自定义退回 ID 余额不能为空');
  }
  if (request.customAmount.gt(consumedBalanceAmount)) {
    throw new BadRequestException('退回 ID 余额不能超过本单尚未退回的余额');
  }
  return request.customAmount;
}

function resolveRemainingRefundableBalanceAmount(
  consumedBalanceAmount: Amount4,
  priorReturnedBalanceAmount: Amount4
) {
  if (priorReturnedBalanceAmount.gt(consumedBalanceAmount)) {
    throw new ConflictException('升级退币金额超过订单原消费余额，请先核对财务记录');
  }
  return consumedBalanceAmount.sub(priorReturnedBalanceAmount);
}

function resolveRequestedBalanceCostAmount(
  requestedBalanceAmount: Amount4,
  remainingBalanceAmount: Amount4,
  remainingCostAmount: Amount4
) {
  if (requestedBalanceAmount.isZero()) return Amount4.zero();
  if (remainingBalanceAmount.isZero()) {
    throw new ConflictException('订单没有尚未退回的 ID 余额');
  }
  return requestedBalanceAmount.equals(remainingBalanceAmount)
    ? remainingCostAmount
    : remainingCostAmount.ratio(remainingBalanceAmount).apply(requestedBalanceAmount);
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
    | 'accountSource'
    | 'appliedBalanceCostAmount'
    | 'appliedAccountCostAmount'
    | 'status'
  >,
  refundCostAmount: Amount4,
  restoredBalanceCostAmount: Amount4,
  accountRecovered: boolean,
  recoveredCustomerOwnedBalanceCostAmount: Amount4,
  restoredAppliedBalanceCost: Amount4,
  restoredCustomerOwnedBalanceCost: Amount4
) {
  const completed = order.status === 'completed';
  const receivedOriginalAmount = order.receivedOriginalAmount;
  const receivedAmount = order.receivedAmount;
  const receivedFxRateToCny = order.receivedFxRateToCny;
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
  if (!restoredAppliedBalanceCost.isZero()) {
    lines.push(
      {
        accountCode: 'gift_card_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: restoredAppliedBalanceCost,
        fxRateToCny: 1,
        amountCny: restoredAppliedBalanceCost,
        memo: '退款恢复礼品卡余额资产'
      },
      {
        accountCode: 'gift_card_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: restoredAppliedBalanceCost,
        fxRateToCny: 1,
        amountCny: restoredAppliedBalanceCost,
        memo: '冲回礼品卡销售成本'
      }
    );
  }
  if (!restoredCustomerOwnedBalanceCost.isZero()) {
    lines.push(
      {
        accountCode: 'gift_card_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: restoredCustomerOwnedBalanceCost,
        fxRateToCny: 1,
        amountCny: restoredCustomerOwnedBalanceCost,
        memo: '退款恢复已收回 ID 的余额资产'
      },
      {
        accountCode: 'customer_owned_balance_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: restoredCustomerOwnedBalanceCost,
        fxRateToCny: 1,
        amountCny: restoredCustomerOwnedBalanceCost,
        memo: '冲回原客户已购 ID 余额成本'
      }
    );
  }
  if (accountRecovered && !recoveredCustomerOwnedBalanceCostAmount.isZero()) {
    lines.push(
      {
        accountCode: 'gift_card_inventory' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: recoveredCustomerOwnedBalanceCostAmount,
        fxRateToCny: 1,
        amountCny: recoveredCustomerOwnedBalanceCostAmount,
        memo: '收回客户已购 ID 当前剩余余额成本'
      },
      {
        accountCode: 'customer_owned_balance_cost' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: recoveredCustomerOwnedBalanceCostAmount,
        fxRateToCny: 1,
        amountCny: recoveredCustomerOwnedBalanceCostAmount,
        memo: '冲回客户已购 ID 余额转移成本'
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
