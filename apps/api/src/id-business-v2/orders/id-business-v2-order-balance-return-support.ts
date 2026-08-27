import { BadRequestException, ConflictException } from '@nestjs/common';
import { Amount4, V2_DECIMAL_PATTERN, V2_DECIMAL_PLACES } from '../runtime/public-api';
import type {
  IdBusinessV2OrderBalanceReturnRecord,
  IdBusinessV2OrderListRecord
} from './id-business-v2-order.types';

const MAX_AMOUNT = Amount4.from('99999999999999.9999');

export function normalizeUpgradeBalanceReturnAmount(value: unknown) {
  const normalized =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!V2_DECIMAL_PATTERN.test(normalized)) {
    throw new BadRequestException(`升级退回余额必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数`);
  }
  const amount = Amount4.from(normalized);
  if (amount.lte(0)) throw new BadRequestException('升级退回余额必须大于 0');
  if (amount.gt(MAX_AMOUNT)) throw new BadRequestException('升级退回余额数值过大');
  return amount;
}

export function calculateUpgradeBalanceReturnCost(
  consumedBalanceAmount: Amount4,
  consumedCostAmount: Amount4,
  returnedBalanceAmount: Amount4
) {
  if (consumedBalanceAmount.lte(0)) throw new ConflictException('订单原消费余额无效');
  return returnedBalanceAmount.equals(consumedBalanceAmount)
    ? consumedCostAmount
    : consumedCostAmount.ratio(consumedBalanceAmount).apply(returnedBalanceAmount);
}

export function calculateOrderProfit(
  receivedAmount: Amount4,
  platformFeeAmount: Amount4,
  accountCostAmount: Amount4,
  balanceCostAmount: Amount4,
  refundCostAmount: Amount4 | null
) {
  const profit = receivedAmount
    .sub(platformFeeAmount)
    .sub(accountCostAmount)
    .sub(balanceCostAmount)
    .sub(refundCostAmount ?? 0);
  if (profit.abs().gt(MAX_AMOUNT)) throw new BadRequestException('订单利润数值超出数据库范围');
  return profit;
}

export function resolveOrderBalanceCurrencyCode(
  orderCurrencyCode: string | null,
  accountCurrencyCode: string | null
) {
  const currencyCode = (orderCurrencyCode ?? accountCurrencyCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new ConflictException('订单原 ID 余额币种缺失或无效，请先核对国家设置');
  }
  return currencyCode;
}

export function minAmount(left: Amount4, right: Amount4) {
  return left.lte(right) ? left : right;
}

export function appendUpgradeBalanceReturnActivationRemark(
  existingRemark: string | null,
  balanceReturnId: string,
  reason: string
) {
  const normalizedReason = reason.replace(/\s+/g, ' ').trim();
  const remark = `${upgradeBalanceReturnActivationMarker(balanceReturnId)}：${normalizedReason}`;
  return existingRemark ? `${existingRemark}\n${remark}` : remark;
}

export function removeUpgradeBalanceReturnActivationRemark(
  existingRemark: string | null,
  balanceReturnId: string
) {
  if (!existingRemark) return { matched: false, remark: existingRemark };
  const lines = existingRemark.split('\n');
  const marker = upgradeBalanceReturnActivationMarker(balanceReturnId);
  if (!lines.at(-1)?.startsWith(`${marker}：`)) {
    return { matched: false, remark: existingRemark };
  }
  lines.pop();
  return { matched: true, remark: lines.length > 0 ? lines.join('\n') : null };
}

function upgradeBalanceReturnActivationMarker(balanceReturnId: string) {
  return `升级退币结束原开通（退币记录 ${balanceReturnId}）`;
}

