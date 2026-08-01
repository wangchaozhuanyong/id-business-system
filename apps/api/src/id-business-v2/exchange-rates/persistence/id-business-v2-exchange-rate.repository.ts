import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  mapAmount4,
  mapOptionalAmount4,
  mapOptionalRate8,
  mapRate8,
  type V2CommandTransaction
} from '../../runtime/public-api';

export const EXCHANGE_RATE_ENTRY_INCLUDE = {
  createdBy: { select: { id: true, username: true, displayName: true } }
} satisfies Prisma.IdBusinessV2ExchangeRateEntryInclude;

export const EXCHANGE_RATE_RUN_INCLUDE = {
  triggeredBy: { select: { id: true, username: true, displayName: true } },
  snapshot: {
    include: {
      providerSnapshots: {
        select: { provider: true, side: true, validAdCount: true, averageRateToRmb: true }
      }
    }
  }
} satisfies Prisma.IdBusinessV2ExchangeRateRunInclude;

const EXCHANGE_RATE_RUN_DETAIL_INCLUDE = {
  triggeredBy: { select: { id: true, username: true, displayName: true } },
  snapshot: {
    include: {
      providerSnapshots: {
        include: {
          validSamples: { orderBy: [{ priceToRmb: 'asc' }, { sourceAdId: 'asc' }] }
        },
        orderBy: [{ provider: 'asc' }, { side: 'asc' }]
      }
    }
  }
} satisfies Prisma.IdBusinessV2ExchangeRateRunInclude;

type ExchangeRateEntryRow = Prisma.IdBusinessV2ExchangeRateEntryGetPayload<{
  include: typeof EXCHANGE_RATE_ENTRY_INCLUDE;
}>;

type ExchangeRateRunRow = Prisma.IdBusinessV2ExchangeRateRunGetPayload<{
  include: typeof EXCHANGE_RATE_RUN_INCLUDE;
}>;

type ExchangeRateRunDetailRow = Prisma.IdBusinessV2ExchangeRateRunGetPayload<{
  include: typeof EXCHANGE_RATE_RUN_DETAIL_INCLUDE;
}>;

