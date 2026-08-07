import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { V2_FINANCE_CURRENCIES } from '@apple-business/shared';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { Rate8 } from '../runtime/public-api';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';
import {
  IdBusinessV2ExchangeRateRepository,
  type IdBusinessV2AutomaticFxRateSource,
  type IdBusinessV2TrackedFxCurrency
} from './persistence/id-business-v2-exchange-rate.repository';

export interface ListIdBusinessV2ExchangeRateRunsQuery extends PaginationQuery {
  keyword?: string;
  status?: string;
  triggerType?: string;
  provider?: string;
  collectedFrom?: string;
  collectedTo?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2ExchangeRateRecordsQuery extends PaginationQuery {
  currency?: string;
  source?: string;
  status?: string;
  capturedFrom?: string;
  capturedTo?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RunRecord = NonNullable<
  Awaited<ReturnType<IdBusinessV2ExchangeRateRepository['findLatestRun']>>
>;
type ReceiptFxSnapshot = Awaited<
  ReturnType<IdBusinessV2ExchangeRateRepository['findLatestReceiptFxSnapshots']>
>[number];
type FxRecordSnapshot = Awaited<
  ReturnType<IdBusinessV2ExchangeRateRepository['listAutomaticFxRateSnapshots']>
>[0][number];

const TRACKED_FX_CURRENCIES = V2_FINANCE_CURRENCIES.filter(
  (currency): currency is IdBusinessV2TrackedFxCurrency => currency !== 'CNY'
);
const AUTOMATIC_FX_RATE_SOURCES = new Set<IdBusinessV2AutomaticFxRateSource>([
  'combined_p2p',
  'binance',
  'okx',
  'ecb_cross'
]);

@Injectable()
export class IdBusinessV2ExchangeRateQueryService {
  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly settingsService: IdBusinessV2ExchangeRateSettingsService
  ) {}

  async listRuns(query: ListIdBusinessV2ExchangeRateRunsQuery) {
    const pagination = getPagination(query);
    const filters = this.runFilters(query);
    const [items, total] = await this.repository.listRuns({
      ...filters,
      skip: pagination.skip,
      take: pagination.take,
      sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc'
    });
    return {
      items: items.map((item) => this.runResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getRun(idValue: string) {
    const id = this.uuid(idValue, '采集批次编号');
    const run = await this.repository.findRun(id);
    if (!run) throw new NotFoundException('汇率采集批次不存在');

    return {
      ...this.runBase(run),
      snapshot: run.snapshot
        ? {
            id: run.snapshot.id,
            averagedAt: run.snapshot.averagedAt,
            combinedMerchantBuyAverageRateToRmb:
              run.snapshot.combinedMerchantBuyAverageRateToRmb.toString(),
            combinedMerchantSellAverageRateToRmb:
              run.snapshot.combinedMerchantSellAverageRateToRmb.toString(),
            midRateToRmb: run.snapshot.midRateToRmb.toString()
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
          medianRateToRmb: provider.medianRateToRmb.toString(),
          lowestValidRateToRmb: provider.lowestValidRateToRmb.toString(),
          highestValidRateToRmb: provider.highestValidRateToRmb.toString(),
          averageRateToRmb: provider.averageRateToRmb.toString(),
          validSamples: provider.validSamples.map((sample) => ({
            sourceAdId: sample.sourceAdId,
            priceToRmb: sample.priceToRmb.toString(),
            minAmountRmb: sample.minAmountRmb?.toString() ?? null,
            maxAmountRmb: sample.maxAmountRmb?.toString() ?? null,
            tradableAmountUsdt: sample.tradableAmountUsdt.toString(),
            paymentMethods: sample.paymentMethods,
            merchantType: sample.merchantType,
            completedOrderCount: sample.completedOrderCount,
            completionRate: sample.completionRate.toString(),
            positiveReviewRate: sample.positiveReviewRate?.toString() ?? null
          }))
        })) ?? []
    };
  }

  async getOverview() {
    const [latestRun, lastSuccess, settings, latestReceiptFxRates] = await Promise.all([
      this.repository.findLatestRun(),
      this.repository.findLatestRun('success'),
      this.settingsService.getRecord(),
      this.getLatestReceiptFxRates()
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
      latestReceiptFxRates,
      calculationRule: '平台内有效商家报价算术平均，Binance 与 OKX 等权合并，买卖综合价再取中间值'
    };
  }

  async listRecords(query: ListIdBusinessV2ExchangeRateRecordsQuery, now = new Date()) {
    const pagination = getPagination(query);
    const [items, total] = await this.repository.listAutomaticFxRateSnapshots({
      currency: this.recordCurrency(query.currency),
      source: this.recordSource(query.source),
      status: this.recordStatus(query.status),
      capturedAt: this.recordDateRange(query.capturedFrom, query.capturedTo),
      now,
      skip: pagination.skip,
      take: pagination.take,
      sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc'
    });
    return {
      items: items.map((item) => this.fxRecordResponse(item, now)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getEffective() {
    const [latestRun, lastSuccess, settings] = await Promise.all([
      this.repository.findLatestRun(),
      this.repository.findLatestRun('success'),
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
    if (!prefilled.equals(effective.midRateToRmb)) {
      throw new BadRequestException('预填汇率与来源快照不一致');
    }
    return {
      exchangeRateSource: 'automatic_snapshot',
      exchangeRateSnapshotId: snapshotId,
      exchangeRatePrefilledValue: prefilled,
      exchangeRateWasOverridden: !finalRate.equals(prefilled)
    };
  }

  async getLatestReceiptFxRates(now = new Date()) {
    const snapshots = await this.repository.findLatestReceiptFxSnapshots(TRACKED_FX_CURRENCIES);
    const byCurrency = new Map<IdBusinessV2FinanceCurrency, ReceiptFxSnapshot>(
      snapshots.map((snapshot) => [snapshot.currency, snapshot])
    );
    return V2_FINANCE_CURRENCIES.map((currency) => {
      if (currency === 'CNY') {
        return {
          currency,
          snapshotId: null,
          rateToCny: '1',
          source: 'cny_fixed',
          capturedAt: now,
          expiresAt: null,
          status: 'fixed' as const
        };
      }
      const snapshot = byCurrency.get(currency);
      if (!snapshot) {
        return {
          currency,
          snapshotId: null,
          rateToCny: null,
          source: null,
          capturedAt: null,
          expiresAt: null,
          status: 'missing' as const
        };
      }
      const expired = Boolean(snapshot.expiresAt && snapshot.expiresAt.getTime() <= now.getTime());
      return {
        currency,
        snapshotId: snapshot.id,
        rateToCny: snapshot.rateToCny,
        source: snapshot.source,
        capturedAt: snapshot.capturedAt,
        expiresAt: snapshot.expiresAt,
        status: expired ? ('expired' as const) : ('available' as const)
      };
    });
  }

  private evaluateEffective(
    latestRun: RunRecord | null,
    lastSuccess: RunRecord | null,
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
      midRateToRmb: candidate.snapshot.midRateToRmb.toString(),
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

  private runFilters(query: ListIdBusinessV2ExchangeRateRunsQuery) {
    const keyword = query.keyword?.trim();
    const gte = this.dateBoundary(query.collectedFrom, false);
    const lte = this.dateBoundary(query.collectedTo, true);
    return {
      keyword,
      keywordIsUuid: Boolean(keyword && UUID_PATTERN.test(keyword)),
      status: ['running', 'success', 'failed'].includes(query.status ?? '')
        ? (query.status as 'running' | 'success' | 'failed')
        : undefined,
      triggerType: ['manual', 'scheduled', 'system'].includes(query.triggerType ?? '')
        ? (query.triggerType as 'manual' | 'scheduled' | 'system')
        : undefined,
      provider:
        query.provider === 'binance' || query.provider === 'okx'
          ? (query.provider as 'binance' | 'okx')
          : undefined,
      startedAt: gte || lte ? { gte, lte } : undefined
    };
  }

  private recordCurrency(value: string | undefined) {
    if (!value?.trim()) return undefined;
    const currency = value.trim().toUpperCase();
    if (!TRACKED_FX_CURRENCIES.includes(currency as IdBusinessV2TrackedFxCurrency)) {
      throw new BadRequestException('自动汇率记录仅支持 MYR、USD、USDT');
    }
    return currency as IdBusinessV2TrackedFxCurrency;
  }

  private recordSource(value: string | undefined) {
    if (!value?.trim()) return undefined;
    const source = value.trim() as IdBusinessV2AutomaticFxRateSource;
    if (!AUTOMATIC_FX_RATE_SOURCES.has(source)) {
      throw new BadRequestException('汇率来源筛选无效');
    }
    return source;
  }

  private recordStatus(value: string | undefined) {
    if (!value?.trim()) return undefined;
    if (value === 'available' || value === 'expired') return value;
    throw new BadRequestException('汇率状态筛选无效');
  }

  private recordDateRange(fromValue?: string, toValue?: string) {
    const gte = this.dateBoundary(fromValue, false);
    const lte = this.dateBoundary(toValue, true);
    if (gte && lte && gte > lte) {
      throw new BadRequestException('采集开始日期不能晚于结束日期');
    }
    return gte || lte ? { gte, lte } : undefined;
  }

  private fxRecordResponse(snapshot: FxRecordSnapshot, now: Date) {
    const expiresAt = snapshot.expiresAt;
    return {
      id: snapshot.id,
      currency: snapshot.currency,
      rateToCny: snapshot.rateToCny,
      source: snapshot.source,
      sourceReference: snapshot.sourceReference,
      sourceEvidence: snapshot.sourceEvidence,
      businessDate: snapshot.businessDate.toISOString().slice(0, 10),
      capturedAt: snapshot.capturedAt,
      expiresAt,
      status: expiresAt && expiresAt.getTime() <= now.getTime() ? 'expired' : 'available',
      exchangeRateRunId: this.exchangeRateRunId(snapshot.sourceEvidence),
      createdBy: snapshot.createdBy
    };
  }

  private exchangeRateRunId(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = (value as Record<string, unknown>).exchangeRateRunId;
    return typeof candidate === 'string' ? candidate : null;
  }

  private runResponse(run: RunRecord) {
    return {
      ...this.runBase(run),
      snapshot: run.snapshot
        ? {
            id: run.snapshot.id,
            averagedAt: run.snapshot.averagedAt,
            combinedMerchantBuyAverageRateToRmb:
              run.snapshot.combinedMerchantBuyAverageRateToRmb.toString(),
            combinedMerchantSellAverageRateToRmb:
              run.snapshot.combinedMerchantSellAverageRateToRmb.toString(),
            midRateToRmb: run.snapshot.midRateToRmb.toString(),
            providerSnapshotCount: run.snapshot.providerSnapshots.length,
            validSampleCount: run.snapshot.providerSnapshots.reduce(
              (sum, item) => sum + item.validAdCount,
              0
            ),
            providers: run.snapshot.providerSnapshots.map((provider) => ({
              provider: provider.provider,
              side: provider.side,
              validAdCount: provider.validAdCount,
              averageRateToRmb: provider.averageRateToRmb.toString()
            }))
          }
        : null
    };
  }

  private runBase(run: {
    id: string;
    status: string;
    triggerType: string;
    targetAmountRmb: { toString(): string } | null;
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
      targetAmountRmb: run.targetAmountRmb?.toString() ?? null,
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
      const decimal = Rate8.from(
        typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      );
      if (decimal.lte(0)) throw new Error('invalid');
      return decimal;
    } catch {
      throw new BadRequestException(`${label}格式无效`);
    }
  }
}
