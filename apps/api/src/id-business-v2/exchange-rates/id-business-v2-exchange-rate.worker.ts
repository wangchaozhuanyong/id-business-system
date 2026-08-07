import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Rate8,
  toKualaLumpurBusinessDate,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type Amount4,
  type V2JsonDocument
} from '../runtime/public-api';
import {
  IdBusinessV2ExchangeRatePersistenceService,
  IdBusinessV2ExchangeRateRunError
} from './id-business-v2-exchange-rate-persistence.service';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

const TICK_MS = 30_000;
const STALE_RUN_MS = 5 * 60_000;
type TrackedFxCurrency = 'MYR' | 'USD' | 'USDT';
type CurrencyCollectionResult =
  | {
      currency: TrackedFxCurrency;
      status: 'success';
      source: 'combined_p2p' | 'ecb_cross';
      snapshotId: string;
      rateToCny: string;
      capturedAt: Date;
      expiresAt: Date;
      exchangeRateRunId?: string;
      exchangeRateSnapshotId?: string;
      validSampleCount?: number;
    }
  | {
      currency: TrackedFxCurrency;
      status: 'failed';
      error: {
        code: string;
        message: string;
        provider: 'binance' | 'okx' | 'multiple' | 'system';
        side: 'merchant_buy' | 'merchant_sell' | null;
        retryable: boolean;
      };
    };