@Injectable()
export class IdBusinessV2ExchangeRateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listEntries(input: {
    keyword?: string;
    keywordIsUuid: boolean;
    recordedAt?: { gte?: Date; lte?: Date };
    skip: number;
    take: number;
    sortBy: 'recordedAt' | 'createdAt';
    sortOrder: 'asc' | 'desc';
  }) {
    const where: Prisma.IdBusinessV2ExchangeRateEntryWhereInput = {
      recordedAt: input.recordedAt,
      OR: input.keyword
        ? [
            ...(input.keywordIsUuid ? [{ id: input.keyword }] : []),
            { remark: { contains: input.keyword, mode: 'insensitive' } },
            { createdBy: { is: { username: { contains: input.keyword, mode: 'insensitive' } } } },
            { createdBy: { is: { displayName: { contains: input.keyword, mode: 'insensitive' } } } }
          ]
        : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateEntry.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ [input.sortBy]: input.sortOrder }, { id: input.sortOrder }],
        include: EXCHANGE_RATE_ENTRY_INCLUDE
      }),
      this.prisma.idBusinessV2ExchangeRateEntry.count({ where })
    ]);
    return [rows.map(mapExchangeRateEntry), total] as const;
  }

  async findLatestEntry() {
    const row = await this.prisma.idBusinessV2ExchangeRateEntry.findFirst({
      include: EXCHANGE_RATE_ENTRY_INCLUDE,
      orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });
    return row ? mapExchangeRateEntry(row) : null;
  }

  countEntries() {
    return this.prisma.idBusinessV2ExchangeRateEntry.count();
  }

  async findEntry(id: string) {
    const row = await this.prisma.idBusinessV2ExchangeRateEntry.findUnique({
      where: { id },
      include: EXCHANGE_RATE_ENTRY_INCLUDE
    });
    return row ? mapExchangeRateEntry(row) : null;
  }

  async createEntry(
    tx: V2CommandTransaction,
    data: {
      binanceMerchantBuyRateToRmb: string;
      binanceMerchantSellRateToRmb: string;
      okxMerchantBuyRateToRmb: string;
      okxMerchantSellRateToRmb: string;
      combinedMerchantBuyAverageRateToRmb: string;
      combinedMerchantSellAverageRateToRmb: string;
      midRateToRmb: string;
      recordedAt: Date;
      remark: string | null;
      createdByUserId: string;
    }
  ) {
    const row = await tx.idBusinessV2ExchangeRateEntry.create({
      data,
      include: EXCHANGE_RATE_ENTRY_INCLUDE
    });
    return mapExchangeRateEntry(row);
  }

  async findSettings() {
    const row = await this.prisma.idBusinessV2ExchangeRateSettings.findUnique({ where: { id: 1 } });
    return row ? mapExchangeRateSettings(row) : null;
  }

  async createDefaultSettings(tx: V2CommandTransaction, now: Date) {
    const row = await tx.idBusinessV2ExchangeRateSettings.create({
      data: {
        id: 1,
        autoEnabled: true,
        intervalMinutes: 30,
        targetAmountRmb: '5000',
        nextRunAt: now
      }
    });
    return mapExchangeRateSettings(row);
  }

  async upsertSettings(
    tx: V2CommandTransaction,
    input: {
      autoEnabled: boolean;
      intervalMinutes: number;
      targetAmountRmb: string;
      nextRunAt: Date | null;
      updatedByUserId: string;
    }
  ) {
    const row = await tx.idBusinessV2ExchangeRateSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...input },
      update: input
    });
    return mapExchangeRateSettings(row);
  }

  async claimDueSchedule(tx: V2CommandTransaction) {
    const rows = await tx.$queryRaw<
      Array<{ targetAmountRmb: Prisma.Decimal; intervalMinutes: number; nextRunAt: Date }>
    >(Prisma.sql`
      UPDATE "id_business_v2_exchange_rate_settings"
      SET
        "next_run_at" = to_timestamp(
          (
            FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) / ("interval_minutes" * 60)) + 1
          ) * ("interval_minutes" * 60)
        ),
        "updated_at" = clock_timestamp()
      WHERE
        "id" = 1
        AND "auto_enabled" = true
        AND "next_run_at" <= clock_timestamp()
      RETURNING
        "target_amount_rmb" AS "targetAmountRmb",
        "interval_minutes" AS "intervalMinutes",
        "next_run_at" AS "nextRunAt"
    `);
    const row = rows[0];
    return row
      ? {
          ...row,
          targetAmountRmb: mapAmount4(
            row.targetAmountRmb,
            'id_business_v2_exchange_rate_settings.target_amount_rmb'
          )
        }
      : null;
  }

  createRun(
    tx: V2CommandTransaction,
    input: {
      triggerType: 'manual' | 'scheduled' | 'system';
      targetAmountRmb: string;
      startedAt: Date;
      triggeredByUserId?: string;
    }
  ) {
    return tx.idBusinessV2ExchangeRateRun.create({
      data: {
        status: 'running',
        triggerType: input.triggerType,
        asset: 'USDT',
        fiat: 'CNY',
        targetAmountRmb: input.targetAmountRmb,
        startedAt: input.startedAt,
        triggeredByUserId: input.triggerType === 'manual' ? input.triggeredByUserId : null
      },
      select: { id: true }
    });
  }

  createSnapshot(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ExchangeRateSnapshotUncheckedCreateInput
  ) {
    return tx.idBusinessV2ExchangeRateSnapshot.create({ data, select: { id: true } });
  }

  createProviderSnapshot(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ExchangeRateProviderSnapshotUncheckedCreateInput
  ) {
    return tx.idBusinessV2ExchangeRateProviderSnapshot.create({ data, select: { id: true } });
  }

  createQuoteSamples(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ExchangeRateQuoteSampleUncheckedCreateInput[]
  ) {
    return tx.idBusinessV2ExchangeRateQuoteSample.createMany({ data });
  }

  updateRunSuccess(
    tx: V2CommandTransaction,
    runId: string,
    data: Omit<Prisma.IdBusinessV2ExchangeRateRunUpdateInput, 'status'>
  ) {
    return tx.idBusinessV2ExchangeRateRun.update({
      where: { id: runId },
      data: { status: 'success', ...data },
      select: { id: true }
    });
  }

  updateRunFailure(
    tx: V2CommandTransaction,
    runId: string,
    data: Omit<Prisma.IdBusinessV2ExchangeRateRunUpdateInput, 'status'>
  ) {
    return tx.idBusinessV2ExchangeRateRun.update({
      where: { id: runId },
      data: { status: 'failed', ...data },
      select: { id: true }
    });
  }

  async listRuns(input: {
    keyword?: string;
    keywordIsUuid: boolean;
    status?: 'running' | 'success' | 'failed';
    triggerType?: 'manual' | 'scheduled' | 'system';
    provider?: 'binance' | 'okx';
    startedAt?: { gte?: Date; lte?: Date };
    skip: number;
    take: number;
    sortOrder: 'asc' | 'desc';
  }) {
    const where: Prisma.IdBusinessV2ExchangeRateRunWhereInput = {
      status: input.status,
      triggerType: input.triggerType,
      startedAt: input.startedAt,
      OR: input.keyword
        ? [
            ...(input.keywordIsUuid ? [{ id: input.keyword }] : []),
            { errorCode: { contains: input.keyword, mode: 'insensitive' } },
            { errorMessage: { contains: input.keyword, mode: 'insensitive' } }
          ]
        : undefined,
      snapshot: input.provider
        ? { is: { providerSnapshots: { some: { provider: input.provider } } } }
        : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateRun.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ startedAt: input.sortOrder }, { id: 'desc' }],
        include: EXCHANGE_RATE_RUN_INCLUDE
      }),
      this.prisma.idBusinessV2ExchangeRateRun.count({ where })
    ]);
    return [rows.map(mapExchangeRateRun), total] as const;
  }

  async findRun(id: string) {
    const row = await this.prisma.idBusinessV2ExchangeRateRun.findUnique({
      where: { id },
      include: EXCHANGE_RATE_RUN_DETAIL_INCLUDE
    });
    return row ? mapExchangeRateRunDetail(row) : null;
  }

  async findLatestRun(status?: 'success') {
    const row = await this.prisma.idBusinessV2ExchangeRateRun.findFirst({
      where: status ? { status } : undefined,
      include: EXCHANGE_RATE_RUN_INCLUDE,
      orderBy: status
        ? [{ finishedAt: 'desc' }, { id: 'desc' }]
        : [{ startedAt: 'desc' }, { id: 'desc' }]
    });
    return row ? mapExchangeRateRun(row) : null;
  }

  async findRunningRun() {
    const row = await this.prisma.idBusinessV2ExchangeRateRun.findFirst({
      where: { status: 'running' },
      select: { id: true, triggerType: true, targetAmountRmb: true, startedAt: true },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }]
    });
    return row
      ? {
          ...row,
          targetAmountRmb: mapOptionalAmount4(
            row.targetAmountRmb,
            'id_business_v2_exchange_rate_runs.target_amount_rmb'
          )
        }
      : null;
  }

  findStaleRuns(staleBefore: Date) {
    return this.prisma.idBusinessV2ExchangeRateRun.findMany({
      where: { status: 'running', startedAt: { lt: staleBefore } },
      select: { id: true, startedAt: true },
      take: 10
    });
  }

  recoverStaleRun(
    tx: V2CommandTransaction,
    run: { id: string; startedAt: Date },
    finishedAt: Date
  ) {
    return tx.idBusinessV2ExchangeRateRun.updateMany({
      where: { id: run.id, status: 'running', startedAt: run.startedAt },
      data: {
        status: 'failed',
        finishedAt,
        errorCode: 'exchange_rate_stale_run_recovered',
        errorMessage: '汇率采集超过运行时限，系统已结束该批次',
        errorProvider: 'system',
        errorRetryable: true,
        errorDetails: { source: 'exchange_rate_scheduler', staleAfterMs: 300_000 }
      }
    });
  }

  async cleanupHistory(tx: V2CommandTransaction) {
    const rows = await tx.$queryRaw<Array<{ result: Prisma.JsonValue }>>(
      Prisma.sql`SELECT "cleanup_id_business_v2_exchange_rate_history"() AS "result"`
    );
    return rows[0]?.result;
  }
}

