import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { IdBusinessV2PurchaseRateProviderService } from './id-business-v2-purchase-rate-provider.service';
import type { IdBusinessV2PurchaseRateCandidateQuote } from './id-business-v2-purchase-rate-provider.types';
import { IdBusinessV2PurchaseRateSettingsService } from './id-business-v2-purchase-rate-settings.service';
import {
  IdBusinessV2PurchaseRateAutomationRepository,
  type IdBusinessV2PurchaseRateRunRecord
} from './persistence/id-business-v2-purchase-rate-automation.repository';

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const ROUNDING_MODES = ['ROUND_DOWN', 'ROUND_HALF_UP', 'ROUND_UP'] as const;

@Injectable()
export class IdBusinessV2PurchaseRateQueryService {
  constructor(
    private readonly repository: IdBusinessV2PurchaseRateAutomationRepository,
    private readonly settingsService: IdBusinessV2PurchaseRateSettingsService,
    private readonly provider: IdBusinessV2PurchaseRateProviderService
  ) {}

  async getRuntime(local: { tickIntervalMs: number; running: boolean; lastTickAt: Date | null }) {
    const [settings, latestRun, databaseRunning] = await Promise.all([
      this.settingsService.get(),
      this.repository.findLatestRun(),
      this.repository.findRunningRun()
    ]);
    return {
      settings,
      scheduler: {
        schedule: '5 * * * *' as const,
        localTickIntervalMs: local.tickIntervalMs,
        localRunning: local.running,
        lastTickAt: local.lastTickAt,
        databaseRunning: databaseRunning ? this.toRunResponse(databaseRunning, false) : null
      },
      provider: this.provider.getRuntime(),
      latestRun: latestRun ? this.toRunResponse(latestRun, false) : null,
      successBoundary:
        '所有已启用币种必须同时返回有效汇率；任一币种缺失或异常时整批不发布，继续保留上一批有效报价',
      networkEnabled: process.env.ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED !== 'false'
    };
  }

  async listRuns(query: { page?: string; pageSize?: string; status?: string }) {
    const page = this.parsePositiveInteger(query.page, 1, 1, 100_000, '页码');
    const pageSize = this.parsePositiveInteger(query.pageSize, 20, 1, 100, '每页数量');
    const status = this.parseStatus(query.status);
    const [rows, total] = await this.repository.listRuns({
      status,
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return { items: rows.map((row) => this.toRunResponse(row, false)), total, page, pageSize };
  }

  async getRun(id: string) {
    this.assertRunId(id);
    const run = await this.repository.findRun(id);
    if (!run) throw new NotFoundException('收购汇率采集批次不存在');
    return this.toRunResponse(run, true);
  }

  async listSnapshots(query: { page?: string; pageSize?: string; currencyCode?: string }) {
    const page = this.parsePositiveInteger(query.page, 1, 1, 100_000, '页码');
    const pageSize = this.parsePositiveInteger(query.pageSize, 20, 1, 100, '每页数量');
    const currencyCode = query.currencyCode?.trim().toUpperCase() || undefined;
    if (currencyCode && !CURRENCY_CODE_PATTERN.test(currencyCode)) {
      throw new BadRequestException('币种代码格式无效');
    }
    const [rows, total] = await this.repository.listSnapshots({
      currencyCode,
      skip: (page - 1) * pageSize,
      take: pageSize
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        currencyCode: row.currencyCode,
        currencyName: row.currency.displayName || row.currency.nameCn,
        marketRateCnyPerUnit: row.marketRateCnyPerUnit.toString(),
        purchaseRatio: row.purchaseRatio.toString(),
        quoteUnit: row.quoteUnit.toString(),
        purchaseRateRaw: row.purchaseRateRaw.toString(),
        purchaseRateDisplay: row.purchaseRateDisplay.toString(),
        decimalPlaces: row.decimalPlaces,
        roundingMode: row.roundingMode,
        marketRateSource: row.marketRateSource,
        marketRateSourceReference: row.marketRateSourceReference,
        marketRateCapturedAt: row.marketRateCapturedAt,
        fetchRunId: row.fetchRunId,
        changeRate: row.changeRate?.toString() ?? null,
        validationStatus: row.validationStatus,
        createdBy: row.createdBy,
        createdAt: row.createdAt
      })),
      total,
      page,
      pageSize
    };
  }

