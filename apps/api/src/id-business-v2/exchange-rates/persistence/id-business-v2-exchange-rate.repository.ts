import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  isUnsupportedFinanceCurrencyEnumError,
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

export const FINANCE_FX_RATE_SNAPSHOT_INCLUDE = {
  createdBy: { select: { id: true, username: true, displayName: true } }
} satisfies Prisma.IdBusinessV2FinanceFxRateSnapshotInclude;

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

type FinanceFxRateSnapshotRow = Prisma.IdBusinessV2FinanceFxRateSnapshotGetPayload<{
  include: typeof FINANCE_FX_RATE_SNAPSHOT_INCLUDE;
}>;

export type IdBusinessV2TrackedFxCurrency = 'MYR' | 'USD' | 'USDT';
export type IdBusinessV2AutomaticFxRateSource = 'combined_p2p' | 'binance' | 'okx' | 'ecb_cross';
export type IdBusinessV2ManualFxRateSource = 'manual';

const AUTOMATIC_FX_RATE_SOURCES: IdBusinessV2AutomaticFxRateSource[] = [
  'combined_p2p',
  'binance',
  'okx',
  'ecb_cross'
];

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
            { remark: { contains: input.keyword } },
            { createdBy: { is: { username: { contains: input.keyword } } } },
            { createdBy: { is: { displayName: { contains: input.keyword } } } }
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
        retentionDays: 30,
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
      retentionDays: number;
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
      Array<{ targetAmountRmb: Prisma.Decimal; intervalMinutes: number }>
    >(Prisma.sql`
      SELECT
        "target_amount_rmb" AS "targetAmountRmb",
        "interval_minutes" AS "intervalMinutes"
      FROM "id_business_v2_exchange_rate_settings"
      WHERE "id" = 1
        AND "auto_enabled" = true
        AND "next_run_at" <= UTC_TIMESTAMP(6)
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) return null;

    const intervalMs = row.intervalMinutes * 60 * 1_000;
    const nextRunAt = new Date((Math.floor(Date.now() / intervalMs) + 1) * intervalMs);
    await tx.idBusinessV2ExchangeRateSettings.update({
      where: { id: 1 },
      data: { nextRunAt }
    });
    return {
      ...row,
      nextRunAt,
      targetAmountRmb: mapAmount4(
        row.targetAmountRmb,
        'id_business_v2_exchange_rate_settings.target_amount_rmb'
      )
    };
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

  createFinanceFxRateSnapshot(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2FinanceFxRateSnapshotUncheckedCreateInput
  ) {
    return tx.idBusinessV2FinanceFxRateSnapshot
      .create({
        data,
        include: FINANCE_FX_RATE_SNAPSHOT_INCLUDE
      })
      .then(mapFinanceFxRateSnapshot);
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
            { errorCode: { contains: input.keyword } },
            { errorMessage: { contains: input.keyword } }
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

  async findLatestReceiptFxSnapshots(currencies: IdBusinessV2TrackedFxCurrency[]) {
    const rows = await Promise.all(
      currencies.map((currency) =>
        this.prisma.idBusinessV2FinanceFxRateSnapshot
          .findFirst({
            where: { currency },
            orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
          })
          .catch((error: unknown) => {
            if (isUnsupportedFinanceCurrencyEnumError(error, currency)) return null;
            throw error;
          })
      )
    );
    return rows.filter((row) => row !== null).map(mapReceiptFxSnapshot);
  }

  async listAutomaticFxRateSnapshots(input: {
    currency?: IdBusinessV2TrackedFxCurrency;
    source?: IdBusinessV2AutomaticFxRateSource;
    status?: 'available' | 'expired';
    capturedAt?: { gte?: Date; lte?: Date };
    now: Date;
    skip: number;
    take: number;
    sortOrder: 'asc' | 'desc';
  }) {
    const where: Prisma.IdBusinessV2FinanceFxRateSnapshotWhereInput = {
      currency: input.currency,
      source: input.source ?? { in: AUTOMATIC_FX_RATE_SOURCES },
      capturedAt: input.capturedAt,
      expiresAt:
        input.status === 'available'
          ? { gt: input.now }
          : input.status === 'expired'
            ? { lte: input.now }
            : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2FinanceFxRateSnapshot.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ capturedAt: input.sortOrder }, { id: input.sortOrder }],
        include: FINANCE_FX_RATE_SNAPSHOT_INCLUDE
      }),
      this.prisma.idBusinessV2FinanceFxRateSnapshot.count({ where })
    ]).catch((error: unknown) => {
      if (input.currency && isUnsupportedFinanceCurrencyEnumError(error, input.currency)) {
        return [[], 0] as const;
      }
      throw error;
    });
    return [rows.map(mapFinanceFxRateSnapshot), total] as const;
  }

  async listManualFxRateSnapshots(input: {
    keyword?: string;
    currency?: 'CNY' | IdBusinessV2TrackedFxCurrency;
    recordedAt?: { gte?: Date; lte?: Date };
    skip: number;
    take: number;
    sortOrder: 'asc' | 'desc';
  }) {
    const where: Prisma.IdBusinessV2FinanceFxRateSnapshotWhereInput = {
      source: 'manual',
      currency: input.currency,
      capturedAt: input.recordedAt,
      OR: input.keyword
        ? [
            { manualReason: { contains: input.keyword } },
            { sourceReference: { contains: input.keyword } },
            { createdBy: { is: { username: { contains: input.keyword } } } },
            { createdBy: { is: { displayName: { contains: input.keyword } } } }
          ]
        : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2FinanceFxRateSnapshot.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ capturedAt: input.sortOrder }, { id: input.sortOrder }],
        include: FINANCE_FX_RATE_SNAPSHOT_INCLUDE
      }),
      this.prisma.idBusinessV2FinanceFxRateSnapshot.count({ where })
    ]).catch((error: unknown) => {
      if (input.currency && isUnsupportedFinanceCurrencyEnumError(error, input.currency)) {
        return [[], 0] as const;
      }
      throw error;
    });
    return [rows.map(mapFinanceFxRateSnapshot), total] as const;
  }

  async findManualFxRateSnapshot(id: string) {
    const row = await this.prisma.idBusinessV2FinanceFxRateSnapshot.findFirst({
      where: { id, source: 'manual' },
      include: FINANCE_FX_RATE_SNAPSHOT_INCLUDE
    });
    return row ? mapFinanceFxRateSnapshot(row) : null;
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
    const settings = await tx.idBusinessV2ExchangeRateSettings.findUnique({
      where: { id: 1 },
      select: { retentionDays: true }
    });
    const retentionDays = Math.min(Math.max(settings?.retentionDays ?? 30, 7), 3650);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000);

    const runCandidates = await tx.idBusinessV2ExchangeRateRun.findMany({
      where: { status: { not: 'running' }, startedAt: { lt: cutoff } },
      select: {
        id: true,
        snapshot: { select: { id: true, _count: { select: { giftCards: true } } } }
      }
    });
    const referencedSnapshotIds = runCandidates
      .map((run) => run.snapshot?.id)
      .filter((id): id is string => Boolean(id));
    const financeReferences = referencedSnapshotIds.length
      ? await tx.idBusinessV2FinanceFxRateSnapshot.findMany({
          where: { source: 'combined_p2p', sourceReference: { in: referencedSnapshotIds } },
          select: { sourceReference: true }
        })
      : [];
    const financeReferenceSet = new Set(
      financeReferences.map((snapshot) => snapshot.sourceReference).filter(Boolean)
    );
    const eligibleRuns = runCandidates.filter(
      (run) =>
        (run.snapshot?._count.giftCards ?? 0) === 0 &&
        (!run.snapshot || !financeReferenceSet.has(run.snapshot.id))
    );
    const eligibleRunIds = eligibleRuns.map((run) => run.id);
    const eligibleSnapshotIds = eligibleRuns
      .map((run) => run.snapshot?.id)
      .filter((id): id is string => Boolean(id));

    const fxCandidates = await tx.idBusinessV2FinanceFxRateSnapshot.findMany({
      where: {
        source: { in: AUTOMATIC_FX_RATE_SOURCES },
        capturedAt: { lt: cutoff }
      },
      select: {
        id: true,
        _count: {
          select: {
            journalLines: true,
            expenses: true,
            supplierPayments: true,
            accountPurchases: true,
            giftCardPurchases: true,
            orderReceipts: true
          }
        }
      }
    });
    const eligibleFxSnapshotIds = fxCandidates
      .filter((snapshot) => Object.values(snapshot._count).every((count) => count === 0))
      .map((snapshot) => snapshot.id);

    const providerSnapshots = eligibleSnapshotIds.length
      ? await tx.idBusinessV2ExchangeRateProviderSnapshot.findMany({
          where: { snapshotId: { in: eligibleSnapshotIds } },
          select: { id: true }
        })
      : [];
    const providerSnapshotIds = providerSnapshots.map((snapshot) => snapshot.id);
    const deletedQuoteSamples = providerSnapshotIds.length
      ? (
          await tx.idBusinessV2ExchangeRateQuoteSample.deleteMany({
            where: { providerSnapshotId: { in: providerSnapshotIds } }
          })
        ).count
      : 0;
    const deletedProviderSnapshots = eligibleSnapshotIds.length
      ? (
          await tx.idBusinessV2ExchangeRateProviderSnapshot.deleteMany({
            where: { snapshotId: { in: eligibleSnapshotIds } }
          })
        ).count
      : 0;
    const deletedSnapshots = eligibleRunIds.length
      ? (
          await tx.idBusinessV2ExchangeRateSnapshot.deleteMany({
            where: { runId: { in: eligibleRunIds } }
          })
        ).count
      : 0;
    const deletedRuns = eligibleRunIds.length
      ? (
          await tx.idBusinessV2ExchangeRateRun.deleteMany({
            where: { id: { in: eligibleRunIds } }
          })
        ).count
      : 0;
    const deletedFxRateSnapshots = eligibleFxSnapshotIds.length
      ? (
          await tx.idBusinessV2FinanceFxRateSnapshot.deleteMany({
            where: { id: { in: eligibleFxSnapshotIds } }
          })
        ).count
      : 0;

    return {
      cutoff: cutoff.toISOString(),
      retentionDays,
      deletedRuns,
      deletedSnapshots,
      deletedProviderSnapshots,
      deletedQuoteSamples,
      deletedFxRateSnapshots,
      preservedReferencedRuns: runCandidates.length - eligibleRuns.length,
      preservedReferencedFxRateSnapshots: fxCandidates.length - eligibleFxSnapshotIds.length
    };
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

function mapReceiptFxSnapshot<T extends { rateToCny: unknown }>(snapshot: T) {
  return {
    ...snapshot,
    rateToCny: mapRate8(
      snapshot.rateToCny,
      'id_business_v2_finance_fx_rate_snapshots.rate_to_cny'
    ).toString()
  };
}

function mapFinanceFxRateSnapshot(row: FinanceFxRateSnapshotRow) {
  return {
    ...row,
    rateToCny: mapRate8(
      row.rateToCny,
      'id_business_v2_finance_fx_rate_snapshots.rate_to_cny'
    ).toString()
  };
}
