import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { toIdBusinessV2BusinessDate } from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2HistoricalCashRepository } from './persistence/id-business-v2-historical-cash.repository';
import { findLockedFinancePeriodStatus } from './persistence/id-business-v2-finance-posting.repository';
import {
  hasUniqueHistoricalCashCostSource,
  historicalCashBatchFingerprint,
  historicalCashSourceFingerprint,
  historicalCashSourceLineFingerprint,
  normalizeHistoricalCashBatch,
  type HistoricalCashAdjustment,
  type HistoricalCashBatch,
  type HistoricalCashBatchResult,
  type HistoricalCashSourceJournal,
  type HistoricalCashSourceLine
} from './id-business-v2-historical-cash.types';

type LockedAccount = NonNullable<
  Awaited<ReturnType<IdBusinessV2HistoricalCashRepository['lockAccount']>>
>;
type LockedOrder = NonNullable<
  Awaited<ReturnType<IdBusinessV2HistoricalCashRepository['lockOrder']>>
>;
interface PreparedAdjustment {
  input: HistoricalCashAdjustment;
  journal: HistoricalCashSourceJournal;
  line: HistoricalCashSourceLine;
  targetAccountId: string;
}
const MODULE = 'id_business_v2_finance';
const EXECUTE_ACTION = 'id_business_v2.historical_cash.execute';
const VERIFY_ACTION = 'id_business_v2.historical_cash.verify';

