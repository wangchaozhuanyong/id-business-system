import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  calculateFinanceExchange,
  financeCurrencyLabel,
  type V2FinanceExchangeWrite
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination } from '../../common/pagination';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  buildIdBusinessV2DateRange,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import {
  IdBusinessV2FinancePostingService,
  type FinancePostingLineInput
} from './id-business-v2-finance-posting.service';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceMoney,
  normalizeFinanceText,
  normalizeFinanceUuid,
  normalizeFinanceRate
} from './id-business-v2-finance-input';
import { findLockedFinancePeriodStatus } from './persistence/id-business-v2-finance-posting.repository';
import {
  IdBusinessV2FinanceExchangeRepository,
  mapFinanceExchange,
  type FinanceExchangeWhere
} from './persistence/id-business-v2-finance-exchange.repository';

@Injectable()
export class IdBusinessV2FinanceExchangesService {
  constructor(
    private readonly repository: IdBusinessV2FinanceExchangeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly fx: IdBusinessV2FinanceFxService,
    private readonly posting: IdBusinessV2FinancePostingService,
    private readonly audit: V2TransactionalAuditService
  ) {}
  async list(query: Record<string, string | undefined>) {
    const pagination = getPagination(query);
    const and: FinanceExchangeWhere[] = [];
    if (query.currency) {
      const currency = normalizeFinanceCurrency(query.currency);
      and.push({ OR: [{ sourceCurrency: currency }, { targetCurrency: currency }] });
    }
    if (query.financeAccountId) {
      const id = normalizeFinanceUuid(query.financeAccountId, '资金账户');
      and.push({ OR: [{ sourceAccountId: id }, { targetAccountId: id }] });
    }
    if (query.status) {
      if (!['posted', 'reversed'].includes(query.status))
        throw new BadRequestException('换汇状态不正确');
      and.push({ journal: { status: query.status as 'posted' | 'reversed' } });
    }
    if (query.sort && !['newest', 'oldest'].includes(query.sort))
      throw new BadRequestException('排序方式不正确');
    const keyword = normalizeFinanceText(query.keyword, '搜索内容', 200);
    if (keyword)
      and.push({ OR: [{ channel: { contains: keyword } }, { remark: { contains: keyword } }] });
    const occurredAt = buildIdBusinessV2DateRange(query.dateFrom, query.dateTo, {
      from: '开始日期',
      to: '结束日期',
      invalidRange: '开始日期不能晚于结束日期'
    });
    if (occurredAt) and.push({ occurredAt });
    return {
      ...(await this.repository.list(
        { AND: and },
        pagination.skip,
        pagination.take,
        query.sort === 'oldest'
      )),
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }
  async detail(id: string) {
    const row = await this.repository.find(normalizeFinanceUuid(id, '换汇记录'));
    if (!row) throw new NotFoundException('换汇记录不存在');
    return mapFinanceExchange(row);
  }
  private normalize(dto: V2FinanceExchangeWrite) {
    if (!dto || typeof dto !== 'object') throw new BadRequestException('换汇资料不正确');
    const value = {
      sourceAccountId: normalizeFinanceUuid(dto.sourceAccountId, '付款账户'),
      targetAccountId: normalizeFinanceUuid(dto.targetAccountId, '收款账户'),
      sourceCurrency: normalizeFinanceCurrency(dto.sourceCurrency),
      targetCurrency: normalizeFinanceCurrency(dto.targetCurrency),
      sourceAmount: normalizeFinanceMoney(dto.sourceAmount, '换汇本金').toString(),
      targetAmount: normalizeFinanceMoney(dto.targetAmount, '实际到账').toString(),
      feeAmount: normalizeFinanceMoney(dto.feeAmount, '手续费', true).toString(),
      feeMode: dto.feeMode,
      occurredAt: normalizeFinanceDate(dto.occurredAt, '换汇时间'),
      channel: normalizeFinanceText(dto.channel, '换汇渠道', 200),
      remark: normalizeFinanceText(dto.remark, '备注', 2000)
    };
    if (
      value.sourceCurrency === value.targetCurrency ||
      value.sourceAccountId === value.targetAccountId
    )
      throw new BadRequestException('换汇需要两个不同币种的资金账户');
    let calculation;
    try {
      calculation = calculateFinanceExchange(value);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '换汇金额不正确');
    }
    if (
      !Rate8.from(calculation.exchangeRate).gt('0') ||
      !Rate8.from(calculation.effectiveRate).gt('0')
    )
      throw new BadRequestException('换汇汇率低于可保存精度');
    return { ...value, ...calculation };
  }
  private async rates(
    dto: V2FinanceExchangeWrite,
    input: ReturnType<IdBusinessV2FinanceExchangesService['normalize']>,
    operator?: AuthenticatedUser
  ) {
    const reason = normalizeFinanceText(dto.manualRateReason, '人工汇率原因', 500);
    const [source, target] = await Promise.all([
      this.fx.resolve({
        currency: input.sourceCurrency,
        occurredAt: input.occurredAt,
        fxRateSnapshotId: dto.sourceFxSnapshotId,
        manualRate: dto.sourceFxRateToCny
          ? normalizeFinanceRate(dto.sourceFxRateToCny, input.sourceCurrency)
          : null,
        manualReason: reason,
        operator
      }),
      this.fx.resolve({
        currency: input.targetCurrency,
        occurredAt: input.occurredAt,
        fxRateSnapshotId: dto.targetFxSnapshotId,
        manualRate: dto.targetFxRateToCny
          ? normalizeFinanceRate(dto.targetFxRateToCny, input.targetCurrency)
          : null,
        manualReason: reason,
        operator
      })
    ]);
    return { source, target };
  }
  async quote(dto: V2FinanceExchangeWrite, operator?: AuthenticatedUser) {
    const input = this.normalize(dto);
    const rates = await this.rates(dto, input, operator);
    return {
      ...input,
      occurredAt: input.occurredAt.toISOString(),
      sourceFxSnapshotId: rates.source.id,
      targetFxSnapshotId: rates.target.id,
      sourceFxRateToCny: rates.source.rateToCny,
      targetFxRateToCny: rates.target.rateToCny
    };
  }
  private fingerprint(
    dto: V2FinanceExchangeWrite,
    input: ReturnType<IdBusinessV2FinanceExchangesService['normalize']>,
    correctionOfId?: string,
    reason?: string
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          sourceFxSnapshotId: dto.sourceFxSnapshotId ?? null,
          targetFxSnapshotId: dto.targetFxSnapshotId ?? null,
          sourceFxRateToCny: dto.sourceFxRateToCny ?? null,
          targetFxRateToCny: dto.targetFxRateToCny ?? null,
          manualRateReason: dto.manualRateReason ?? null,
          correctionOfId: correctionOfId ?? null,
          reason: reason ?? null
        })
      )
      .digest('hex');
  }
  async create(
    dto: V2FinanceExchangeWrite,
    operator?: AuthenticatedUser,
    correctionOfId?: string,
    reason?: string
  ) {
    const input = this.normalize(dto);
    const key = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'finance_exchange');
    const fingerprint = this.fingerprint(dto, input, correctionOfId, reason);
    // Resolve an unchanged replay before acquiring a new market quote.
    const preflight = await this.repository.replayRead(key);
    if (preflight) {
      if (preflight.requestFingerprint !== fingerprint)
        throw new ConflictException('幂等键已用于不同换汇资料');
      return mapFinanceExchange(preflight);
    }
    const rates = await this.rates(dto, input, operator);
    const work = async (tx: V2CommandTransaction) => {
      const replay = await this.repository.replay(tx, key);
      if (replay) {
        if (replay.requestFingerprint !== fingerprint)
          throw new ConflictException('幂等键已用于不同换汇资料');
        return mapFinanceExchange(replay);
      }
      const accounts = await this.repository.accounts(tx, [
        input.sourceAccountId,
        input.targetAccountId
      ]);
      const source = accounts.find((a) => a.id === input.sourceAccountId),
        target = accounts.find((a) => a.id === input.targetAccountId);
      if (
        !source ||
        !target ||
        source.status !== 'active' ||
        target.status !== 'active' ||
        source.currency !== input.sourceCurrency ||
        target.currency !== input.targetCurrency
      )
        throw new BadRequestException('换汇账户不存在、已停用或币种不一致');
      if (correctionOfId) {
        const original = await this.repository.findInTransaction(tx, correctionOfId);
        if (!original || original.journal.status !== 'posted')
          throw new ConflictException('原换汇已冲销或不存在');
        if ((await findLockedFinancePeriodStatus(tx, original.journal.periodMonth)) === 'closed')
          throw new ConflictException('原换汇月份已关账');
        await this.posting.reverse(tx, original.journalId, reason!, `${key}:reversal`, operator);
      }
      const sourceFx = Rate8.from(rates.source.rateToCny),
        targetFx = Rate8.from(rates.target.rateToCny);
      const principalCny = sourceFx.apply(input.sourceAmount),
        targetCny = targetFx.apply(input.targetAmount);
      const feeFx = input.feeMode === 'source_extra' ? sourceFx : targetFx;
      const feeCny = feeFx.apply(input.feeAmount);
      const gain = targetCny
        .add(input.feeMode === 'target_deducted' ? feeCny : '0')
        .sub(principalCny);
      const id = randomUUID();
      const lines: FinancePostingLineInput[] = [
        {
          accountCode: 'cash',
          direction: 'credit',
          currency: input.sourceCurrency,
          amountOriginal: input.sourceAmount,
          fxRateToCny: sourceFx,
          amountCny: principalCny,
          financeAccountId: source.id,
          fxRateSnapshotId: rates.source.id
        },
        {
          accountCode: 'cash',
          direction: 'debit',
          currency: input.targetCurrency,
          amountOriginal: input.targetAmount,
          fxRateToCny: targetFx,
          amountCny: targetCny,
          financeAccountId: target.id,
          fxRateSnapshotId: rates.target.id
        }
      ];
      if (!Amount4.from(input.feeAmount).isZero()) {
        const currency =
          input.feeMode === 'source_extra' ? input.sourceCurrency : input.targetCurrency;
        const snapshotId = input.feeMode === 'source_extra' ? rates.source.id : rates.target.id;
        lines.push({
          accountCode: 'fx_exchange_fee',
          direction: 'debit',
          currency,
          amountOriginal: input.feeAmount,
          fxRateToCny: feeFx,
          amountCny: feeCny,
          fxRateSnapshotId: snapshotId
        });
        if (input.feeMode === 'source_extra')
          lines.push({
            accountCode: 'cash',
            direction: 'credit',
            currency,
            amountOriginal: input.feeAmount,
            fxRateToCny: feeFx,
            amountCny: feeCny,
            financeAccountId: source.id,
            fxRateSnapshotId: snapshotId
          });
      }
      if (!gain.isZero())
        lines.push({
          accountCode: 'realized_fx_gain_loss',
          direction: gain.gt('0') ? 'credit' : 'debit',
          currency: 'CNY',
          amountOriginal: gain.abs(),
          amountCny: gain.abs(),
          fxRateToCny: Rate8.one()
        });
      const journal = await this.posting.post(tx, {
        journalType: 'fx_exchange',
        sourceType: 'fx_exchange',
        sourceId: id,
        occurredAt: input.occurredAt,
        summary: `换汇：${financeCurrencyLabel(input.sourceCurrency)} → ${financeCurrencyLabel(input.targetCurrency)}`,
        idempotencyKey: `${key}:journal`,
        operator,
        lines
      });
      const persisted: Omit<typeof input, 'reverseRate'> & { reverseRate?: string } = { ...input };
      const realizedGain = journal.lines
        .filter((line) => line.accountCode === 'realized_fx_gain_loss')
        .reduce(
          (total, line) =>
            line.direction === 'credit' ? total.add(line.amountCny) : total.sub(line.amountCny),
          Amount4.zero()
        );
      delete persisted.reverseRate;
      const row = await this.repository.create(tx, {
        ...persisted,
        id,
        journalId: journal.id,
        sourceAccountName: source.name,
        targetAccountName: target.name,
        sourceFxRateToCny: sourceFx.toString(),
        targetFxRateToCny: targetFx.toString(),
        sourceFxSnapshotId: rates.source.id,
        targetFxSnapshotId: rates.target.id,
        feeAmountCny: feeCny.toString(),
        fxGainLossCny: realizedGain.toString(),
        correctionOfId: correctionOfId ?? null,
        idempotencyKey: key,
        requestFingerprint: fingerprint,
        createdByUserId: operator?.id
      });
      await this.audit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: correctionOfId
          ? 'id_business_v2.finance_exchange.correct'
          : 'id_business_v2.finance_exchange.create',
        objectType: 'id_business_v2_finance_exchange',
        objectId: id,
        afterData: {
          journalId: journal.id,
          sourceAccountId: source.id,
          targetAccountId: target.id,
          sourceAmount: input.sourceAmount,
          targetAmount: input.targetAmount,
          feeAmount: input.feeAmount,
          feeMode: input.feeMode,
          correctionOfId: correctionOfId ?? null,
          reason: reason ?? null
        },
        remark: '换汇入账'
      });
      return mapFinanceExchange(row);
    };
    return this.transactions.execute(work, {
      changedScopes: ['finance-accounts', 'finance-ledger', 'finance-reports', 'dashboard'],
      requestId: randomUUID(),
      operator,
      retryMode: 'stableIdempotency',
      idempotencyKey: key,
      replay: work,
      uniqueConflictMessage: '该换汇请求或更正已处理，请刷新核对'
    });
  }
  correct(
    id: string,
    dto: V2FinanceExchangeWrite & { reason: string },
    operator?: AuthenticatedUser
  ) {
    return this.create(
      dto,
      operator,
      normalizeFinanceUuid(id, '换汇记录'),
      normalizeFinanceText(dto.reason, '更正原因', 500, true)!
    );
  }
  reverse(
    id: string,
    dto: { reason: string; idempotencyKey: string },
    operator?: AuthenticatedUser
  ) {
    const exchangeId = normalizeFinanceUuid(id, '换汇记录');
    const reason = normalizeFinanceText(dto.reason, '冲销原因', 500, true)!;
    const key = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'finance_exchange_reverse');
    return this.transactions.execute(
      async (tx) => {
        const row = await this.repository.findInTransaction(tx, exchangeId);
        if (!row) throw new NotFoundException('换汇记录不存在');
        if (
          row.journal.status !== 'reversed' &&
          (await findLockedFinancePeriodStatus(tx, row.journal.periodMonth)) === 'closed'
        )
          throw new ConflictException('原换汇月份已关账');
        const reversal = await this.posting.reverse(tx, row.journalId, reason, key, operator);
        if (row.journal.status !== 'reversed')
          await this.audit.append(tx, {
            userId: operator?.id,
            module: 'id_business_v2_finance',
            action: 'id_business_v2.finance_exchange.reverse',
            objectType: 'id_business_v2_finance_exchange',
            objectId: row.id,
            afterData: { reversalJournalId: reversal.id, reason },
            remark: '冲销换汇'
          });
        return mapFinanceExchange((await this.repository.findInTransaction(tx, exchangeId))!);
      },
      {
        changedScopes: ['finance-accounts', 'finance-ledger', 'finance-reports', 'dashboard'],
        requestId: randomUUID(),
        operator
      }
    );
  }
}
