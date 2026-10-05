import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IdBusinessV2FinanceCurrency } from '@prisma/client';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  normalizeFinanceIdempotencyKey,
  normalizeFinanceMoney,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';

export interface HistoricalCashAccountExpectation {
  accountId: string;
  expectedUpdatedAt: string;
  expectedBalanceOriginal: string;
  expectedBalanceCny: string;
}

interface HistoricalCashAdjustmentSource {
  sourceLineId: string;
  sourceFingerprint: string;
  evidenceReference: string;
}

export type HistoricalCashAdjustment =
  | (HistoricalCashAdjustmentSource & {
      kind: 'assign_unassigned_cash';
      targetAccountId: string;
    })
  | (HistoricalCashAdjustmentSource & {
      kind: 'restate_foreign_cash_cost';
      expectedBookCostCny: string;
      recomputedBookCostCny: string;
    });

export interface HistoricalCashOrderAttribution {
  orderId: string;
  expectedUpdatedAt: string;
  targetAccountId: string;
}

export interface HistoricalCashBatch {
  idempotencyKey: string;
  reason: string;
  evidenceReference: string;
  accounts: HistoricalCashAccountExpectation[];
  adjustments: HistoricalCashAdjustment[];
  orderAttributions?: HistoricalCashOrderAttribution[];
}

export interface HistoricalCashBatchResult {
  batchHash: string;
  adjustmentJournalIds: string[];
  replayed: boolean;
}

export interface HistoricalCashSourceLine {
  id: string;
  journalId: string;
  lineNo: number;
  accountCode: string;
  direction: 'debit' | 'credit';
  currency: IdBusinessV2FinanceCurrency;
  amountOriginal: unknown;
  fxRateToCny: unknown;
  amountCny: unknown;
  financeAccountId: string | null;
  supplierAccountId: string | null;
  fxRateSnapshotId: string | null;
  memo: string | null;
}

export interface HistoricalCashSourceJournal {
  id: string;
  journalNo: string;
  journalType: string;
  sourceType: string;
  sourceId: string | null;
  sourceReference: string | null;
  businessDate: Date;
  periodMonth: string;
  occurredAt: Date;
  status: string;
  reversalOfJournalId: string | null;
  reversedAt: Date | null;
  summary: string;
  metadata: unknown;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey?: string;
  hasReversal?: boolean;
  lines: HistoricalCashSourceLine[];
}