@Injectable()
export class IdBusinessV2HistoricalCashService {
  constructor(
    private readonly commands: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2HistoricalCashRepository,
    private readonly finance: IdBusinessV2FinanceCommandRepository,
    private readonly posting: IdBusinessV2FinancePostingService,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async execute(
    input: HistoricalCashBatch,
    operator: AuthenticatedUser
  ): Promise<HistoricalCashBatchResult> {
    if (!operator?.id) throw new ForbiddenException('历史现金补偿需要已认证的实际操作人');
    const batch = normalizeHistoricalCashBatch(input);
    const batchHash = historicalCashBatchFingerprint(batch);
    return this.commands.execute(
      async (tx, context) => {
        if (!(await this.repository.lockBatchGate(tx)))
          throw new ConflictException('财务设置尚未初始化，不能执行历史现金补偿');
        const actualOperator = await this.assertOperator(tx, operator.id);
        const replay = await this.findReplay(tx, batch, batchHash);
        if (replay) return replay;
        const business = toIdBusinessV2BusinessDate(context.businessTime);
        if ((await findLockedFinancePeriodStatus(tx, business.month)) === 'closed')
          throw new ConflictException(`${business.month} 已关账，请先重新打开月份`);
        const orders = new Map<string, LockedOrder>();
        for (const attribution of batch.orderAttributions ?? []) {
          const order = await this.repository.lockOrder(tx, attribution.orderId);
          if (!order) throw new NotFoundException('来源订单不存在');
          orders.set(order.id, order);
        }
        const sourceRows = await this.repository.findSourceJournalIds(
          tx,
          batch.adjustments.map((item) => item.sourceLineId)
        );
        if (sourceRows.length !== batch.adjustments.length)
          throw new NotFoundException('来源现金分录不存在');
        const sourceIds = new Set(sourceRows.map((row) => row.journalId));
        for (const orderId of orders.keys())
          for (const journal of await this.repository.findOrderJournalIds(tx, orderId))
            sourceIds.add(journal.id);
        const sources = new Map<string, HistoricalCashSourceJournal>();
        for (const id of [...sourceIds].sort()) {
          const source = await this.repository.lockSource(tx, id);
          if (!source) throw new NotFoundException('来源财务凭证不存在');
          sources.set(id, source);
        }
        const prepared = batch.adjustments.map((adjustment) => {
          const source = sources.get(
            sourceRows.find((row) => row.id === adjustment.sourceLineId)!.journalId
          )!;
          const line = source.lines.find((row) => row.id === adjustment.sourceLineId);
          if (!line) throw new ConflictException('来源现金分录与原凭证不一致');
          return this.prepareSource(adjustment, source, line);
        });
        for (const item of prepared) {
          if (item.input.kind === 'restate_foreign_cash_cost') {
            const expense = await this.repository.findSourceExpense(tx, item.journal.id);
            if (
              !expense ||
              expense.id !== item.journal.sourceId ||
              expense.financeAccountId !== item.targetAccountId ||
              expense.currency !== item.line.currency ||
              !Amount4.from(expense.amountOriginal).equals(String(item.line.amountOriginal)) ||
              !Amount4.from(expense.amountCny).equals(String(item.line.amountCny))
            )
              throw new ConflictException('原开支资料与历史现金成本来源凭证不一致');
          }
          if (
            item.journal.sourceType === 'order' &&
            !batch.orderAttributions?.some(
              (order) =>
                order.orderId === item.journal.sourceId &&
                order.targetAccountId === item.targetAccountId
            )
          )
            throw new ConflictException('订单历史现金补偿必须同时完成该订单全部收付的真实资金归属');
          if (
            (await this.repository.findAdjustment(tx, this.sourceKey(item.input))) ||
            (await this.repository.findVerification(tx, item.line.id)).length
          )
            throw new ConflictException('来源现金分录已由其他历史核对批次处理，不能重复补偿');
        }
        const targetIds = [...new Set(prepared.map((item) => item.targetAccountId))].sort();
        if (targetIds.join('|') !== batch.accounts.map((row) => row.accountId).join('|'))
          throw new BadRequestException('资金账户快照必须与本批实际涉及账户完全一致');
        const accounts = new Map<string, LockedAccount>();
        for (const expected of batch.accounts) {
          const account = await this.repository.lockAccount(tx, expected.accountId);
          if (!account || account.status !== 'active')
            throw new BadRequestException('资金账户不存在或已停用');
          if (
            account.updatedAt.toISOString() !== expected.expectedUpdatedAt ||
            !account.currentBalance.equals(expected.expectedBalanceOriginal) ||
            !account.currentBalanceCny.equals(expected.expectedBalanceCny)
          )
            throw new ConflictException('资金账户已变化，请重新核对并冻结补偿批次');
          accounts.set(account.id, account);
        }
        for (const item of prepared) {
          if (accounts.get(item.targetAccountId)!.currency !== item.line.currency)
            throw new BadRequestException('历史现金币种与真实资金账户不一致');
        }
        this.assertOrderAttributions(batch, orders, sources, prepared);
        const adjustmentJournalIds: string[] = [];
        const verifiedSourceLineIds: string[] = [];
        for (const item of prepared) {
          const evidence = this.evidence(batch, batchHash, item);
          if (
            item.input.kind === 'restate_foreign_cash_cost' &&
            Amount4.from(item.input.expectedBookCostCny).equals(item.input.recomputedBookCostCny)
          ) {
            await this.audit.append(tx, {
              userId: actualOperator.id,
              module: MODULE,
              action: VERIFY_ACTION,
              objectType: 'id_business_v2_finance_journal_line',
              objectId: item.line.id,
              afterData: toV2JsonDocument(evidence),
              remark: batch.reason
            });
            verifiedSourceLineIds.push(item.line.id);
            continue;
          }
          const journal =
            item.input.kind === 'assign_unassigned_cash'
              ? await this.assignCash(tx, item, evidence, context.businessTime, actualOperator)
              : await this.restateCost(tx, item, evidence, context.businessTime, actualOperator);
          adjustmentJournalIds.push(journal.id);
        }
        for (const attribution of batch.orderAttributions ?? []) {
          const before = orders.get(attribution.orderId)!;
          const updated = await this.repository.attributeOrder(
            tx,
            before.id,
            before.updatedAt,
            attribution.targetAccountId,
            actualOperator.id
          );
          if (updated.count !== 1)
            throw new ConflictException('来源订单资金归属已变化，请重新核对');
          await this.audit.append(tx, {
            userId: actualOperator.id,
            module: MODULE,
            action: 'id_business_v2.historical_cash.attribute_order',
            objectType: 'id_business_v2_order',
            objectId: before.id,
            beforeData: {
              receivedFinanceAccountId: null,
              status: before.status,
              expectedUpdatedAt: before.updatedAt.toISOString()
            },
            afterData: {
              receivedFinanceAccountId: attribution.targetAccountId,
              status: before.status,
              batchHash,
              sourceLineIds: prepared
                .filter(
                  (row) => row.journal.sourceType === 'order' && row.journal.sourceId === before.id
                )
                .map((row) => row.line.id)
            },
            remark: batch.reason
          });
        }
        await this.audit.append(tx, {
          userId: actualOperator.id,
          module: MODULE,
          action: EXECUTE_ACTION,
          objectType: 'id_business_v2_historical_cash_batch',
          objectId: randomUUID(),
          beforeData: { accounts: toV2JsonDocument(batch.accounts) },
          afterData: {
            version: 1,
            idempotencyKey: batch.idempotencyKey,
            batchHash,
            batchSize: prepared.length,
            adjustmentJournalIds,
            verifiedSourceLineIds,
            sourceLineIds: prepared.map((row) => row.line.id),
            evidenceReference: batch.evidenceReference,
            orderAttributions: toV2JsonDocument(batch.orderAttributions ?? [])
          },
          remark: batch.reason
        });
        return { batchHash, adjustmentJournalIds, replayed: false };
      },
      {
        changedScopes: [
          'finance-accounts',
          'finance-ledger',
          'finance-reports',
          'orders',
          'audit-logs',
          'dashboard'
        ],
        requestId: randomUUID(),
        operator,
        retryMode: 'stableIdempotency',
        idempotencyKey: batch.idempotencyKey,
        replay: async (tx) => {
          if (!(await this.repository.lockBatchGate(tx)))
            throw new ConflictException('财务设置尚未初始化');
          await this.assertOperator(tx, operator.id);
          const replay = await this.findReplay(tx, batch, batchHash);
          if (!replay) throw new ConflictException('历史现金补偿发生并发冲突，请重新核对');
          return replay;
        }
      }
    );
  }

  private async assertOperator(tx: V2CommandTransaction, id: string): Promise<AuthenticatedUser> {
    const current = await this.repository.readOperator(tx, id);
    if (
      !current ||
      current.status !== 'active' ||
      current.deletedAt ||
      !current.v2AuthIdentity?.enabled ||
      current.v2AuthIdentity.mustResetPassword
    )
      throw new ForbiddenException('实际操作人账号已停用、删除或需要完成身份验证');
    const roles = current.userRoles.map((row) => row.role.code);
    const permissions = [
      ...new Set(
        current.userRoles.flatMap((row) =>
          row.role.rolePermissions.map((entry) => entry.permission.code)
        )
      )
    ];
    const admin = roles.includes('admin') || current.systemSuperAdminId === id;
    if (
      !admin &&
      !['finance.view', 'finance.post', 'finance.adjust'].every((permission) =>
        permissions.includes(permission)
      )
    )
      throw new ForbiddenException('历史现金补偿需要现有财务查看、入账及调整权限');
    return { id, username: current.username, displayName: current.displayName, roles, permissions };
  }

  private prepareSource(
    input: HistoricalCashAdjustment,
    journal: HistoricalCashSourceJournal,
    line: HistoricalCashSourceLine
  ): PreparedAdjustment {
    if (
      journal.status !== 'posted' ||
      journal.hasReversal ||
      journal.reversalOfJournalId ||
      journal.sourceType === 'historical_backfill' ||
      'historicalCashAdjustment' in jsonRecord(journal.metadata) ||
      line.accountCode !== 'cash' ||
      historicalCashSourceFingerprint(journal) !== input.sourceFingerprint
    )
      throw new ConflictException('来源现金凭证已变化、已冲销或核对指纹不匹配');
    const original = Amount4.from(String(line.amountOriginal));
    const cny = Amount4.from(String(line.amountCny));
    if (original.lte(0) || cny.lte(0) || line.supplierAccountId)
      throw new BadRequestException('来源现金分录必须具有真实非零原币及人民币金额');
    if (input.kind === 'assign_unassigned_cash') {
      if (
        line.financeAccountId ||
        line.currency !== 'CNY' ||
        !original.equals(cny) ||
        !Rate8.from(String(line.fxRateToCny)).equals(1)
      )
        throw new BadRequestException('只允许对已核对的未归属人民币现金做精确归属补偿');
      return { input, journal, line, targetAccountId: input.targetAccountId };
    }
    if (
      !line.financeAccountId ||
      line.currency === 'CNY' ||
      line.direction !== 'credit' ||
      journal.journalType !== 'expense' ||
      journal.sourceType !== 'expense' ||
      !cny.equals(input.expectedBookCostCny)
    )
      throw new BadRequestException('外币成本核对必须精确对应未冲销的原开支现金贷方分录');
    if (Object.hasOwn(jsonRecord(jsonRecord(journal.metadata).cashHistoricalCost), 'version'))
      throw new BadRequestException('原外币开支已有现金历史成本依据，不能再次做历史成本补偿');
    if (!hasUniqueHistoricalCashCostSource(journal, line))
      throw new BadRequestException('原外币开支同账户现金贷方必须唯一，请先核对历史分录');
    return { input, journal, line, targetAccountId: line.financeAccountId };
  }

  private assertOrderAttributions(
    batch: HistoricalCashBatch,
    orders: Map<string, LockedOrder>,
    sources: Map<string, HistoricalCashSourceJournal>,
    prepared: PreparedAdjustment[]
  ) {
    for (const attribution of batch.orderAttributions ?? []) {
      const order = orders.get(attribution.orderId)!;
      if (
        order.updatedAt.toISOString() !== attribution.expectedUpdatedAt ||
        order.receivedFinanceAccountId ||
        !['completed', 'refunded'].includes(order.status) ||
        order.receivedCurrency !== 'CNY' ||
        !Rate8.from(order.receivedFxRateToCny).equals(1) ||
        !Amount4.from(order.receivedAmount).equals(order.receivedOriginalAmount)
      )
        throw new ConflictException('订单状态、冻结收款或原始版本与历史资金归属核对不一致');
      const journals = [...sources.values()].filter(
        (row) => row.sourceType === 'order' && row.sourceId === order.id && row.status === 'posted'
      );
      const cashLines = journals.flatMap((row) =>
        row.lines.filter(
          (line) =>
            line.accountCode === 'cash' &&
            (!Amount4.from(String(line.amountOriginal)).isZero() ||
              !Amount4.from(String(line.amountCny)).isZero())
        )
      );
      if (
        !cashLines.length ||
        cashLines.some(
          (line) =>
            line.financeAccountId ||
            !prepared.some(
              (item) =>
                item.line.id === line.id &&
                item.input.kind === 'assign_unassigned_cash' &&
                item.targetAccountId === attribution.targetAccountId
            )
        )
      )
        throw new ConflictException('订单全部非零未归属现金必须由同一真实账户完整补偿');
      const receipts = journals
        .filter((row) => row.journalType === 'order_completed')
        .flatMap((row) =>
          row.lines.filter((line) => line.accountCode === 'cash' && line.direction === 'debit')
        );
      if (
        !receipts
          .reduce((sum, line) => sum.add(String(line.amountOriginal)), Amount4.zero())
          .equals(order.receivedOriginalAmount) ||
        !receipts
          .reduce((sum, line) => sum.add(String(line.amountCny)), Amount4.zero())
          .equals(order.receivedAmount)
      )
        throw new ConflictException('原收款分录与订单冻结收款金额不一致');
    }
  }

  private evidence(batch: HistoricalCashBatch, batchHash: string, item: PreparedAdjustment) {
    return {
      version: 1,
      kind: item.input.kind,
      originalJournalId: item.journal.id,
      originalLineId: item.line.id,
      sourceFingerprint: item.input.sourceFingerprint,
      sourceLineFingerprint: historicalCashSourceLineFingerprint(item.journal, item.line),
      targetAccountId: item.targetAccountId,
      batchHash,
      idempotencyKey: batch.idempotencyKey,
      batchSize: batch.adjustments.length,
      evidenceReference: item.input.evidenceReference,
      ...(item.input.kind === 'restate_foreign_cash_cost'
        ? {
            expectedBookCostCny: item.input.expectedBookCostCny,
            recomputedBookCostCny: item.input.recomputedBookCostCny
          }
        : {})
    };
  }

  private async assignCash(
    tx: V2CommandTransaction,
    item: PreparedAdjustment,
    evidence: ReturnType<IdBusinessV2HistoricalCashService['evidence']>,
    occurredAt: Date,
    operator: AuthenticatedUser
  ) {
    // This dedicated path is the only creator of an unassigned contra cash line: it mirrors one locked immutable CNY source exactly.
    const business = toIdBusinessV2BusinessDate(occurredAt);
    const amount = Amount4.from(String(item.line.amountOriginal));
    const account = await this.repository.lockAccount(tx, item.targetAccountId);
    if (!account || account.status !== 'active' || account.currency !== 'CNY')
      throw new BadRequestException('人民币归属账户不可用');
    const signed = item.line.direction === 'debit' ? amount : amount.negated();
    if (
      account.currentBalance.add(signed).isNegative() ||
      account.currentBalanceCny.add(signed).isNegative()
    )
      throw new ConflictException('资金账户余额不足以承接历史归属补偿');
    const id = randomUUID();
    const journal = await this.finance.createJournal(tx, {
      id,
      journalNo: `HC${occurredAt.getTime()}${randomUUID().slice(0, 8)}`,
      journalType: 'manual_adjustment',
      sourceType: 'historical_backfill',
      sourceId: item.line.id,
      businessDate: business.date,
      periodMonth: business.month,
      occurredAt,
      summary: '历史人民币现金归属核对补偿',
      metadata: { historicalCashAdjustment: evidence },
      idempotencyKey: this.sourceKey(item.input),
      createdByUserId: operator.id,
      lines: {
        create: [
          {
            id: randomUUID(),
            lineNo: 1,
            accountCode: 'cash',
            direction: item.line.direction === 'debit' ? 'credit' : 'debit',
            currency: 'CNY',
            amountOriginal: amount.toString(),
            amountCny: amount.toString(),
            fxRateToCny: '1',
            fxRateSnapshotId: item.line.fxRateSnapshotId,
            financeAccountId: null
          },
          {
            id: randomUUID(),
            lineNo: 2,
            accountCode: 'cash',
            direction: item.line.direction,
            currency: 'CNY',
            amountOriginal: amount.toString(),
            amountCny: amount.toString(),
            fxRateToCny: '1',
            fxRateSnapshotId: item.line.fxRateSnapshotId,
            financeAccountId: item.targetAccountId
          }
        ]
      }
    });
    await this.finance.incrementFinanceAccount(
      tx,
      account.id,
      signed.toString(),
      signed.toString()
    );
    return journal;
  }

  private restateCost(
    tx: V2CommandTransaction,
    item: PreparedAdjustment,
    evidence: ReturnType<IdBusinessV2HistoricalCashService['evidence']>,
    occurredAt: Date,
    operator: AuthenticatedUser
  ) {
    if (item.input.kind !== 'restate_foreign_cash_cost')
      throw new BadRequestException('外币现金成本补偿类型不正确');
    const delta = Amount4.from(item.input.expectedBookCostCny).sub(
      item.input.recomputedBookCostCny
    );
    return this.posting.post(tx, {
      journalType: 'manual_adjustment',
      sourceType: 'historical_backfill',
      sourceId: item.line.id,
      occurredAt,
      summary: '历史外币现金成本核对调整',
      metadata: { historicalCashAdjustment: evidence },
      idempotencyKey: this.sourceKey(item.input),
      operator,
      lines: [
        {
          accountCode: 'cash',
          direction: delta.gt(0) ? 'debit' : 'credit',
          currency: item.line.currency,
          amountOriginal: '0',
          fxRateToCny: '1',
          amountCny: delta.abs(),
          financeAccountId: item.targetAccountId
        },
        {
          accountCode: 'realized_fx_gain_loss',
          direction: delta.gt(0) ? 'credit' : 'debit',
          currency: 'CNY',
          amountOriginal: delta.abs(),
          fxRateToCny: '1',
          amountCny: delta.abs(),
          financeAccountId: item.targetAccountId
        }
      ]
    });
  }

  private async findReplay(
    tx: V2CommandTransaction,
    batch: HistoricalCashBatch,
    batchHash: string
  ): Promise<HistoricalCashBatchResult | null> {
    const receipts = await this.repository.findBatchReceipt(tx, batch.idempotencyKey);
    if (!receipts.length) return null;
    const receipt = jsonRecord(receipts[0].afterData);
    if (
      receipts.length !== 1 ||
      receipt.version !== 1 ||
      receipt.batchHash !== batchHash ||
      receipt.batchSize !== batch.adjustments.length ||
      JSON.stringify(receipt.sourceLineIds) !==
        JSON.stringify(batch.adjustments.map((item) => item.sourceLineId))
    )
      throw new ConflictException('历史现金补偿批次幂等键已用于其他内容');
    const adjustmentJournalIds: string[] = [];
    const verifiedSourceLineIds: string[] = [];
    for (const item of batch.adjustments) {
      const journal = await this.repository.findAdjustment(tx, this.sourceKey(item));
      const verification = await this.repository.findVerification(tx, item.sourceLineId);
      const metadata = journal
        ? jsonRecord(jsonRecord(journal.metadata).historicalCashAdjustment)
        : null;
      if (
        journal &&
        !verification.length &&
        metadata?.batchHash === batchHash &&
        metadata.sourceFingerprint === item.sourceFingerprint
      )
        adjustmentJournalIds.push(journal.id);
      else if (
        !journal &&
        verification.length === 1 &&
        jsonRecord(verification[0].afterData).batchHash === batchHash &&
        jsonRecord(verification[0].afterData).sourceFingerprint === item.sourceFingerprint
      )
        verifiedSourceLineIds.push(item.sourceLineId);
      else throw new ConflictException('历史现金补偿批次凭证不完整，不能重放');
    }
    if (
      JSON.stringify(adjustmentJournalIds) !== JSON.stringify(receipt.adjustmentJournalIds) ||
      JSON.stringify(verifiedSourceLineIds) !== JSON.stringify(receipt.verifiedSourceLineIds)
    )
      throw new ConflictException('历史现金补偿批次凭证与审计回执不一致');
    return { batchHash, adjustmentJournalIds, replayed: true };
  }

  private sourceKey(input: HistoricalCashAdjustment) {
    return `historical_cash:${input.kind}:${input.sourceLineId}`;
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