function mapExchangeRateEntry(row: ExchangeRateEntryRow) {
  return {
    ...row,
    binanceMerchantBuyRateToRmb: mapRate8(
      row.binanceMerchantBuyRateToRmb,
      'id_business_v2_exchange_rate_entries.binance_merchant_buy_rate_to_rmb'
    ),
    binanceMerchantSellRateToRmb: mapRate8(
      row.binanceMerchantSellRateToRmb,
      'id_business_v2_exchange_rate_entries.binance_merchant_sell_rate_to_rmb'
    ),
    okxMerchantBuyRateToRmb: mapRate8(
      row.okxMerchantBuyRateToRmb,
      'id_business_v2_exchange_rate_entries.okx_merchant_buy_rate_to_rmb'
    ),
    okxMerchantSellRateToRmb: mapRate8(
      row.okxMerchantSellRateToRmb,
      'id_business_v2_exchange_rate_entries.okx_merchant_sell_rate_to_rmb'
    ),
    combinedMerchantBuyAverageRateToRmb: mapRate8(
      row.combinedMerchantBuyAverageRateToRmb,
      'id_business_v2_exchange_rate_entries.combined_merchant_buy_average_rate_to_rmb'
    ),
    combinedMerchantSellAverageRateToRmb: mapRate8(
      row.combinedMerchantSellAverageRateToRmb,
      'id_business_v2_exchange_rate_entries.combined_merchant_sell_average_rate_to_rmb'
    ),
    midRateToRmb: mapRate8(row.midRateToRmb, 'id_business_v2_exchange_rate_entries.mid_rate_to_rmb')
  };
}

