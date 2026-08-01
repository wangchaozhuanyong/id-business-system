import { BadRequestException } from '@nestjs/common';
import type { IdBusinessV2BalanceLedgerRecord } from './id-business-v2-order.types';

export function normalizeLifecycleBoolean(value: unknown, label: string) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new BadRequestException(`${label}格式无效`);
  }
  return value;
}

export function buildOrderReversalIdempotencyKey(orderId: string, value: string) {
  return `order_reversal:${orderId}:${value}`;
}

export function toOrderReversalLedgerResponse(entry: IdBusinessV2BalanceLedgerRecord) {
  return {
    id: entry.id,
    accountId: entry.accountId,
    entryType: entry.entryType,
    direction: entry.direction,
    balanceAmount: entry.balanceAmount.toString(),
    costAmount: entry.costAmount.toString(),
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    costBefore: entry.costBefore.toString(),
    costAfter: entry.costAfter.toString(),
    averageCostBefore: entry.averageCostBefore.toString(),
    averageCostAfter: entry.averageCostAfter.toString(),
    reversalOfEntryId: entry.reversalOfEntryId,
    createdAt: entry.createdAt
  };
}
