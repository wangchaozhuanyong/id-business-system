import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { V2_FINANCE_CURRENCIES } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  IdBusinessV2ExchangeRateOrderQuoteService,
  IdBusinessV2PurchaseRateProviderService
} from '../exchange-rates/public-api';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandContext,
  type V2CommandTransaction,
  type V2DecimalInput,
  type V2JsonDocument
} from '../runtime/public-api';
import { normalizeFinanceRate, toIdBusinessV2BusinessDate } from './id-business-v2-finance-input';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

interface ResolveFinanceRateInput {
  currency: IdBusinessV2FinanceCurrency;
  occurredAt: Date;
  fxRateSnapshotId?: string | null;
  manualRate?: V2DecimalInput | null;
  manualReason?: string | null;
  operator?: AuthenticatedUser;
}

export interface ResolveStoredFinanceRateInput {
  currency: IdBusinessV2FinanceCurrency;
  previousSnapshotId?: string | null;
  manualRate?: unknown;
  manualReason?: unknown;
  label: string;
  operator?: AuthenticatedUser;
  auditRemark?: string;
}

@Injectable()
export class IdBusinessV2FinanceFxService {
  private readonly automaticQuoteInFlight = new Map<
    IdBusinessV2FinanceCurrency,
    ReturnType<IdBusinessV2FinanceCommandRepository['createFxSnapshot']>
  >();

  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService,
    private readonly exchangeRateOrderQuoteService: IdBusinessV2ExchangeRateOrderQuoteService,
    private readonly fiatProvider?: IdBusinessV2PurchaseRateProviderService
  ) {}

  async resolve(input: ResolveFinanceRateInput) {
    if (input.currency === 'CNY') {
      return {
        id: null,
        currency: 'CNY' as const,
        rateToCny: '1',
        source: 'cny_fixed' as const
      };
    }
    if (input.fxRateSnapshotId) {
      const existing = await this.queryRepository.findFxSnapshotById(input.fxRateSnapshotId);
      if (!existing || existing.currency !== input.currency) {
        throw new BadRequestException('汇率快照不存在或币种不一致');
      }
      if (existing.expiresAt && existing.expiresAt.getTime() < input.occurredAt.getTime()) {
        throw new BadRequestException('汇率快照已过期，请重新获取或填写人工汇率');
      }
      return this.normalizeResolvedRate(existing);
    }
    if (input.manualRate) {
      const manualRate = Rate8.from(input.manualRate);
      const reason = input.manualReason?.trim();
      if (!reason || reason.length < 2) {
        throw new BadRequestException('人工汇率必须填写原因');
      }
      return this.commandTransactions.execute(
        (tx, context) =>
          this.createManualInTransaction(tx, context, {
            currency: input.currency,
            rateToCny: manualRate,
            businessDate: toIdBusinessV2BusinessDate(input.occurredAt).date,
            capturedAt: new Date(),
            reason,
            operator: input.operator,
            auditData: { currency: input.currency, rateToCny: manualRate.toString(), reason }
          }),
        {
          changedScopes: ['exchange-rates', 'finance-reports'],
          requestId: randomUUID(),
          operator: input.operator
        }
      );
    }
    return this.normalizeResolvedRate(await this.ensureAutomaticRate(input));
  }

  async resolveStoredRateInTransaction(
    tx: V2CommandTransaction,
    context: V2CommandContext,
    input: ResolveStoredFinanceRateInput
  ) {
    const hasManualRate =
      input.manualRate !== undefined && input.manualRate !== null && input.manualRate !== '';
    const manualRate = hasManualRate
      ? normalizeFinanceRate(input.manualRate, input.currency)
      : null;
    const previous = input.previousSnapshotId
      ? await this.commandRepository.findFxSnapshotInTransaction(
          tx,
          input.currency,
          input.previousSnapshotId
        )
      : null;
    // 已锁定在原记录上的历史快照可继续沿用；新选快照必须在本次业务时间有效。
    if (
      previous &&
      (input.manualRate === undefined ||
        input.manualRate === '' ||
        manualRate?.equals(previous.rateToCny))
    ) {
      return previous;
    }
    if (manualRate) {
      const reason = typeof input.manualReason === 'string' ? input.manualReason.trim() : '';
      if (
        !reason ||
        reason.length > 500 ||
        [...reason].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
      ) {
        throw new BadRequestException(`${input.label}人工汇率原因格式无效`);
      }
      return this.createManualInTransaction(tx, context, {
        currency: input.currency,
        rateToCny: manualRate,
        businessDate: toIdBusinessV2BusinessDate(context.businessTime).date,
        capturedAt: context.businessTime,
        reason,
        operator: input.operator,
        auditData: { currency: input.currency, rateToCny: manualRate.toString(), reason },
        auditRemark: input.auditRemark
      });
    }
    const latest = await this.commandRepository.findFxSnapshotInTransaction(tx, input.currency);
    if (!latest || (latest.expiresAt && latest.expiresAt <= context.businessTime)) {
      throw new BadRequestException(`${input.label}缺少有效汇率，请填写人工汇率及原因`);
    }
    return latest;
  }

  async quoteOrderRate(
    currency: IdBusinessV2FinanceCurrency,
    operator?: AuthenticatedUser,
    quotedAt = new Date()
  ) {
    if (currency === 'CNY') {
      return {
        snapshotId: null,
        currency,
        rateToCny: '1',
        source: 'cny_fixed' as const,
        capturedAt: quotedAt,
        expiresAt: null
      };
    }
    const snapshot = await this.ensureAutomaticRate({
      currency,
      occurredAt: quotedAt,
      operator
    });
    return {
      snapshotId: snapshot.id,
      currency: snapshot.currency,
      rateToCny: snapshot.rateToCny.toString(),
      source: snapshot.source,
      capturedAt: snapshot.capturedAt,
      expiresAt: snapshot.expiresAt
    };
  }

  async createManual(
    currency: IdBusinessV2FinanceCurrency,
    rateToCnyInput: V2DecimalInput,
    businessDate: Date,
    reason: string,
    sourceReference: string | null,
    operator?: AuthenticatedUser
  ) {
    const rateToCny = Rate8.from(rateToCnyInput);
    if (currency === 'CNY' && !rateToCny.equals(1)) {
      throw new BadRequestException('CNY 汇率固定为 1');
    }
    return this.commandTransactions.execute(
      (tx, context) =>
        this.createManualInTransaction(tx, context, {
          currency,
          rateToCny,
          sourceReference,
          businessDate,
          reason,
          operator,
          auditData: {
            currency,
            rateToCny: rateToCny.toString(),
            businessDate: businessDate.toISOString(),
            reason
          }
        }),
      {
        changedScopes: ['exchange-rates', 'finance-reports'],
        requestId: randomUUID(),
        operator
      }
    );
  }

  private async createManualInTransaction(
    tx: V2CommandTransaction,
    context: V2CommandContext,
    input: {
      currency: IdBusinessV2FinanceCurrency;
      rateToCny: Rate8;
      businessDate: Date;
      capturedAt?: Date;
      reason: string;
      sourceReference?: string | null;
      operator?: AuthenticatedUser;
      auditData: V2JsonDocument;
      auditRemark?: string;
    }
  ) {
    const snapshot = await this.commandRepository.createFxSnapshot(tx, {
      id: randomUUID(),
      currency: input.currency,
      rateToCny: input.rateToCny.toString(),
      source: input.currency === 'CNY' ? 'cny_fixed' : 'manual',
      businessDate: input.businessDate,
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      ...(input.sourceReference !== undefined ? { sourceReference: input.sourceReference } : {}),
      manualReason: input.currency === 'CNY' ? null : input.reason,
      createdByUserId: input.operator?.id
    });
    await this.writeAudit(tx, input.operator, snapshot.id, input.auditData, input.auditRemark);
    context.markChangedScopes(['exchange-rates', 'finance-reports']);
    return snapshot;
  }

  async listLatest() {
    const items = await Promise.all(
      V2_FINANCE_CURRENCIES.map(async (currency) => {
        if (currency === 'CNY') {
          return {
            id: null,
            currency,
            rateToCny: '1',
            source: 'cny_fixed',
            capturedAt: new Date(),
            expiresAt: null
          };
        }
        const item = await this.queryRepository.findLatestFxSnapshot(currency);
        return item
          ? { ...item, rateToCny: item.rateToCny.toString() }
          : {
              id: null,
              currency,
              rateToCny: null,
              source: null,
              capturedAt: null,
              expiresAt: null
            };
      })
    );
    return { items, generatedAt: new Date().toISOString() };
  }

  private ensureAutomaticRate(input: ResolveFinanceRateInput) {
    if (input.currency === 'CNY') {
      throw new BadRequestException('CNY 汇率固定为 1');
    }
    const currency = input.currency;
    const existing = this.automaticQuoteInFlight.get(currency);
    if (existing) return existing;
    const quote =
      currency === 'USDT'
        ? this.snapshotEffectiveUsdtRate(input)
        : input.currency === 'MYR' || input.currency === 'USD'
          ? this.findOrCollectCrossRate(input)
          : this.collectFiatRate(input);
    this.automaticQuoteInFlight.set(currency, quote);
    return quote.finally(() => {
      if (this.automaticQuoteInFlight.get(currency) === quote) {
        this.automaticQuoteInFlight.delete(currency);
      }
    });
  }

  private normalizeResolvedRate<TSnapshot extends { rateToCny: string }>(
    snapshot: TSnapshot
  ): TSnapshot {
    return snapshot;
  }

  private async snapshotEffectiveUsdtRate(input: ResolveFinanceRateInput) {
    const effective = await this.exchangeRateOrderQuoteService.ensureEffective();
    const existing = await this.queryRepository.findUsdtAutomaticSnapshot(
      effective.snapshotId,
      input.occurredAt
    );
    if (existing) return existing;
    return this.commandTransactions.execute(
      (tx) =>
        this.commandRepository.createFxSnapshot(tx, {
          id: randomUUID(),
          currency: 'USDT',
          rateToCny: Rate8.from(effective.midRateToRmb).toString(),
          source: 'combined_p2p',
          sourceReference: effective.snapshotId,
          sourceEvidence: {
            exchangeRateRunId: effective.runId,
            exchangeRateSnapshotId: effective.snapshotId,
            averagedAt: effective.averagedAt.toISOString()
          },
          businessDate: toIdBusinessV2BusinessDate(input.occurredAt).date,
          capturedAt: effective.averagedAt,
          expiresAt: effective.expiresAt,
          createdByUserId: input.operator?.id
        }),
      {
        changedScopes: ['exchange-rates', 'finance-reports'],
        requestId: randomUUID(),
        operator: input.operator
      }
    );
  }

  private async collectFiatRate(input: ResolveFinanceRateInput) {
    const latest = await this.queryRepository.findLatestFxSnapshot(input.currency);
    if (
      latest?.source === 'exchange_rate_api' &&
      latest.expiresAt &&
      latest.expiresAt.getTime() > input.occurredAt.getTime()
    )
      return latest;
    let quote;
    try {
      if (!this.fiatProvider) throw new Error('汇率供应商未配置');
      quote = await this.fiatProvider.fetchLatest([input.currency]);
    } catch {
      throw new ServiceUnavailableException('该币种汇率采集失败，请填写人工汇率及原因');
    }
    const rate = Rate8.one().div(quote.quotePerCny[input.currency]!);
    if (!rate.gt('0')) throw new BadRequestException('汇率低于可保存精度');
    const expiresAt = new Date(quote.providerUpdatedAt.getTime() + 36 * 60 * 60 * 1000);
    if (expiresAt.getTime() <= input.occurredAt.getTime())
      throw new BadRequestException('市场汇率已过期，请填写人工汇率');
    return this.commandTransactions.execute(
      (tx) =>
        this.commandRepository.createFxSnapshot(tx, {
          id: randomUUID(),
          currency: input.currency,
          rateToCny: rate.toString(),
          source: 'exchange_rate_api',
          sourceReference: 'https://open.er-api.com/v6/latest/CNY',
          businessDate: toIdBusinessV2BusinessDate(input.occurredAt).date,
          capturedAt: quote.providerUpdatedAt,
          expiresAt,
          createdByUserId: input.operator?.id
        }),
      {
        changedScopes: ['exchange-rates', 'finance-reports'],
        requestId: randomUUID(),
        operator: input.operator
      }
    );
  }

  private async findOrCollectCrossRate(input: ResolveFinanceRateInput) {
    if (input.currency !== 'MYR' && input.currency !== 'USD') {
      throw new BadRequestException('该币种不支持 ECB 自动交叉汇率');
    }
    const existing = await this.queryRepository.findCrossAutomaticSnapshot(
      input.currency,
      input.occurredAt
    );
    return existing ?? this.collectCrossRate(input.currency, input);
  }

  private async collectCrossRate(currency: 'MYR' | 'USD', input: ResolveFinanceRateInput) {
    const [cny, quote] = await Promise.all([
      this.fetchEcbReferenceRate('CNY'),
      this.fetchEcbReferenceRate(currency)
    ]);
    if (cny.businessDate !== quote.businessDate) {
      throw new ServiceUnavailableException(`ECB CNY 与 ${currency} 参考汇率日期不一致`);
    }
    const crossRate = cny.rate.div(quote.rate);
    return this.commandTransactions.execute(
      (tx) =>
        this.commandRepository.createFxSnapshot(tx, {
          id: randomUUID(),
          currency,
          rateToCny: crossRate.toString(),
          source: 'ecb_cross',
          sourceReference: `ECB EXR.D.CNY.EUR.SP00.A / EXR.D.${currency}.EUR.SP00.A`,
          sourceEvidence: {
            cnyPerEur: cny.rate.toString(),
            quotePerEur: quote.rate.toString(),
            quoteCurrency: currency,
            referenceDate: cny.businessDate
          },
          businessDate: new Date(`${cny.businessDate}T00:00:00.000Z`),
          capturedAt: new Date(),
          expiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
          createdByUserId: input.operator?.id
        }),
      {
        changedScopes: ['exchange-rates', 'finance-reports'],
        requestId: randomUUID(),
        operator: input.operator
      }
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

  private writeAudit(
    tx: V2CommandTransaction,
    operator: AuthenticatedUser | undefined,
    objectId: string,
    afterData: V2JsonDocument,
    remark = '记录财务人工汇率'
  ) {
    return this.audit.append(tx, {
      userId: operator?.id,
      module: 'id_business_v2_finance',
      action: 'id_business_v2.finance.fx_rate.manual',
      objectType: 'id_business_v2_finance_fx_rate_snapshot',
      objectId,
      afterData,
      remark
    });
  }
}
