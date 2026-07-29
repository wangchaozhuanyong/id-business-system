import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE, toV2DecimalString } from '../decimal-policy';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';

export interface ListIdBusinessV2ExchangeRateRunsQuery extends PaginationQuery {
  keyword?: string;
  status?: string;
  triggerType?: string;
  provider?: string;
  collectedFrom?: string;
  collectedTo?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_INCLUDE = {
  triggeredBy: {
    select: { id: true, username: true, displayName: true }
  },
  snapshot: {
    include: {
      providerSnapshots: {
        select: {
          provider: true,
          side: true,
          validAdCount: true,
          averageRateToRmb: true
        }
      }
    }
  }
} satisfies Prisma.IdBusinessV2ExchangeRateRunInclude;

@Injectable()
export class IdBusinessV2ExchangeRateQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: IdBusinessV2ExchangeRateSettingsService
  ) {}

  async listRuns(query: ListIdBusinessV2ExchangeRateRunsQuery) {
    const pagination = getPagination(query);
    const where = this.runWhere(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2ExchangeRateRun.findMany({
        where,
        include: RUN_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ startedAt: query.sortOrder === 'asc' ? 'asc' : 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2ExchangeRateRun.count({ where })
    ]);
    return {
      items: items.map((item) => this.runResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getRun(idValue: string) {
    const id = this.uuid(idValue, '采集批次编号');
    const run = await this.prisma.idBusinessV2ExchangeRateRun.findUnique({
      where: { id },
      include: {
        triggeredBy: {
          select: { id: true, username: true, displayName: true }
        },
        snapshot: {
          include: {
            providerSnapshots: {
              include: {
                validSamples: {
                  orderBy: [{ priceToRmb: 'asc' }, { sourceAdId: 'asc' }]
                }
              },
              orderBy: [{ provider: 'asc' }, { side: 'asc' }]
            }
          }
        }
      }
    });
    if (!run) throw new NotFoundException('汇率采集批次不存在');

    return {
      ...this.runBase(run),
      snapshot: run.snapshot
        ? {
            id: run.snapshot.id,
            averagedAt: run.snapshot.averagedAt,
            combinedMerchantBuyAverageRateToRmb: toV2DecimalString(
              run.snapshot.combinedMerchantBuyAverageRateToRmb
            ),
            combinedMerchantSellAverageRateToRmb: toV2DecimalString(
              run.snapshot.combinedMerchantSellAverageRateToRmb
            ),
            midRateToRmb: toV2DecimalString(run.snapshot.midRateToRmb)
          }
        : null,
      providerSnapshots:
        run.snapshot?.providerSnapshots.map((provider) => ({
          id: provider.id,
          provider: provider.provider,
          side: provider.side,
          sourceContract: provider.sourceContract,
          sourceUrl: provider.sourceUrl,
          collectedAt: provider.collectedAt,
          counts: {
            received: provider.receivedAdCount,
            collectorAccepted: provider.collectorAcceptedAdCount,
            collectorRejected: provider.collectorRejectedAdCount,
            valid: provider.validAdCount,
            filtered: provider.filteredAdCount
          },
          exclusions: {
            missingTradableAmount: provider.excludedMissingTradableAmount,
            nonPositiveTradable: provider.excludedNonPositiveTradable,
            missingOrderCount: provider.excludedMissingOrderCount,
            lowOrderCount: provider.excludedLowOrderCount,
            missingCompletionRate: provider.excludedMissingCompletionRate,
            lowCompletionRate: provider.excludedLowCompletionRate,
            priceOutlier: provider.excludedPriceOutlier
          },
          medianRateToRmb: toV2DecimalString(provider.medianRateToRmb),
          lowestValidRateToRmb: toV2DecimalString(provider.lowestValidRateToRmb),
          highestValidRateToRmb: toV2DecimalString(provider.highestValidRateToRmb),
          averageRateToRmb: toV2DecimalString(provider.averageRateToRmb),
          validSamples: provider.validSamples.map((sample) => ({
            sourceAdId: sample.sourceAdId,
            priceToRmb: toV2DecimalString(sample.priceToRmb),
            minAmountRmb: sample.minAmountRmb ? toV2DecimalString(sample.minAmountRmb) : null,
            maxAmountRmb: sample.maxAmountRmb ? toV2DecimalString(sample.maxAmountRmb) : null,
            tradableAmountUsdt: toV2DecimalString(sample.tradableAmountUsdt),
            paymentMethods: sample.paymentMethods,
            merchantType: sample.merchantType,
            completedOrderCount: sample.completedOrderCount,
            completionRate: toV2DecimalString(sample.completionRate),
            positiveReviewRate:
              sample.positiveReviewRate === null
                ? null
                : toV2DecimalString(sample.positiveReviewRate)
          }))
        })) ?? []
    };
  }

  async getOverview() {
    const [latestRun, lastSuccess, settings] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateRun.findFirst({
        include: RUN_INCLUDE,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2ExchangeRateRun.findFirst({
        where: { status: 'success' },
        include: RUN_INCLUDE,
        orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }]
      }),
      this.settingsService.getRecord()
    ]);
    const effective = this.evaluateEffective(latestRun, lastSuccess, settings.intervalMinutes);
    return {
      latestRun: latestRun ? this.runResponse(latestRun) : null,
      lastSuccess: lastSuccess
        ? {
            ...this.runResponse(lastSuccess),
            stale: !effective.available || effective.runId !== lastSuccess.id,
            expiresAt: this.expiresAt(lastSuccess.snapshot?.averagedAt, settings.intervalMinutes)
          }
        : null,
      effective: this.publicEffective(effective),
      calculationRule: '平台内有效商家报价算术平均，Binance 与 OKX 等权合并，买卖综合价再取中间值'
    };
  }

  async getEffective() {
    const [latestRun, lastSuccess, settings] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateRun.findFirst({
        include: RUN_INCLUDE,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2ExchangeRateRun.findFirst({
        where: { status: 'success' },
        include: RUN_INCLUDE,
        orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }]
      }),
      this.settingsService.getRecord()
    ]);
    return this.publicEffective(
      this.evaluateEffective(latestRun, lastSuccess, settings.intervalMinutes)
    );
  }

  async validatePrefill(snapshotIdValue: string, prefilledValue: unknown, finalValue: unknown) {
    const effective = await this.getEffective();
    const snapshotId = this.uuid(snapshotIdValue, '汇率来源快照');
    if (!effective.available || effective.snapshotId !== snapshotId || !effective.midRateToRmb) {
      throw new BadRequestException('预填汇率已失效，请刷新加卡页面后重新核对');
    }
    const prefilled = this.decimal(prefilledValue, '预填汇率');
    const finalRate = this.decimal(finalValue, '最终汇率');
    if (!prefilled.eq(effective.midRateToRmb)) {
      throw new BadRequestException('预填汇率与来源快照不一致');
    }
    return {
      exchangeRateSource: 'automatic_snapshot',
      exchangeRateSnapshotId: snapshotId,
      exchangeRatePrefilledValue: prefilled,
      exchangeRateWasOverridden: !finalRate.eq(prefilled)
    };
  }

  private evaluateEffective(
    latestRun: Prisma.IdBusinessV2ExchangeRateRunGetPayload<{
      include: typeof RUN_INCLUDE;
    }> | null,
    lastSuccess: Prisma.IdBusinessV2ExchangeRateRunGetPayload<{
      include: typeof RUN_INCLUDE;
    }> | null,
    intervalMinutes: number
  ) {
    if (!this.settingsService.isNetworkEnabled()) {
      return { available: false as const, reason: 'emergency_disabled' as const };
    }
    if (!latestRun) {
      return { available: false as const, reason: 'never_collected' as const };
    }
    if (latestRun.status === 'failed') {
      return {
        available: false as const,
        reason: 'latest_attempt_failed' as const,
        latestRunId: latestRun.id
      };
    }
    const candidate =
      latestRun.status === 'success' && latestRun.snapshot ? latestRun : lastSuccess;
    if (!candidate?.snapshot) {
      return {
        available: false as const,
        reason: 'collection_in_progress' as const,
        latestRunId: latestRun.id
      };
    }
    const expiresAt = this.expiresAt(candidate.snapshot.averagedAt, intervalMinutes)!;
    if (expiresAt.getTime() <= Date.now()) {
      return {
        available: false as const,
        reason: 'stale' as const,
        latestRunId: latestRun.id,
        expiresAt
      };
    }
    return {
      available: true as const,
      reason: null,
      runId: candidate.id,
      snapshotId: candidate.snapshot.id,
      midRateToRmb: toV2DecimalString(candidate.snapshot.midRateToRmb),
      averagedAt: candidate.snapshot.averagedAt,
      expiresAt
    };
  }

  private publicEffective(
    result: ReturnType<IdBusinessV2ExchangeRateQueryService['evaluateEffective']>
  ) {
    return result;
  }

  private expiresAt(averagedAt: Date | undefined, intervalMinutes: number) {
    return averagedAt
      ? new Date(averagedAt.getTime() + intervalMinutes * 60_000 + 2 * 60_000)
      : null;
  }

  private runWhere(query: ListIdBusinessV2ExchangeRateRunsQuery) {
    const where: Prisma.IdBusinessV2ExchangeRateRunWhereInput = {};
    const keyword = query.keyword?.trim();
    if (keyword) {
      where.OR = [
        ...(UUID_PATTERN.test(keyword) ? [{ id: keyword }] : []),
        { errorCode: { contains: keyword, mode: 'insensitive' } },
        { errorMessage: { contains: keyword, mode: 'insensitive' } }
      ];
    }
    if (['running', 'success', 'failed'].includes(query.status ?? '')) {
      where.status = query.status as 'running' | 'success' | 'failed';
    }
    if (['manual', 'scheduled', 'system'].includes(query.triggerType ?? '')) {
      where.triggerType = query.triggerType as 'manual' | 'scheduled' | 'system';
    }
    if (query.provider === 'binance' || query.provider === 'okx') {
      where.snapshot = {
        is: {
          providerSnapshots: {
            some: { provider: query.provider }
          }
        }
      };
    }
    const gte = this.dateBoundary(query.collectedFrom, false);
    const lte = this.dateBoundary(query.collectedTo, true);
    if (gte || lte) where.startedAt = { gte, lte };
    return where;
  }

  private runResponse(
    run: Prisma.IdBusinessV2ExchangeRateRunGetPayload<{ include: typeof RUN_INCLUDE }>
  ) {
    return {
      ...this.runBase(run),
      snapshot: run.snapshot
        ? {
            id: run.snapshot.id,
            averagedAt: run.snapshot.averagedAt,
            combinedMerchantBuyAverageRateToRmb: toV2DecimalString(
              run.snapshot.combinedMerchantBuyAverageRateToRmb
            ),
            combinedMerchantSellAverageRateToRmb: toV2DecimalString(
              run.snapshot.combinedMerchantSellAverageRateToRmb
            ),
            midRateToRmb: toV2DecimalString(run.snapshot.midRateToRmb),
            providerSnapshotCount: run.snapshot.providerSnapshots.length,
            validSampleCount: run.snapshot.providerSnapshots.reduce(
              (sum, item) => sum + item.validAdCount,
              0
            ),
            providers: run.snapshot.providerSnapshots.map((provider) => ({
              provider: provider.provider,
              side: provider.side,
              validAdCount: provider.validAdCount,
              averageRateToRmb: toV2DecimalString(provider.averageRateToRmb)
            }))
          }
        : null
    };
  }

  private runBase(run: {
    id: string;
    status: string;
    triggerType: string;
    targetAmountRmb: Prisma.Decimal | null;
    startedAt: Date;
    finishedAt: Date | null;
    errorCode: string | null;
    errorMessage: string | null;
    errorProvider: string | null;
    errorSide: string | null;
    errorRetryable: boolean | null;
    triggeredBy: { id: string; username: string; displayName: string } | null;
  }) {
    return {
      id: run.id,
      status: run.status,
      triggerType: run.triggerType,
      targetAmountRmb: run.targetAmountRmb === null ? null : toV2DecimalString(run.targetAmountRmb),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      triggeredBy: run.triggeredBy,
      error: run.errorCode
        ? {
            code: run.errorCode,
            message: run.errorMessage,
            provider: run.errorProvider,
            side: run.errorSide,
            retryable: run.errorRetryable
          }
        : null
    };
  }

  private dateBoundary(value: string | undefined, end: boolean) {
    if (!value?.trim()) return undefined;
    const date = new Date(`${value.trim()}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('采集日期格式无效');
    return date;
  }

  private uuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
    return normalized;
  }

  private decimal(value: unknown, label: string) {
    try {
      const decimal = new Prisma.Decimal(
        typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      ).toDecimalPlaces(V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE);
      if (!decimal.isFinite() || decimal.lte(0)) throw new Error('invalid');
      return decimal;
    } catch {
      throw new BadRequestException(`${label}格式无效`);
    }
  }
}
