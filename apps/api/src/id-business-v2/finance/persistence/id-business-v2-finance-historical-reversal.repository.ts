import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Amount4, Rate8, type V2CommandTransaction } from '../../runtime/public-api';
import {
  historicalCashSourceLineFingerprint,
  type HistoricalCashSourceJournal
} from '../id-business-v2-historical-cash.types';
import { findLockedJournalReplay } from './id-business-v2-finance-posting.repository';

// Called only after claiming the original's reversal. Current reads see corrections committed while waiting for that source lock.
export async function findHistoricalCashCostCorrections(
  tx: V2CommandTransaction,
  original: HistoricalCashSourceJournal
) {
  const sourceLines = original.lines.filter(
    (line) =>
      line.accountCode === 'cash' &&
      line.direction === 'credit' &&
      line.currency !== 'CNY' &&
      line.financeAccountId &&
      !Amount4.from(String(line.amountOriginal)).isZero()
  );
  if (!sourceLines.length) return [];
  const keys = await tx.$queryRaw<Array<{ idempotencyKey: string }>>`
    SELECT \`idempotency_key\` AS \`idempotencyKey\` FROM \`id_business_v2_finance_journals\`
    WHERE \`source_type\` = 'historical_backfill'
      AND \`source_id\` IN (${Prisma.join(sourceLines.map((line) => line.id))})
      AND (\`idempotency_key\` LIKE 'historical_cash:restate_foreign_cash_cost:%'
        OR JSON_UNQUOTE(JSON_EXTRACT(\`metadata\`, '$.historicalCashAdjustment.kind')) = 'restate_foreign_cash_cost')
    ORDER BY \`id\` FOR UPDATE
  `;
  const corrections: Array<NonNullable<Awaited<ReturnType<typeof findLockedJournalReplay>>>> = [];
  for (const { idempotencyKey } of keys) {
    const correction = await findLockedJournalReplay(tx, idempotencyKey);
    if (!correction) throw new ConflictException('历史现金成本补偿凭证不存在');
    const meta = record(record(correction.metadata).historicalCashAdjustment);
    const source = sourceLines.find((line) => line.id === meta.originalLineId);
    const cash = correction.lines.find((line) => line.accountCode === 'cash');
    const fx = correction.lines.find((line) => line.accountCode === 'realized_fx_gain_loss');
    const expected = money(meta.expectedBookCostCny);
    const recomputed = money(meta.recomputedBookCostCny);
    const delta = expected?.sub(recomputed ?? Amount4.zero());
    if (
      !source ||
      !cash ||
      !fx ||
      !expected ||
      !recomputed ||
      !delta ||
      delta.isZero() ||
      correction.status !== 'posted' ||
      correction.journalType !== 'manual_adjustment' ||
      correction.sourceId !== source.id ||
      correction.lines.length !== 2 ||
      correction.idempotencyKey !== `historical_cash:restate_foreign_cash_cost:${source.id}` ||
      meta.version !== 1 ||
      meta.kind !== 'restate_foreign_cash_cost' ||
      meta.originalJournalId !== original.id ||
      meta.targetAccountId !== source.financeAccountId ||
      meta.sourceLineFingerprint !== historicalCashSourceLineFingerprint(original, source) ||
      !expected.equals(String(source.amountCny)) ||
      recomputed.isNegative() ||
      cash.financeAccountId !== source.financeAccountId ||
      cash.currency !== source.currency ||
      !Amount4.from(cash.amountOriginal).isZero() ||
      !Amount4.from(cash.amountCny).equals(delta.abs()) ||
      cash.direction !== (delta.gt(0) ? 'debit' : 'credit') ||
      !Rate8.from(cash.fxRateToCny).equals(1) ||
      cash.supplierAccountId ||
      fx.supplierAccountId ||
      fx.financeAccountId !== source.financeAccountId ||
      fx.currency !== 'CNY' ||
      fx.direction === cash.direction ||
      !Amount4.from(fx.amountOriginal).equals(delta.abs()) ||
      !Amount4.from(fx.amountCny).equals(delta.abs()) ||
      !Rate8.from(fx.fxRateToCny).equals(1) ||
      typeof meta.batchHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(meta.batchHash) ||
      typeof meta.idempotencyKey !== 'string' ||
      !correction.createdByUserId
    )
      throw new ConflictException('历史现金成本补偿链不完整，请先核对后再冲销原开支');
    const receipts = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT \`id\` FROM \`audit_logs\`
      WHERE \`action\` = 'id_business_v2.historical_cash.execute'
        AND \`user_id\` = ${correction.createdByUserId}
        AND JSON_UNQUOTE(JSON_EXTRACT(\`after_data\`, '$.idempotencyKey')) = ${meta.idempotencyKey}
        AND JSON_UNQUOTE(JSON_EXTRACT(\`after_data\`, '$.batchHash')) = ${meta.batchHash}
        AND JSON_CONTAINS(JSON_EXTRACT(\`after_data\`, '$.adjustmentJournalIds'), JSON_QUOTE(${correction.id}))
        AND JSON_CONTAINS(JSON_EXTRACT(\`after_data\`, '$.sourceLineIds'), JSON_QUOTE(${source.id}))
      FOR SHARE
    `;
    if (receipts.length !== 1) throw new ConflictException('历史现金成本补偿缺少唯一批次审计');
    corrections.push(correction);
  }
  return corrections;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function money(value: unknown): Amount4 | null {
  if (typeof value !== 'string') return null;
  try {
    return Amount4.from(value);
  } catch {
    return null;
  }
}
