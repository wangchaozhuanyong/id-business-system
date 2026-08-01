import { BadRequestException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { Amount4, Rate8 } from '../runtime/public-api';
import { normalizeFinanceDate } from './id-business-v2-finance-input';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';

export interface SettlementPlatformReportQuery {
  dateFrom?: string;
  dateTo?: string;
  currency?: string;
  settlementPlatformOptionId?: string;
}

const ORDER_REPORT_EXPENSE_CODES = [
  'platform_fee',
  'gift_card_cost',
  'id_cost',
  'refund_loss'
] as const;
const REPORT_CURRENCIES = ['CNY', 'MYR', 'USDT'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SettlementReportBucket {
  settlementPlatform: {
    id: string;
    name: string;
  } | null;
  completionCountByOrder: Map<string, number>;
  originalAmounts: Map<
    IdBusinessV2FinanceCurrency,
    {
      grossReceived: Amount4;
      refunded: Amount4;
    }
  >;
  grossReceivedCny: Amount4;
  refundedCny: Amount4;
  platformFeeCny: Amount4;
  realizedProfitCny: Amount4;
  pendingOrderCount: number;
  pendingReceivedCny: Amount4;
  pendingProfitCny: Amount4;
}

export async function getIdBusinessV2SettlementPlatformReport(
  repository: IdBusinessV2FinanceReportRepository,
  query: SettlementPlatformReportQuery
) {
  const settlementPlatformOptionId = normalizeOptionalUuid(
    query.settlementPlatformOptionId,
    '结算平台'
  );
  const { options, orders, journals } = await repository.loadSettlementReport({
    settlementPlatformOptionId: settlementPlatformOptionId ?? undefined,
    currency: query.currency
      ? (query.currency.toUpperCase() as IdBusinessV2FinanceCurrency)
      : undefined,
    occurredAt: parseOccurredAt(query.dateFrom, query.dateTo)
  });

  const buckets = new Map<string, SettlementReportBucket>();
  const getBucket = (platform: { id: string; name: string } | null) => {
    const key = platform?.id ?? '__historical_unspecified__';
    const existing = buckets.get(key);
    if (existing) return existing;
    const bucket = createSettlementReportBucket(platform);
    buckets.set(key, bucket);
    return bucket;
  };

  for (const option of options) {
    if (!settlementPlatformOptionId || option.id === settlementPlatformOptionId) {
      getBucket(option);
    }
  }
  const orderById = new Map(orders.map((order) => [order.id, order]));
  for (const order of orders) {
    const bucket = getBucket(order.settlementPlatform);
    if (['pending', 'waiting_external', 'processing'].includes(order.status)) {
      bucket.pendingOrderCount += 1;
      bucket.pendingReceivedCny = bucket.pendingReceivedCny.add(order.receivedAmount);
      bucket.pendingProfitCny = bucket.pendingProfitCny.add(order.profitAmount);
    }
  }

  for (const journal of journals) {
    const originalJournalType =
      journal.journalType === 'reversal' ? journal.reversalOf?.journalType : journal.journalType;
    const orderId =
      journal.journalType === 'reversal' ? journal.reversalOf?.sourceId : journal.sourceId;
    if (
      !orderId ||
      (originalJournalType !== 'order_completed' && originalJournalType !== 'order_refund')
    ) {
      continue;
    }
    const order = orderById.get(orderId);
    if (!order) continue;
    const bucket = getBucket(order.settlementPlatform);

    if (originalJournalType === 'order_completed') {
      const current = bucket.completionCountByOrder.get(orderId) ?? 0;
      bucket.completionCountByOrder.set(
        orderId,
        current + (journal.journalType === 'reversal' ? -1 : 1)
      );
    }

    for (const line of journal.lines) {
      const amountCny = line.amountCny;
      const amountOriginal = line.amountOriginal;
      if (line.accountCode === 'sales_revenue') {
        if (originalJournalType === 'order_completed') {
          const sign = line.direction === 'credit' ? 1 : -1;
          bucket.grossReceivedCny = bucket.grossReceivedCny.add(amountCny.mul(sign));
          const currency = getSettlementOriginalAmount(bucket, line.currency);
          currency.grossReceived = currency.grossReceived.add(amountOriginal.mul(sign));
        } else {
          const sign = line.direction === 'debit' ? 1 : -1;
          bucket.refundedCny = bucket.refundedCny.add(amountCny.mul(sign));
          const currency = getSettlementOriginalAmount(bucket, line.currency);
          currency.refunded = currency.refunded.add(amountOriginal.mul(sign));
        }
      }

      if (line.accountCode === 'platform_fee') {
        bucket.platformFeeCny = bucket.platformFeeCny.add(
          line.direction === 'debit' ? amountCny : amountCny.negated()
        );
      }

      if (line.accountCode === 'sales_revenue') {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'credit' ? amountCny : amountCny.negated()
        );
      } else if (
        ORDER_REPORT_EXPENSE_CODES.includes(
          line.accountCode as (typeof ORDER_REPORT_EXPENSE_CODES)[number]
        )
      ) {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'debit' ? amountCny.negated() : amountCny
        );
      } else if (line.accountCode === 'realized_fx_gain_loss') {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'credit' ? amountCny : amountCny.negated()
        );
      }
    }
  }

  const rows = [...buckets.values()].map(toSettlementReportRow).sort((left, right) => {
    if (left.settlementPlatform === null) return 1;
    if (right.settlementPlatform === null) return -1;
    const amountOrder = Amount4.from(right.grossReceivedCny).compare(left.grossReceivedCny);
    return amountOrder || left.settlementPlatform.name.localeCompare(right.settlementPlatform.name);
  });
  const totalsBucket = createSettlementReportBucket(null);
  for (const bucket of buckets.values()) {
    mergeSettlementReportBucket(totalsBucket, bucket);
  }
  const totals = toSettlementReportRow(totalsBucket);
  const historical = rows.find((row) => row.settlementPlatform === null);

  return {
    options,
    totals: {
      completedOrderCount: totals.completedOrderCount,
      originalAmounts: totals.originalAmounts,
      grossReceivedCny: totals.grossReceivedCny,
      refundedCny: totals.refundedCny,
      platformFeeCny: totals.platformFeeCny,
      netSettlementCny: totals.netSettlementCny,
      realizedProfitCny: totals.realizedProfitCny,
      realizedProfitRate: totals.realizedProfitRate,
      pendingOrderCount: totals.pendingOrderCount,
      pendingReceivedCny: totals.pendingReceivedCny,
      pendingProfitCny: totals.pendingProfitCny
    },
    rows,
    hasHistoricalUnspecified: Boolean(historical),
    historicalUnspecifiedAmountCny: historical?.grossReceivedCny ?? '0'
  };
}