@Injectable()
export class IdBusinessV2ExchangeRateWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2ExchangeRateWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: Date | null = null;

  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly settingsService: IdBusinessV2ExchangeRateSettingsService,
    private readonly persistenceService: IdBusinessV2ExchangeRatePersistenceService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  onModuleInit() {
    if (process.env.CLOUDFLARE_WORKER === 'true' || process.env.SUPABASE_EDGE_FUNCTION === 'true') {
      this.logger.warn('V2 汇率进程内定时器在 Edge Runtime 中禁用，请使用数据库 Cron');
      return;
    }
    if (!this.settingsService.isNetworkEnabled()) {
      this.logger.warn('V2 汇率网络采集已被环境紧急开关关闭');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    if (process.env.ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP !== 'false') {
      void this.tick();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collectManual(operator?: AuthenticatedUser, requestId = 'exchange-rate-manual-collect') {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    this.assertNetworkEnabled();
    await this.recoverStaleRuns();
    const settings = await this.settingsService.getRecord();
    return this.collectAllCurrencies({
      triggerType: 'manual',
      targetAmountRmb: settings.targetAmountRmb,
      intervalMinutes: settings.intervalMinutes,
      triggeredByUserId: operator.id,
      requestId
    });
  }

  async collectSystem(requestId = 'exchange-rate-system-collect') {
    this.assertNetworkEnabled();
    await this.recoverStaleRuns();
    const settings = await this.settingsService.getRecord();
    return this.collectAllCurrencies({
      triggerType: 'system',
      targetAmountRmb: settings.targetAmountRmb,
      intervalMinutes: settings.intervalMinutes,
      requestId
    });
  }

  async getRuntime() {
    const [settings, databaseRunning] = await Promise.all([
      this.settingsService.get(),
      this.repository.findRunningRun()
    ]);
    return {
      settings,
      scheduler: {
        tickIntervalMs: TICK_MS,
        localRunning: this.running,
        lastTickAt: this.lastTickAt,
        databaseRunning: databaseRunning
          ? {
              ...databaseRunning,
              targetAmountRmb: databaseRunning.targetAmountRmb?.toString() ?? null
            }
          : null
      },
      providers: [
        {
          code: 'binance',
          source: 'https://p2p.binance.com/',
          contract: 'binance-p2p-friendly-adv-search-v2'
        },
        {
          code: 'okx',
          source: 'https://www.okx.com/',
          contract: 'okx-public-trading-orders-books-v3'
        },
        {
          code: 'ecb',
          source: 'https://data-api.ecb.europa.eu/',
          contract: 'ecb-exr-reference-cross-rate'
        }
      ],
      successBoundary:
        'USDT 需要 Binance 与 OKX 四方向有效样本；MYR 与 USD 使用 ECB 参考交叉汇率，各币种独立记录成功或失败',
      retention: {
        days: settings.retentionDays,
        preservesReferencedSnapshots: true
      }
    };
  }

  async tick() {
    try {
      const result = await this.runScheduled();
      if (result.status === 'failed' || result.status === 'partial_failed') {
        this.logger.warn(`定时汇率采集未全部成功：${result.failedCurrencies.join(', ')}`);
      }
    } catch (error) {
      if (error instanceof IdBusinessV2ExchangeRateRunError) {
        this.logger.warn(`定时汇率采集失败：${error.code}`);
      } else {
        this.logger.warn('定时汇率采集未执行或发生未分类错误');
      }
    }
  }

  async runScheduled() {
    this.lastTickAt = new Date();
    if (this.running) {
      return {
        status: 'skipped' as const,
        reason: 'local_run_active' as const
      };
    }
    this.assertNetworkEnabled();
    if (!process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('汇率采集缺少数据库连接');
    }

    this.running = true;
    try {
      await this.recoverStaleRuns();
      const claimed = await this.settingsService.claimDueSchedule('exchange-rate-scheduled-claim');
      if (!claimed) {
        return {
          status: 'skipped' as const,
          reason: 'not_due' as const
        };
      }
      return this.collectAllCurrencies({
        triggerType: 'scheduled',
        targetAmountRmb: claimed.targetAmountRmb,
        intervalMinutes: claimed.intervalMinutes,
        requestId: 'exchange-rate-scheduled-collect'
      });
    } finally {
      this.running = false;
    }
  }

  private async collectAllCurrencies(input: {
    triggerType: 'manual' | 'scheduled' | 'system';
    targetAmountRmb: Amount4;
    intervalMinutes: number;
    triggeredByUserId?: string;
    requestId: string;
  }) {
    const usdtResult = await this.collectUsdtP2p(input);
    const collection = await this.collectFinanceSnapshots({
      ...input,
      usdtResult: usdtResult.status === 'success' ? usdtResult.result : undefined
    });
    if (usdtResult.status === 'failed') {
      collection.push({
        currency: 'USDT',
        status: 'failed',
        error: usdtResult.error
      });
    }
    return this.collectionResponse(collection);
  }

  private async collectUsdtP2p(input: {
    triggerType: 'manual' | 'scheduled' | 'system';
    targetAmountRmb: Amount4;
    triggeredByUserId?: string;
    requestId: string;
  }) {
    try {
      return {
        status: 'success' as const,
        result: await this.persistenceService.collectAndPersist({
          triggerType: input.triggerType,
          targetAmountRmb: input.targetAmountRmb,
          triggeredByUserId: input.triggeredByUserId,
          requestId: input.requestId
        })
      };
    } catch (error) {
      if (error instanceof IdBusinessV2ExchangeRateRunError) {
        return {
          status: 'failed' as const,
          error: {
            code: error.code,
            message: error.message,
            provider: error.provider,
            side: error.side,
            retryable: error.retryable
          }
        };
      }
      return {
        status: 'failed' as const,
        error: {
          code: 'exchange_rate_usdt_unexpected_failure',
          message: error instanceof Error ? error.message : 'USDT 汇率采集失败',
          provider: 'system' as const,
          side: null,
          retryable: true
        }
      };
    }
  }

  private async collectFinanceSnapshots(input: {
    triggerType: 'manual' | 'scheduled' | 'system';
    intervalMinutes: number;
    triggeredByUserId?: string;
    requestId: string;
    usdtResult?: Awaited<
      ReturnType<IdBusinessV2ExchangeRatePersistenceService['collectAndPersist']>
    >;
  }) {
    const tasks: Array<Promise<CurrencyCollectionResult>> = [];
    if (input.usdtResult) {
      tasks.push(this.createUsdtFinanceSnapshot(input.usdtResult, input));
    }
    tasks.push(this.collectEcbCrossRate('MYR', input), this.collectEcbCrossRate('USD', input));
    return Promise.all(tasks);
  }

  private async createUsdtFinanceSnapshot(
    result: Awaited<ReturnType<IdBusinessV2ExchangeRatePersistenceService['collectAndPersist']>>,
    input: {
      triggerType: 'manual' | 'scheduled' | 'system';
      intervalMinutes: number;
      triggeredByUserId?: string;
      requestId: string;
    }
  ): Promise<CurrencyCollectionResult> {
    try {
      const capturedAt = result.averagedAt;
      const expiresAt = this.expiresAt(capturedAt, input.intervalMinutes);
      const snapshot = await this.createFinanceSnapshot({
        currency: 'USDT',
        rateToCny: result.midRateToRmb,
        source: 'combined_p2p',
        sourceReference: result.snapshotId,
        sourceEvidence: {
          exchangeRateRunId: result.runId,
          exchangeRateSnapshotId: result.snapshotId,
          averagedAt: result.averagedAt.toISOString()
        },
        businessDate: toKualaLumpurBusinessDate(capturedAt).date,
        capturedAt,
        expiresAt,
        triggeredByUserId: input.triggeredByUserId,
        requestId: `${input.requestId}-finance-usdt`
      });
      return {
        currency: 'USDT',
        status: 'success',
        source: 'combined_p2p',
        snapshotId: snapshot.id,
        rateToCny: snapshot.rateToCny,
        capturedAt,
        expiresAt,
        exchangeRateRunId: result.runId,
        exchangeRateSnapshotId: result.snapshotId,
        validSampleCount: result.validSampleCount
      };
    } catch (error) {
      return this.failedCurrency('USDT', error);
    }
  }

  private async collectEcbCrossRate(
    currency: 'MYR' | 'USD',
    input: {
      triggerType: 'manual' | 'scheduled' | 'system';
      intervalMinutes: number;
      triggeredByUserId?: string;
      requestId: string;
    }
  ): Promise<CurrencyCollectionResult> {
    try {
      const [cny, quote] = await Promise.all([
        this.fetchEcbReferenceRate('CNY'),
        this.fetchEcbReferenceRate(currency)
      ]);
      if (cny.businessDate !== quote.businessDate) {
        throw new ServiceUnavailableException(`ECB CNY 与 ${currency} 参考汇率日期不一致`);
      }
      const capturedAt = new Date();
      const rateToCny = cny.rate.div(quote.rate).toString();
      const expiresAt = this.expiresAt(capturedAt, input.intervalMinutes);
      const snapshot = await this.createFinanceSnapshot({
        currency,
        rateToCny,
        source: 'ecb_cross',
        sourceReference: `ECB EXR.D.CNY.EUR.SP00.A / EXR.D.${currency}.EUR.SP00.A`,
        sourceEvidence: {
          cnyPerEur: cny.rate.toString(),
          quotePerEur: quote.rate.toString(),
          quoteCurrency: currency,
          referenceDate: cny.businessDate
        },
        businessDate: new Date(`${cny.businessDate}T00:00:00.000Z`),
        capturedAt,
        expiresAt,
        triggeredByUserId: input.triggeredByUserId,
        requestId: `${input.requestId}-finance-${currency.toLowerCase()}`
      });
      return {
        currency,
        status: 'success',
        source: 'ecb_cross',
        snapshotId: snapshot.id,
        rateToCny: snapshot.rateToCny,
        capturedAt,
        expiresAt
      };
    } catch (error) {
      return this.failedCurrency(currency, error);
    }
  }

  private async createFinanceSnapshot(input: {
    currency: TrackedFxCurrency;
    rateToCny: string;
    source: 'combined_p2p' | 'ecb_cross';
    sourceReference: string;
    sourceEvidence: V2JsonDocument;
    businessDate: Date;
    capturedAt: Date;
    expiresAt: Date;
    triggeredByUserId?: string;
    requestId: string;
  }) {
    return this.transactionManager.execute(
      async (tx) => {
        const snapshot = await this.repository.createFinanceFxRateSnapshot(tx, {
          id: randomUUID(),
          currency: input.currency,
          rateToCny: input.rateToCny,
          source: input.source,
          sourceReference: input.sourceReference,
          sourceEvidence: input.sourceEvidence,
          businessDate: input.businessDate,
          capturedAt: input.capturedAt,
          expiresAt: input.expiresAt,
          createdByUserId: input.triggeredByUserId
        });
        await this.audit.append(tx, {
          userId: input.triggeredByUserId,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.fx_snapshot.collect',
          objectType: 'id_business_v2_finance_fx_rate_snapshot',
          objectId: snapshot.id,
          afterData: {
            currency: input.currency,
            rateToCny: input.rateToCny,
            source: input.source,
            sourceReference: input.sourceReference,
            capturedAt: input.capturedAt.toISOString(),
            expiresAt: input.expiresAt.toISOString()
          },
          remark: 'V2 自动汇率按币种快照已保存'
        });
        return snapshot;
      },
      { requestId: `${input.requestId}-${randomUUID()}`, retryMode: 'none' }
    );
  }

  private async fetchEcbReferenceRate(currency: 'CNY' | 'MYR' | 'USD') {
    const url =
      `https://data-api.ecb.europa.eu/service/data/EXR/D.${currency}.EUR.SP00.A` +
      '?format=csvdata&detail=dataonly&lastNObservations=1';
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'text/csv' } });
    } catch {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 汇率采集失败`);
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 返回 ${response.status}`);
    }
    const csv = await response.text();
    const lines = csv.trim().split(/\r?\n/);
    const headers = this.parseCsvLine(lines[0] ?? '');
    const values = this.parseCsvLine(lines.at(-1) ?? '');
    const dateIndex = headers.indexOf('TIME_PERIOD');
    const valueIndex = headers.indexOf('OBS_VALUE');
    const businessDate = values[dateIndex]?.trim();
    const value = values[valueIndex]?.trim();
    if (!businessDate || !value) {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 响应缺少有效数据`);
    }
    return { businessDate, rate: Rate8.from(value) };
  }

  private parseCsvLine(line: string) {
    const values: string[] = [];
    let current = '';
    let quoted = false;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (character === ',' && !quoted) {
        values.push(current);
        current = '';
      } else current += character;
    }
    values.push(current);
    return values;
  }

  private collectionResponse(results: CurrencyCollectionResult[]) {
    const success = results.filter((item) => item.status === 'success');
    const failed = results.filter((item) => item.status === 'failed');
    return {
      status:
        failed.length === 0
          ? ('success' as const)
          : success.length > 0
            ? ('partial_failed' as const)
            : ('failed' as const),
      successfulCurrencies: success.map((item) => item.currency),
      failedCurrencies: failed.map((item) => item.currency),
      results
    };
  }

  private failedCurrency(currency: TrackedFxCurrency, error: unknown): CurrencyCollectionResult {
    if (error instanceof IdBusinessV2ExchangeRateRunError) {
      return {
        currency,
        status: 'failed',
        error: {
          code: error.code,
          message: error.message,
          provider: error.provider,
          side: error.side,
          retryable: error.retryable
        }
      };
    }
    return {
      currency,
      status: 'failed',
      error: {
        code: `exchange_rate_${currency.toLowerCase()}_collection_failed`,
        message: error instanceof Error ? error.message : `${currency} 汇率采集失败`,
        provider: 'system',
        side: null,
        retryable: true
      }
    };
  }

  private expiresAt(capturedAt: Date, intervalMinutes: number) {
    return new Date(capturedAt.getTime() + intervalMinutes * 60_000 + 2 * 60_000);
  }

  private async recoverStaleRuns() {
    const staleBefore = new Date(Date.now() - STALE_RUN_MS);
    const staleRuns = await this.repository.findStaleRuns(staleBefore);
    for (const run of staleRuns) {
      await this.transactionManager.execute(
        async (tx) => {
          const updated = await this.repository.recoverStaleRun(tx, run, new Date());
          if (updated.count > 0) {
            await this.audit.append(tx, {
              module: 'id_business_v2',
              action: 'id_business_v2.exchange_rate.collect.stale_recovered',
              objectType: 'id_business_v2_exchange_rate_run',
              objectId: run.id,
              afterData: { status: 'failed', errorCode: 'exchange_rate_stale_run_recovered' },
              remark: '汇率采集超时批次已关闭'
            });
          }
        },
        { requestId: `exchange-rate-stale-${run.id}`, retryMode: 'none' }
      );
    }
  }

  private assertNetworkEnabled() {
    if (process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE === 'true') {
      throw new ServiceUnavailableException('当前运行模式未启用自动汇率采集');
    }
    if (!this.settingsService.isNetworkEnabled()) {
      throw new ServiceUnavailableException('汇率网络采集已被环境紧急开关关闭');
    }
  }
}
