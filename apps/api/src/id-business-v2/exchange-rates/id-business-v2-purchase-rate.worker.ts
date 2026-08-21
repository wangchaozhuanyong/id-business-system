import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { calculateV2PurchaseRate, divideDecimalStrings } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  mapStringArray
} from '../runtime/public-api';
import { IdBusinessV2PurchaseRateProviderService } from './id-business-v2-purchase-rate-provider.service';
import {
  IdBusinessV2PurchaseRateProviderError,
  type IdBusinessV2PurchaseRateCandidateQuote
} from './id-business-v2-purchase-rate-provider.types';
import { IdBusinessV2PurchaseRateQueryService } from './id-business-v2-purchase-rate-query.service';
import { IdBusinessV2PurchaseRateSettingsService } from './id-business-v2-purchase-rate-settings.service';
import {
  IdBusinessV2PurchaseRateAutomationRepository,
  IdBusinessV2PurchaseRateRunLockedError,
  type IdBusinessV2PurchaseRateSettingsRecord
} from './persistence/id-business-v2-purchase-rate-automation.repository';

const LOCAL_TICK_MS = 30_000;
const STALE_RUN_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1_500] as const;

@Injectable()
export class IdBusinessV2PurchaseRateWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2PurchaseRateWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private localRunning = false;
  private lastTickAt: Date | null = null;

  constructor(
    private readonly repository: IdBusinessV2PurchaseRateAutomationRepository,
    private readonly settingsService: IdBusinessV2PurchaseRateSettingsService,
    private readonly provider: IdBusinessV2PurchaseRateProviderService,
    private readonly queryService: IdBusinessV2PurchaseRateQueryService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  onModuleInit() {
    if (process.env.CLOUDFLARE_WORKER === 'true' || process.env.SUPABASE_EDGE_FUNCTION === 'true') {
      this.logger.warn('收购汇率进程内定时器在 Edge Runtime 中禁用，请使用数据库 Cron');
      return;
    }
    if (!this.isNetworkEnabled()) {
      this.logger.warn('收购汇率网络采集已被环境紧急开关关闭');
      return;
    }
    this.timer = setInterval(() => void this.tick(), LOCAL_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    try {
      const result = await this.runScheduled();
      if (result.status === 'failed') this.logger.warn(`收购汇率定时采集失败：${result.errorCode}`);
    } catch {
      this.logger.warn('收购汇率定时采集发生未分类错误');
    }
  }

  async runScheduled() {
    this.lastTickAt = new Date();
    if (this.localRunning)
      return { status: 'skipped' as const, reason: 'local_run_active' as const };
    if (!this.isNetworkEnabled()) {
      return { status: 'skipped' as const, reason: 'network_disabled' as const };
    }
    if (!process.env.DATABASE_URL) {
      throw new ServiceUnavailableException('收购汇率采集缺少数据库连接');
    }

    this.localRunning = true;
    try {
      await this.settingsService.getRecord();
      return await this.collect({
        triggerType: 'scheduled',
        requestId: 'purchase-rate-scheduled-collect'
      });
    } finally {
      this.localRunning = false;
    }
  }

  async collectManual(operator?: AuthenticatedUser, requestId = 'purchase-rate-manual-collect') {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!this.isNetworkEnabled()) throw new ServiceUnavailableException('收购汇率网络采集已关闭');
    if (!process.env.DATABASE_URL)
      throw new ServiceUnavailableException('收购汇率采集缺少数据库连接');
    await this.settingsService.getRecord();
    return this.collect({
      triggerType: 'manual',
      triggeredByUserId: operator.id,
      operator,
      requestId
    });
  }

  async getRuntime() {
    return this.queryService.getRuntime({
      tickIntervalMs: LOCAL_TICK_MS,
      running: this.localRunning,
      lastTickAt: this.lastTickAt
    });
  }

  async confirmRun(
    id: string,
    input: { remark?: string | null },
    operator?: AuthenticatedUser,
    requestId = 'purchase-rate-review-confirm'
  ) {
    return this.reviewRun(id, true, input.remark, operator, requestId);
  }

  async rejectRun(
    id: string,
    input: { remark?: string | null },
    operator?: AuthenticatedUser,
    requestId = 'purchase-rate-review-reject'
  ) {
    return this.reviewRun(id, false, input.remark, operator, requestId);
  }

  private async collect(input: {
    triggerType: 'manual' | 'scheduled' | 'system';
    triggeredByUserId?: string;
    operator?: AuthenticatedUser;
    requestId: string;
  }) {
    let started:
      | {
          status: 'started';
          runId: string;
          settings: IdBusinessV2PurchaseRateSettingsRecord;
          currencies: Awaited<
            ReturnType<IdBusinessV2PurchaseRateAutomationRepository['listEnabledCurrencies']>
          >;
        }
      | { status: 'skipped'; reason: 'not_due' | 'already_running' };
    try {
      started = await this.transactionManager.execute(
        async (tx) => {
          const now = new Date();
          const recovered = await this.repository.recoverStaleRuns(
            tx,
            new Date(now.getTime() - STALE_RUN_MS),
            now
          );
          if (recovered.count > 0) {
            await this.audit.append(tx, {
              module: 'id_business_v2',
              action: 'id_business_v2.exchange_rate.purchase_rate.run.recover',
              objectType: 'id_business_v2_purchase_rate_fetch_run',
              afterData: { recoveredCount: recovered.count },
              remark: '收购汇率超时任务已关闭并释放数据库锁'
            });
          }

          const settings =
            input.triggerType === 'scheduled'
              ? await this.repository.claimDueSettings(tx)
              : await this.repository.findSettingsInTransaction(tx);
          if (!settings) return { status: 'skipped' as const, reason: 'not_due' as const };
          const currencies = await this.repository.listEnabledCurrencies(tx);
          if (currencies.length === 0) throw new BadRequestException('没有已启用的收购报价币种');
          const runId = randomUUID();
          await this.repository.createRun(tx, {
            id: runId,
            triggerType: input.triggerType,
            requestedCurrencyCodes: currencies.map((currency) => currency.code),
            startedAt: now,
            triggeredByUserId: input.triggeredByUserId
          });
          await this.audit.append(tx, {
            userId: input.triggeredByUserId,
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.purchase_rate.run.start',
            objectType: 'id_business_v2_purchase_rate_fetch_run',
            objectId: runId,
            afterData: {
              triggerType: input.triggerType,
              provider: 'currencyapi',
              currencyCodes: currencies.map((currency) => currency.code)
            },
            remark: '收购汇率采集任务开始'
          });
          return { status: 'started' as const, runId, settings, currencies };
        },
        { requestId: `${input.requestId}-start`, operator: input.operator, retryMode: 'none' }
      );
    } catch (error) {
      if (error instanceof IdBusinessV2PurchaseRateRunLockedError) {
        return { status: 'skipped' as const, reason: 'already_running' as const };
      }
      throw error;
    }

    if (started.status === 'skipped') return started;

    let attempts = 0;
    try {
      const fetched = await this.fetchWithRetry(
        started.currencies.map((currency) => currency.code),
        (count) => {
          attempts = count;
        }
      );
      const providerStaleBefore = Date.now() - started.settings.staleMinutes * 60_000;
      if (fetched.providerUpdatedAt.getTime() <= providerStaleBefore) {
        throw new IdBusinessV2PurchaseRateProviderError(
          'purchase_rate_provider_stale_data',
          '自动汇率供应商返回的数据已超过有效时限',
          false
        );
      }
      const candidates = started.currencies.map((currency) => {
        const quotePerCny = fetched.quotePerCny[currency.code];
        if (!quotePerCny) throw new Error(`供应商缺少 ${currency.code} 汇率`);
        const marketRateCnyPerUnit = divideDecimalStrings('1', quotePerCny, 8);
        const calculation = calculateV2PurchaseRate({
          marketRateCnyPerUnit,
          purchaseRatio: currency.purchaseRatio.toString(),
          quoteUnit: currency.quoteUnit.toString(),
          decimalPlaces: currency.decimalPlaces,
          roundingMode: currency.roundingMode
        });
        const previousMarketRateCnyPerUnit =
          currency.snapshots[0]?.marketRateCnyPerUnit.toString() ?? null;
        const changeRate = previousMarketRateCnyPerUnit
          ? Rate8.from(marketRateCnyPerUnit)
              .sub(previousMarketRateCnyPerUnit)
              .abs()
              .div(previousMarketRateCnyPerUnit)
              .toString()
          : null;
        return {
          currencyCode: currency.code,
          marketRateCnyPerUnit,
          providerQuotePerCny: quotePerCny,
          purchaseRatio: currency.purchaseRatio.toString(),
          quoteUnit: currency.quoteUnit.toString(),
          purchaseRateRaw: calculation.purchaseRateRaw,
          purchaseRateDisplay: calculation.purchaseRateDisplay,
          decimalPlaces: currency.decimalPlaces,
          roundingMode: currency.roundingMode,
          previousMarketRateCnyPerUnit,
          changeRate,
          abnormal: changeRate
            ? Rate8.from(changeRate).gt(started.settings.abnormalChangeRate)
            : false
        } satisfies IdBusinessV2PurchaseRateCandidateQuote;
      });
      const abnormalCurrencyCodes = candidates
        .filter((candidate) => candidate.abnormal)
        .map((candidate) => candidate.currencyCode);
      const maximumChangeRate = candidates.reduce(
        (maximum, candidate) =>
          candidate.changeRate && Rate8.from(candidate.changeRate).gt(maximum)
            ? Rate8.from(candidate.changeRate)
            : maximum,
        Rate8.zero()
      );
      const finishedAt = new Date();

      if (abnormalCurrencyCodes.length > 0) {
        await this.transactionManager.execute(
          async (tx) => {
            const held = await this.repository.markRunPendingReview(tx, started.runId, {
              finishedAt,
              attemptCount: attempts,
              providerUpdatedAt: fetched.providerUpdatedAt,
              sourceContract: fetched.sourceContract,
              sourceReference: fetched.sourceReference,
              candidateQuotes: candidates,
              abnormalCurrencyCodes,
              maximumChangeRate: maximumChangeRate.toString()
            });
            if (held.count !== 1) {
              throw new ConflictException('采集批次已超时关闭，候选报价不再发布');
            }
            await this.audit.append(tx, {
              module: 'id_business_v2',
              action: 'id_business_v2.exchange_rate.purchase_rate.run.pending_review',
              objectType: 'id_business_v2_purchase_rate_fetch_run',
              objectId: started.runId,
              afterData: {
                abnormalCurrencyCodes,
                maximumChangeRate: maximumChangeRate.toString(),
                threshold: started.settings.abnormalChangeRate.toString()
              },
              remark: '收购汇率异常波动，整批暂停发布并等待管理员审核'
            });
          },
          { requestId: `${input.requestId}-pending-review`, retryMode: 'none' }
        );
        return {
          status: 'pending_review' as const,
          runId: started.runId,
          abnormalCurrencyCodes,
          retainedPreviousQuotes: true
        };
      }

      const published = await this.publishCandidates({
        runId: started.runId,
        candidates,
        attemptCount: attempts,
        providerUpdatedAt: fetched.providerUpdatedAt,
        sourceContract: fetched.sourceContract,
        sourceReference: fetched.sourceReference,
        maximumChangeRate: maximumChangeRate.toString(),
        createdByUserId: input.triggeredByUserId,
        requestId: `${input.requestId}-publish`,
        operator: input.operator,
        auditAction: 'id_business_v2.exchange_rate.purchase_rate.run.publish',
        auditRemark: '收购汇率采集批次已原子发布'
      });
      return {
        status: 'success' as const,
        runId: published.id,
        publishedCurrencyCount: candidates.length,
        providerUpdatedAt: fetched.providerUpdatedAt
      };
    } catch (error) {
      const failure = this.providerFailure(error);
      await this.transactionManager.execute(
        async (tx) => {
          const failed = await this.repository.markRunFailed(tx, started.runId, {
            finishedAt: new Date(),
            attemptCount: attempts,
            errorCode: failure.code,
            errorMessage: failure.message,
            errorRetryable: failure.retryable
          });
          if (failed.count === 0) return;
          await this.audit.append(tx, {
            userId: input.triggeredByUserId,
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.purchase_rate.run.fail',
            objectType: 'id_business_v2_purchase_rate_fetch_run',
            objectId: started.runId,
            afterData: {
              errorCode: failure.code,
              errorRetryable: failure.retryable,
              attemptCount: attempts
            },
            remark: '收购汇率采集失败，继续保留上一批有效报价'
          });
        },
        { requestId: `${input.requestId}-fail`, operator: input.operator, retryMode: 'none' }
      );
      return {
        status: 'failed' as const,
        runId: started.runId,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        retainedPreviousQuotes: true
      };
    }
  }

  private async reviewRun(
    id: string,
    confirm: boolean,
    remarkValue: string | null | undefined,
    operator: AuthenticatedUser | undefined,
    requestId: string
  ) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    this.queryService.assertRunId(id);
    const remark = this.normalizeRemark(remarkValue);
    const result = await this.transactionManager.execute(
      async (tx) => {
        const run = await this.repository.findRunInTransaction(tx, id);
        if (!run) throw new NotFoundException('收购汇率采集批次不存在');
        if (run.status !== 'pending_review') {
          throw new ConflictException('该批次已不处于待审核状态');
        }
        const abnormalCurrencyCodes = mapStringArray(
          run.abnormalCurrencyCodes,
          'id_business_v2_purchase_rate_fetch_runs.abnormal_currency_codes'
        );
        const requestedCurrencyCodes = mapStringArray(
          run.requestedCurrencyCodes,
          'id_business_v2_purchase_rate_fetch_runs.requested_currency_codes'
        );
        const reviewedAt = new Date();
        if (!confirm) {
          const rejected = await this.repository.rejectRun(tx, id, {
            reviewedByUserId: operator.id,
            reviewedAt,
            reviewRemark: remark
          });
          if (rejected.count !== 1) throw new ConflictException('该批次已被其他管理员处理');
          await this.audit.append(tx, {
            userId: operator.id,
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.purchase_rate.review.reject',
            objectType: 'id_business_v2_purchase_rate_fetch_run',
            objectId: id,
            afterData: { abnormalCurrencyCodes, remark },
            remark: '异常收购汇率批次已驳回，未发布候选报价'
          });
          return { status: 'rejected' as const };
        }

        const candidates = this.queryService.parseCandidates(
          run.candidateQuotes,
          requestedCurrencyCodes
        );
        if (!run.providerUpdatedAt || !run.sourceContract || !run.sourceReference) {
          throw new ConflictException('该异常批次缺少可发布的供应商证据');
        }
        const claimed = await this.repository.claimPendingReview(tx, id, {
          reviewedByUserId: operator.id,
          reviewedAt,
          reviewRemark: remark
        });
        if (claimed.count !== 1) throw new ConflictException('该批次已被其他管理员处理');
        await this.repository.publishRun(tx, id, {
          finishedAt: run.finishedAt ?? reviewedAt,
          providerUpdatedAt: run.providerUpdatedAt,
          attemptCount: run.attemptCount,
          sourceContract: run.sourceContract,
          sourceReference: run.sourceReference,
          maximumChangeRate: run.maximumChangeRate?.toString() ?? null,
          candidateQuotes: candidates,
          snapshots: this.snapshotInputs(
            id,
            candidates,
            run.providerUpdatedAt,
            operator.id,
            true,
            run.sourceReference
          ),
          reviewedByUserId: operator.id,
          reviewedAt,
          reviewRemark: remark
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.purchase_rate.review.confirm',
          objectType: 'id_business_v2_purchase_rate_fetch_run',
          objectId: id,
          afterData: {
            abnormalCurrencyCodes,
            publishedCurrencyCount: candidates.length,
            remark
          },
          remark: '异常收购汇率批次已人工确认并原子发布'
        });
        return { status: 'success' as const, publishedCurrencyCount: candidates.length };
      },
      { requestId, operator, retryMode: 'none' }
    );
    return { run: await this.queryService.getRun(id), review: result };
  }

  private publishCandidates(input: {
    runId: string;
    candidates: IdBusinessV2PurchaseRateCandidateQuote[];
    attemptCount: number;
    providerUpdatedAt: Date;
    sourceContract: string;
    sourceReference: string;
    maximumChangeRate: string | null;
    createdByUserId?: string;
    requestId: string;
    operator?: AuthenticatedUser;
    auditAction: string;
    auditRemark: string;
  }) {
    return this.transactionManager.execute(
      async (tx) => {
        const finishedAt = new Date();
        const claimed = await this.repository.claimRunningForPublish(tx, input.runId);
        if (claimed.count !== 1) {
          throw new ConflictException('采集批次已超时关闭，结果不再发布');
        }
        const published = await this.repository.publishRun(tx, input.runId, {
          finishedAt,
          providerUpdatedAt: input.providerUpdatedAt,
          attemptCount: input.attemptCount,
          sourceContract: input.sourceContract,
          sourceReference: input.sourceReference,
          maximumChangeRate: input.maximumChangeRate,
          candidateQuotes: input.candidates,
          snapshots: this.snapshotInputs(
            input.runId,
            input.candidates,
            input.providerUpdatedAt,
            input.createdByUserId,
            false,
            input.sourceReference
          )
        });
        await this.audit.append(tx, {
          userId: input.createdByUserId,
          module: 'id_business_v2',
          action: input.auditAction,
          objectType: 'id_business_v2_purchase_rate_fetch_run',
          objectId: input.runId,
          afterData: {
            publishedCurrencyCount: input.candidates.length,
            providerUpdatedAt: input.providerUpdatedAt.toISOString(),
            maximumChangeRate: input.maximumChangeRate
          },
          remark: input.auditRemark
        });
        return published;
      },
      { requestId: input.requestId, operator: input.operator, retryMode: 'none' }
    );
  }

  private snapshotInputs(
    runId: string,
    candidates: IdBusinessV2PurchaseRateCandidateQuote[],
    providerUpdatedAt: Date,
    createdByUserId: string | undefined,
    confirmed: boolean,
    sourceReference = 'https://api.currencyapi.com/v3/latest?base_currency=CNY'
  ) {
    return candidates.map((candidate) => ({
      id: randomUUID(),
      currencyCode: candidate.currencyCode,
      marketRateCnyPerUnit: candidate.marketRateCnyPerUnit,
      purchaseRatio: candidate.purchaseRatio,
      quoteUnit: candidate.quoteUnit,
      purchaseRateRaw: candidate.purchaseRateRaw,
      purchaseRateDisplay: candidate.purchaseRateDisplay,
      decimalPlaces: candidate.decimalPlaces,
      roundingMode: candidate.roundingMode,
      marketRateSource: 'currencyapi' as const,
      marketRateSourceReference: sourceReference,
      marketRateCapturedAt: providerUpdatedAt,
      fetchRunId: runId,
      changeRate: candidate.changeRate,
      validationStatus:
        confirmed && candidate.abnormal ? ('confirmed_abnormal' as const) : ('normal' as const),
      createdByUserId
    }));
  }

  private async fetchWithRetry(currencyCodes: string[], onAttempt: (attempt: number) => void) {
    let latestError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      onAttempt(attempt);
      try {
        return await this.provider.fetchLatest(currencyCodes);
      } catch (error) {
        latestError = error;
        if (
          !(error instanceof IdBusinessV2PurchaseRateProviderError) ||
          !error.retryable ||
          attempt === MAX_ATTEMPTS
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      }
    }
    throw latestError;
  }

  private providerFailure(error: unknown) {
    if (error instanceof IdBusinessV2PurchaseRateProviderError) {
      return { code: error.code, message: error.message, retryable: error.retryable };
    }
    return {
      code: 'purchase_rate_unexpected_failure',
      message: error instanceof Error ? error.message : '收购汇率采集发生未分类错误',
      retryable: true
    };
  }

  private normalizeRemark(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length > 500) throw new BadRequestException('审核说明不能超过 500 个字符');
    return normalized || null;
  }

  private isNetworkEnabled() {
    return process.env.ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED !== 'false';
  }
}
