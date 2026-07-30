import { BadRequestException } from '@nestjs/common';
import { IdBusinessV2FinanceCurrency, Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2Decimal, toV2DecimalString } from '../decimal-policy';
import { normalizeFinanceDate } from './id-business-v2-finance-input';

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
      grossReceived: PrismaNamespace.Decimal;
      refunded: PrismaNamespace.Decimal;
    }
  >;
  grossReceivedCny: PrismaNamespace.Decimal;
  refundedCny: PrismaNamespace.Decimal;
  platformFeeCny: PrismaNamespace.Decimal;
  realizedProfitCny: PrismaNamespace.Decimal;
  pendingOrderCount: number;
  pendingReceivedCny: PrismaNamespace.Decimal;
  pendingProfitCny: PrismaNamespace.Decimal;
}

export async function getIdBusinessV2SettlementPlatformReport(
  prisma: PrismaService,
  query: SettlementPlatformReportQuery
) {
  const settlementPlatformOptionId = normalizeOptionalUuid(
    query.settlementPlatformOptionId,
    '结算平台'
  );
  const [options, orders] = await Promise.all([
    prisma.idBusinessV2Option.findMany({
      where: {
        type: 'settlement_platform',
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        name: true
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
    }),
    prisma.idBusinessV2Order.findMany({
      where: {
        settlementPlatformOptionId: settlementPlatformOptionId ?? undefined,
        receivedCurrency: query.currency
          ? (query.currency.toUpperCase() as IdBusinessV2FinanceCurrency)
          : undefined,
        createdAt: parseOccurredAt(query.dateFrom, query.dateTo)
      },
      select: {
        id: true,
        status: true,
        settlementPlatformOptionId: true,
        settlementPlatform: {
          select: {
            id: true,
            name: true
          }
        },
        receivedAmount: true,
        profitAmount: true
      }
    })
  ]);

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
      bucket.pendingReceivedCny = bucket.pendingReceivedCny.add(toV2Decimal(order.receivedAmount));
      bucket.pendingProfitCny = bucket.pendingProfitCny.add(toV2Decimal(order.profitAmount ?? 0));
    }
  }

  const orderIds = orders.map((order) => order.id);
  const journals = orderIds.length
    ? await prisma.idBusinessV2FinanceJournal.findMany({
        where: {
          OR: [
            {
              sourceType: 'order',
              sourceId: { in: orderIds },
              journalType: { in: ['order_completed', 'order_refund'] }
            },
            {
              journalType: 'reversal',
              reversalOf: {
                is: {
                  sourceType: 'order',
                  sourceId: { in: orderIds },
                  journalType: { in: ['order_completed', 'order_refund'] }
                }
              }
            }
          ]
        },
        include: {
          lines: true,
          reversalOf: {
            select: {
              sourceId: true,
              journalType: true
            }
          }
        }
      })
    : [];

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
      const amountCny = toV2Decimal(line.amountCny);
      const amountOriginal = toV2Decimal(line.amountOriginal);
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
          line.direction === 'debit' ? amountCny : amountCny.neg()
        );
      }

      if (line.accountCode === 'sales_revenue') {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'credit' ? amountCny : amountCny.neg()
        );
      } else if (
        ORDER_REPORT_EXPENSE_CODES.includes(
          line.accountCode as (typeof ORDER_REPORT_EXPENSE_CODES)[number]
        )
      ) {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'debit' ? amountCny.neg() : amountCny
        );
      } else if (line.accountCode === 'realized_fx_gain_loss') {
        bucket.realizedProfitCny = bucket.realizedProfitCny.add(
          line.direction === 'credit' ? amountCny : amountCny.neg()
        );
      }
    }
  }

  const rows = [...buckets.values()].map(toSettlementReportRow).sort((left, right) => {
    if (left.settlementPlatform === null) return 1;
    if (right.settlementPlatform === null) return -1;
    const amountOrder = new PrismaNamespace.Decimal(right.grossReceivedCny).cmp(
      left.grossReceivedCny
    );
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
    grossReceivedCny: new PrismaNamespace.Decimal(0),
    refundedCny: new PrismaNamespace.Decimal(0),
    platformFeeCny: new PrismaNamespace.Decimal(0),
    realizedProfitCny: new PrismaNamespace.Decimal(0),
    pendingOrderCount: 0,
    pendingReceivedCny: new PrismaNamespace.Decimal(0),
    pendingProfitCny: new PrismaNamespace.Decimal(0)
  };
}

function getSettlementOriginalAmount(
  bucket: SettlementReportBucket,
  currency: IdBusinessV2FinanceCurrency
) {
  const existing = bucket.originalAmounts.get(currency);
  if (existing) return existing;
  const value = {
    grossReceived: new PrismaNamespace.Decimal(0),
    refunded: new PrismaNamespace.Decimal(0)
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
  const receivedAfterRefund = roundV2Decimal(bucket.grossReceivedCny.sub(bucket.refundedCny));
  const netSettlement = roundV2Decimal(receivedAfterRefund.sub(bucket.platformFeeCny));
  const realizedProfitRate = receivedAfterRefund.greaterThan(0)
    ? roundV2Decimal(bucket.realizedProfitCny.div(receivedAfterRefund).mul(100))
    : null;
  return {
    settlementPlatform: bucket.settlementPlatform,
    completedOrderCount: [...bucket.completionCountByOrder.values()].filter((count) => count > 0)
      .length,
    originalAmounts: REPORT_CURRENCIES.map((currency) => {
      const amount = bucket.originalAmounts.get(currency);
      return {
        currency,
        grossReceived: toV2DecimalString(amount?.grossReceived ?? 0),
        refunded: toV2DecimalString(amount?.refunded ?? 0)
      };
    }),
    grossReceivedCny: toV2DecimalString(bucket.grossReceivedCny),
    refundedCny: toV2DecimalString(bucket.refundedCny),
    platformFeeCny: toV2DecimalString(bucket.platformFeeCny),
    netSettlementCny: toV2DecimalString(netSettlement),
    realizedProfitCny: toV2DecimalString(bucket.realizedProfitCny),
    realizedProfitRate: realizedProfitRate === null ? null : toV2DecimalString(realizedProfitRate),
    pendingOrderCount: bucket.pendingOrderCount,
    pendingReceivedCny: toV2DecimalString(bucket.pendingReceivedCny),
    pendingProfitCny: toV2DecimalString(bucket.pendingProfitCny)
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

function parseOccurredAt(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return {
    gte: from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined,
    lte: to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined
  };
}