export function normalizeHistoricalCashBatch(input: HistoricalCashBatch): HistoricalCashBatch {
  if (
    !input ||
    !Array.isArray(input.adjustments) ||
    !input.adjustments.length ||
    input.adjustments.length > 100
  )
    throw new BadRequestException('历史现金补偿批次需包含 1–100 条调整');
  if (!Array.isArray(input.accounts) || !input.accounts.length || input.accounts.length > 100)
    throw new BadRequestException('历史现金补偿缺少资金账户核对快照');
  const adjustments = input.adjustments
    .map((item): HistoricalCashAdjustment => {
      const source = {
        sourceLineId: normalizeFinanceUuid(item.sourceLineId, '来源分录'),
        sourceFingerprint: normalizeFingerprint(item.sourceFingerprint),
        evidenceReference: normalizeFinanceText(item.evidenceReference, '核对凭据', 300, true)!
      };
      if (item.kind === 'assign_unassigned_cash')
        return {
          ...source,
          kind: item.kind,
          targetAccountId: normalizeFinanceUuid(item.targetAccountId, '真实资金账户')
        };
      if (item.kind === 'restate_foreign_cash_cost')
        return {
          ...source,
          kind: item.kind,
          expectedBookCostCny: normalizeFinanceMoney(
            item.expectedBookCostCny,
            '原账面成本',
            true
          ).toString(),
          recomputedBookCostCny: normalizeFinanceMoney(
            item.recomputedBookCostCny,
            '核对后账面成本',
            true
          ).toString()
        };
      throw new BadRequestException('历史现金补偿类型不正确');
    })
    .sort((a, b) => a.sourceLineId.localeCompare(b.sourceLineId));
  const accounts = input.accounts
    .map((account) => ({
      accountId: normalizeFinanceUuid(account.accountId, '资金账户'),
      expectedUpdatedAt: normalizeTimestamp(account.expectedUpdatedAt),
      expectedBalanceOriginal: normalizeFinanceMoney(
        account.expectedBalanceOriginal,
        '账户原币余额',
        true
      ).toString(),
      expectedBalanceCny: normalizeFinanceMoney(
        account.expectedBalanceCny,
        '账户人民币成本',
        true
      ).toString()
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  const orderAttributions = (input.orderAttributions ?? [])
    .map((order) => ({
      orderId: normalizeFinanceUuid(order.orderId, '来源订单'),
      expectedUpdatedAt: normalizeTimestamp(order.expectedUpdatedAt),
      targetAccountId: normalizeFinanceUuid(order.targetAccountId, '订单真实资金账户')
    }))
    .sort((a, b) => a.orderId.localeCompare(b.orderId));
  for (const ids of [
    adjustments.map((row) => row.sourceLineId),
    accounts.map((row) => row.accountId),
    orderAttributions.map((row) => row.orderId)
  ])
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('历史现金补偿批次包含重复来源或账户');
  return {
    idempotencyKey: normalizeFinanceIdempotencyKey(
      String(input.idempotencyKey ?? '').replace(/^historical_cash_batch:/, ''),
      'historical_cash_batch'
    ),
    reason: normalizeFinanceText(input.reason, '补偿原因', 1000, true)!,
    evidenceReference: normalizeFinanceText(input.evidenceReference, '批次核对凭据', 300, true)!,
    accounts,
    adjustments,
    orderAttributions
  };
}

export function historicalCashBatchFingerprint(input: HistoricalCashBatch) {
  return hash(normalizeHistoricalCashBatch(input));
}

export function historicalCashSourceFingerprint(journal: HistoricalCashSourceJournal) {
  return hash({
    id: journal.id,
    journalNo: journal.journalNo,
    journalType: journal.journalType,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId,
    sourceReference: journal.sourceReference,
    businessDate: journal.businessDate.toISOString(),
    periodMonth: journal.periodMonth,
    occurredAt: journal.occurredAt.toISOString(),
    status: journal.status,
    reversalOfJournalId: journal.reversalOfJournalId,
    reversedAt: journal.reversedAt?.toISOString() ?? null,
    summary: journal.summary,
    metadata: journal.metadata ?? null,
    createdByUserId: journal.createdByUserId,
    createdAt: journal.createdAt.toISOString(),
    updatedAt: journal.updatedAt.toISOString(),
    idempotencyKey: journal.idempotencyKey ?? null,
    lines: [...journal.lines]
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((line) => ({
        id: line.id,
        journalId: line.journalId,
        lineNo: line.lineNo,
        accountCode: line.accountCode,
        direction: line.direction,
        currency: line.currency,
        amountOriginal: amount(line.amountOriginal),
        fxRateToCny: rate(line.fxRateToCny),
        amountCny: amount(line.amountCny),
        financeAccountId: line.financeAccountId,
        supplierAccountId: line.supplierAccountId,
        fxRateSnapshotId: line.fxRateSnapshotId,
        memo: line.memo
      }))
  });
}

// Fixed scale matches MySQL DECIMAL text, so the audit can verify this without trusting JSON metadata.
export function historicalCashSourceLineFingerprint(
  journal: HistoricalCashSourceJournal,
  line: HistoricalCashSourceLine
) {
  return createHash('sha256')
    .update(
      [
        journal.id,
        journal.sourceType,
        journal.sourceId ?? '',
        line.id,
        String(line.lineNo),
        line.accountCode,
        line.direction,
        line.currency,
        fixed(amount(line.amountOriginal), 4),
        fixed(rate(line.fxRateToCny), 8),
        fixed(amount(line.amountCny), 4),
        line.financeAccountId ?? '',
        line.supplierAccountId ?? '',
        line.fxRateSnapshotId ?? ''
      ].join('|')
    )
    .digest('hex');
}

export function hasUniqueHistoricalCashCostSource(
  journal: HistoricalCashSourceJournal,
  source: HistoricalCashSourceLine
) {
  return (
    journal.lines.filter(
      (line) =>
        line.accountCode === 'cash' &&
        line.direction === 'credit' &&
        line.currency !== 'CNY' &&
        line.financeAccountId === source.financeAccountId &&
        Amount4.from(String(line.amountOriginal)).gt(0)
    ).length === 1
  );
}

function amount(value: unknown) {
  return Amount4.from(String(value)).toString();
}
function rate(value: unknown) {
  return Rate8.from(String(value)).toString();
}
function fixed(value: string, scale: number) {
  const [integer, decimals = ''] = value.split('.');
  return `${integer}.${decimals.padEnd(scale, '0')}`;
}
function normalizeFingerprint(value: unknown) {
  const result = String(value ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new BadRequestException('来源凭证核对指纹不正确');
  return result;
}
function normalizeTimestamp(value: unknown) {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException('资金资料版本不正确');
  return parsed.toISOString();
}
function hash(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