function createSettlementReportBucket(
  settlementPlatform: { id: string; name: string } | null
): SettlementReportBucket {
  return {
    settlementPlatform,
    completionCountByOrder: new Map(),
    originalAmounts: new Map(),
    grossReceivedCny: Amount4.zero(),
    refundedCny: Amount4.zero(),
    platformFeeCny: Amount4.zero(),
    realizedProfitCny: Amount4.zero(),
    pendingOrderCount: 0,
    pendingReceivedCny: Amount4.zero(),
    pendingProfitCny: Amount4.zero()
  };
}

function getSettlementOriginalAmount(
  bucket: SettlementReportBucket,
  currency: IdBusinessV2FinanceCurrency
) {
  const existing = bucket.originalAmounts.get(currency);
  if (existing) return existing;
  const value = {
    grossReceived: Amount4.zero(),
    refunded: Amount4.zero()
  };
  bucket.originalAmounts.set(currency, value);
  return value;
}

function mergeSettlementReportBucket(
  target: SettlementReportBucket,
  source: SettlementReportBucket
) {
  for (const [orderId, count] of source.completionCountByOrder) {
    target.completionCountByOrder.set(
      orderId,
      (target.completionCountByOrder.get(orderId) ?? 0) + count
    );
  }
  for (const currency of REPORT_CURRENCIES) {
    const sourceAmount = source.originalAmounts.get(currency);
    if (!sourceAmount) continue;
    const targetAmount = getSettlementOriginalAmount(target, currency);
    targetAmount.grossReceived = targetAmount.grossReceived.add(sourceAmount.grossReceived);
    targetAmount.refunded = targetAmount.refunded.add(sourceAmount.refunded);
  }
  target.grossReceivedCny = target.grossReceivedCny.add(source.grossReceivedCny);
  target.refundedCny = target.refundedCny.add(source.refundedCny);
  target.platformFeeCny = target.platformFeeCny.add(source.platformFeeCny);
  target.realizedProfitCny = target.realizedProfitCny.add(source.realizedProfitCny);
  target.pendingOrderCount += source.pendingOrderCount;
  target.pendingReceivedCny = target.pendingReceivedCny.add(source.pendingReceivedCny);
  target.pendingProfitCny = target.pendingProfitCny.add(source.pendingProfitCny);
}

function toSettlementReportRow(bucket: SettlementReportBucket) {
  const receivedAfterRefund = bucket.grossReceivedCny.sub(bucket.refundedCny);
  const netSettlement = receivedAfterRefund.sub(bucket.platformFeeCny);
  const realizedProfitRate = receivedAfterRefund.gt(0)
    ? Rate8.from(bucket.realizedProfitCny.ratio(receivedAfterRefund).mul(100))
    : null;
  return {
    settlementPlatform: bucket.settlementPlatform,
    completedOrderCount: [...bucket.completionCountByOrder.values()].filter((count) => count > 0)
      .length,
    originalAmounts: REPORT_CURRENCIES.map((currency) => {
      const amount = bucket.originalAmounts.get(currency);
      return {
        currency,
        grossReceived: (amount?.grossReceived ?? Amount4.zero()).toString(),
        refunded: (amount?.refunded ?? Amount4.zero()).toString()
      };
    }),
    grossReceivedCny: bucket.grossReceivedCny.toString(),
    refundedCny: bucket.refundedCny.toString(),
    platformFeeCny: bucket.platformFeeCny.toString(),
    netSettlementCny: netSettlement.toString(),
    realizedProfitCny: bucket.realizedProfitCny.toString(),
    realizedProfitRate: realizedProfitRate?.toString() ?? null,
    pendingOrderCount: bucket.pendingOrderCount,
    pendingReceivedCny: bucket.pendingReceivedCny.toString(),
    pendingProfitCny: bucket.pendingProfitCny.toString()
  };
}

function normalizeOptionalUuid(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return normalized;
}

function parseOccurredAt(from?: string, to?: string) {
  if (!from && !to) return undefined;
  return {
    gte: from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined,
    lte: to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined
  };
}