function mapExchangeRateSettings<T extends { targetAmountRmb: unknown }>(row: T) {
  return {
    ...row,
    targetAmountRmb: mapAmount4(
      row.targetAmountRmb,
      'id_business_v2_exchange_rate_settings.target_amount_rmb'
    )
  };
}

function mapExchangeRateRun(row: ExchangeRateRunRow) {
  return {
    ...mapExchangeRateRunBase(row),
    snapshot: row.snapshot
      ? {
          ...mapExchangeRateSnapshot(row.snapshot),
          providerSnapshots: row.snapshot.providerSnapshots.map((provider) => ({
            ...provider,
            averageRateToRmb: mapRate8(
              provider.averageRateToRmb,
              'id_business_v2_exchange_rate_provider_snapshots.average_rate_to_rmb'
            )
          }))
        }
      : null
  };
}

function mapExchangeRateRunDetail(row: ExchangeRateRunDetailRow) {
  return {
    ...mapExchangeRateRunBase(row),
    snapshot: row.snapshot
      ? {
          ...mapExchangeRateSnapshot(row.snapshot),
          providerSnapshots: row.snapshot.providerSnapshots.map((provider) => ({
            ...provider,
            medianRateToRmb: mapRate8(
              provider.medianRateToRmb,
              'id_business_v2_exchange_rate_provider_snapshots.median_rate_to_rmb'
            ),
            lowestValidRateToRmb: mapRate8(
              provider.lowestValidRateToRmb,
              'id_business_v2_exchange_rate_provider_snapshots.lowest_valid_rate_to_rmb'
            ),
            highestValidRateToRmb: mapRate8(
              provider.highestValidRateToRmb,
              'id_business_v2_exchange_rate_provider_snapshots.highest_valid_rate_to_rmb'
            ),
            averageRateToRmb: mapRate8(
              provider.averageRateToRmb,
              'id_business_v2_exchange_rate_provider_snapshots.average_rate_to_rmb'
            ),
            validSamples: provider.validSamples.map((sample) => ({
              ...sample,
              priceToRmb: mapRate8(
                sample.priceToRmb,
                'id_business_v2_exchange_rate_quote_samples.price_to_rmb'
              ),
              minAmountRmb: mapOptionalAmount4(
                sample.minAmountRmb,
                'id_business_v2_exchange_rate_quote_samples.min_amount_rmb'
              ),
              maxAmountRmb: mapOptionalAmount4(
                sample.maxAmountRmb,
                'id_business_v2_exchange_rate_quote_samples.max_amount_rmb'
              ),
              tradableAmountUsdt: mapAmount4(
                sample.tradableAmountUsdt,
                'id_business_v2_exchange_rate_quote_samples.tradable_amount_usdt'
              ),
              completionRate: mapRate8(
                sample.completionRate,
                'id_business_v2_exchange_rate_quote_samples.completion_rate'
              ),
              positiveReviewRate: mapOptionalRate8(
                sample.positiveReviewRate,
                'id_business_v2_exchange_rate_quote_samples.positive_review_rate'
              )
            }))
          }))
        }
      : null
  };
}

function mapExchangeRateRunBase<T extends ExchangeRateRunRow | ExchangeRateRunDetailRow>(row: T) {
  return {
    ...row,
    targetAmountRmb: mapOptionalAmount4(
      row.targetAmountRmb,
      'id_business_v2_exchange_rate_runs.target_amount_rmb'
    ),
    policyMinCompletionRate: mapOptionalRate8(
      row.policyMinCompletionRate,
      'id_business_v2_exchange_rate_runs.policy_min_completion_rate'
    ),
    policyMaxPriceDeviationRate: mapOptionalRate8(
      row.policyMaxPriceDeviationRate,
      'id_business_v2_exchange_rate_runs.policy_max_price_deviation_rate'
    )
  };
}

function mapExchangeRateSnapshot<
  T extends {
    combinedMerchantBuyAverageRateToRmb: unknown;
    combinedMerchantSellAverageRateToRmb: unknown;
    midRateToRmb: unknown;
  }
>(snapshot: T) {
  return {
    ...snapshot,
    combinedMerchantBuyAverageRateToRmb: mapRate8(
      snapshot.combinedMerchantBuyAverageRateToRmb,
      'id_business_v2_exchange_rate_snapshots.combined_merchant_buy_average_rate_to_rmb'
    ),
    combinedMerchantSellAverageRateToRmb: mapRate8(
      snapshot.combinedMerchantSellAverageRateToRmb,
      'id_business_v2_exchange_rate_snapshots.combined_merchant_sell_average_rate_to_rmb'
    ),
    midRateToRmb: mapRate8(
      snapshot.midRateToRmb,
      'id_business_v2_exchange_rate_snapshots.mid_rate_to_rmb'
    )
  };
}