  parseCandidates(
    value: unknown,
    expectedCurrencyCodes: string[]
  ): IdBusinessV2PurchaseRateCandidateQuote[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ConflictException('异常批次没有可发布的候选报价');
    }
    const candidates = value as Partial<IdBusinessV2PurchaseRateCandidateQuote>[];
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate.currencyCode !== 'string' ||
        !CURRENCY_CODE_PATTERN.test(candidate.currencyCode) ||
        typeof candidate.marketRateCnyPerUnit !== 'string' ||
        typeof candidate.purchaseRateRaw !== 'string' ||
        typeof candidate.purchaseRateDisplay !== 'string' ||
        typeof candidate.purchaseRatio !== 'string' ||
        typeof candidate.quoteUnit !== 'string' ||
        typeof candidate.decimalPlaces !== 'number' ||
        !Number.isInteger(candidate.decimalPlaces) ||
        candidate.decimalPlaces < 0 ||
        candidate.decimalPlaces > 8 ||
        !ROUNDING_MODES.includes(candidate.roundingMode as (typeof ROUNDING_MODES)[number]) ||
        typeof candidate.abnormal !== 'boolean' ||
        !this.isPositiveDecimal(candidate.marketRateCnyPerUnit, 8) ||
        !this.isPositiveDecimal(candidate.providerQuotePerCny) ||
        !this.isPositiveDecimal(candidate.purchaseRatio, 8) ||
        !this.isAtMostOne(candidate.purchaseRatio) ||
        !this.isPositiveDecimal(candidate.quoteUnit, 8) ||
        !this.isPositiveDecimal(candidate.purchaseRateRaw, 8) ||
        !this.isUnsignedDecimal(candidate.purchaseRateDisplay, 8) ||
        (candidate.previousMarketRateCnyPerUnit !== null &&
          !this.isPositiveDecimal(candidate.previousMarketRateCnyPerUnit, 8)) ||
        (candidate.changeRate !== null && !this.isUnsignedDecimal(candidate.changeRate, 8))
      ) {
        throw new ConflictException('异常批次候选报价数据无效');
      }
    }
    const actualCodes = candidates.map((candidate) => candidate.currencyCode as string);
    const expectedCodes = [...new Set(expectedCurrencyCodes)].sort();
    if (
      new Set(actualCodes).size !== actualCodes.length ||
      actualCodes.length !== expectedCodes.length ||
      [...actualCodes].sort().some((code, index) => code !== expectedCodes[index])
    ) {
      throw new ConflictException('异常批次候选币种与原始请求不一致');
    }
    return candidates as IdBusinessV2PurchaseRateCandidateQuote[];
  }

  assertRunId(value: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException('批次编号格式无效');
    }
  }

  toRunResponse(run: IdBusinessV2PurchaseRateRunRecord, includeCandidates: boolean) {
    return {
      id: run.id,
      status: run.status,
      triggerType: run.triggerType,
      provider: run.provider,
      baseCurrency: run.baseCurrency,
      requestedCurrencyCodes: run.requestedCurrencyCodes,
      abnormalCurrencyCodes: run.abnormalCurrencyCodes,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      providerUpdatedAt: run.providerUpdatedAt,
      publishedAt: run.publishedAt,
      attemptCount: run.attemptCount,
      sourceContract: run.sourceContract,
      sourceReference: run.sourceReference,
      maximumChangeRate: run.maximumChangeRate?.toString() ?? null,
      error: run.errorCode
        ? { code: run.errorCode, message: run.errorMessage, retryable: run.errorRetryable }
        : null,
      triggeredBy: run.triggeredBy,
      reviewedBy: run.reviewedBy,
      reviewedAt: run.reviewedAt,
      reviewRemark: run.reviewRemark,
      snapshotCount: run._count.snapshots,
      candidateQuotes: includeCandidates ? run.candidateQuotes : undefined,
      createdAt: run.createdAt
    };
  }

  private parsePositiveInteger(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string
  ) {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return parsed;
  }

  private parseStatus(value: string | undefined) {
    if (!value) return undefined;
    const allowed = ['running', 'success', 'failed', 'pending_review', 'rejected'] as const;
    if (!allowed.includes(value as (typeof allowed)[number])) {
      throw new BadRequestException('批次状态无效');
    }
    return value as (typeof allowed)[number];
  }

  private isUnsignedDecimal(value: unknown, maximumFractionDigits?: number) {
    if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return false;
    const fractionDigits = value.split('.')[1]?.length ?? 0;
    return maximumFractionDigits === undefined || fractionDigits <= maximumFractionDigits;
  }

  private isPositiveDecimal(value: unknown, maximumFractionDigits?: number) {
    if (!this.isUnsignedDecimal(value, maximumFractionDigits)) return false;
    return BigInt((value as string).replace('.', '')) > 0n;
  }

  private isAtMostOne(value: string) {
    const [integer, fraction = ''] = value.split('.');
    return BigInt(`${integer}${fraction}`) <= 10n ** BigInt(fraction.length);
  }
}