export function buildUpgradeBalanceReturnPreview(
  order: IdBusinessV2OrderListRecord,
  returnedBalanceAmount: Amount4
) {
  if (returnedBalanceAmount.gt(order.balanceAmount)) {
    throw new BadRequestException('升级退回余额不能超过本单原消费余额');
  }
  const restoredBalanceCostAmount = calculateUpgradeBalanceReturnCost(
    order.balanceAmount,
    order.balanceCostAmount,
    returnedBalanceAmount
  );
  const costReturnsToCompany =
    order.accountSource === 'inventory' &&
    order.account !== null &&
    order.accountDisposition !== 'sold';
  const restoredAppliedBalanceCostAmount = costReturnsToCompany
    ? minAmount(restoredBalanceCostAmount, order.appliedBalanceCostAmount)
    : Amount4.zero();
  const adjustedProfitAmount = calculateOrderProfit(
    order.receivedAmount,
    order.platformFeeAmount,
    order.appliedAccountCostAmount,
    order.appliedBalanceCostAmount.sub(restoredAppliedBalanceCostAmount),
    order.refundCostAmount
  );
  return {
    orderId: order.id,
    orderNo: order.orderNo,
    currencyCode: resolveOrderBalanceCurrencyCode(
      order.balanceCurrencyCode,
      order.account?.countryOption.currencyCode ?? null
    ),
    maximumReturnedBalanceAmount: order.balanceAmount.toString(),
    returnedBalanceAmount: returnedBalanceAmount.toString(),
    restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
    restoredAppliedBalanceCostAmount: restoredAppliedBalanceCostAmount.toString(),
    originalProfitAmount: order.profitAmount!.toString(),
    adjustedProfitAmount: adjustedProfitAmount.toString(),
    profitIncreaseAmount: adjustedProfitAmount.sub(order.profitAmount!).toString(),
    costReturnsToCompany,
    revenueChanged: false as const
  };
}

export function assertOrderCanRecordUpgradeBalanceReturn(order: IdBusinessV2OrderListRecord) {
  if (order.status !== 'completed') {
    throw new ConflictException('只有已完成订单可以登记升级退币');
  }
  if (!order.accountId || !order.account) {
    throw new ConflictException('订单没有绑定 ID，不能登记升级退币');
  }
  if (order.profitAmount === null) {
    throw new ConflictException('订单缺少利润快照，不能登记升级退币');
  }
  if (order.balanceAmount.lte(0)) {
    throw new ConflictException('订单没有可登记退回的原消费余额');
  }
  if (order.balanceReturns[0]?.status === 'active') {
    throw new ConflictException('订单已有生效中的升级退币记录，请先撤销原记录');
  }
}

export function assertUpgradeBalanceReturnReplay(
  saved: IdBusinessV2OrderBalanceReturnRecord,
  orderId: string,
  returnedBalanceAmount: Amount4,
  reason: string
) {
  if (
    saved.orderId !== orderId ||
    !saved.returnedBalanceAmount.equals(returnedBalanceAmount) ||
    saved.reason !== reason
  ) {
    throw new ConflictException('幂等键已用于其他升级退币内容');
  }
}

export function assertUpgradeBalanceReturnReversalReplay(
  saved: IdBusinessV2OrderBalanceReturnRecord,
  orderId: string,
  reason: string
) {
  if (saved.orderId !== orderId || saved.status !== 'reversed' || saved.reversalReason !== reason) {
    throw new ConflictException('幂等键已用于其他升级退币撤销内容');
  }
}

export function toUpgradeBalanceReturnResponse(record: IdBusinessV2OrderBalanceReturnRecord) {
  return {
    id: record.id,
    orderId: record.orderId,
    accountId: record.accountId,
    status: record.status,
    currencyCode: record.currencyCode,
    returnedBalanceAmount: record.returnedBalanceAmount.toString(),
    restoredBalanceCostAmount: record.restoredBalanceCostAmount.toString(),
    restoredAppliedBalanceCostAmount: record.restoredAppliedBalanceCostAmount.toString(),
    originalProfitAmount: record.originalProfitAmount.toString(),
    adjustedProfitAmount: record.adjustedProfitAmount.toString(),
    reason: record.reason,
    createdAt: record.createdAt,
    reversalReason: record.reversalReason,
    reversedAt: record.reversedAt
  };
}
