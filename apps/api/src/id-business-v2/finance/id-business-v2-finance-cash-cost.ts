import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { divideDecimalStrings, multiplyDecimalStrings } from '@apple-business/shared';
import { Amount4, Rate8, toV2JsonDocument, type V2CommandTransaction } from '../runtime/public-api';
import type {
  FinancePostingInput,
  NormalizedFinancePostingLine
} from './id-business-v2-finance-posting.service';
import { lockFinanceAccount } from './persistence/id-business-v2-finance-posting.repository';

export type LockedCashAccount = NonNullable<Awaited<ReturnType<typeof lockFinanceAccount>>>;
export function assertCashCostMetadataInput(metadata: FinancePostingInput['metadata']) {
  if (metadata && typeof metadata === 'object' && 'cashHistoricalCost' in metadata) {
    throw new BadRequestException('现金成本依据只能由共享过账服务生成');
  }
}
export interface CashCostEvidence {
  financeAccountId: string;
  currency: string;
  balanceBefore: string;
  balanceBeforeCny: string;
  incomingOriginal: string;
  incomingCny: string;
  creditOriginal: string;
  transactionCreditCny: string;
  carryingCreditCny: string;
  realizedFxCny: string;
  lineAllocations: Array<{
    lineNo: number;
    transactionAmountCny: string;
    transactionFxRateToCny: string;
    transactionFxRateSnapshotId: string | null;
    bookCostCny: string;
  }>;
}

export function cashCostRequestFingerprint(
  input: FinancePostingInput,
  lines: NormalizedFinancePostingLine[]
) {
  return createHash('sha256')
    .update(
      stableJson({
        journalType: input.journalType,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceReference: input.sourceReference ?? null,
        occurredAt: input.occurredAt.toISOString(),
        summary: input.summary,
        metadata: input.metadata ?? null,
        reversalOfJournalId: input.reversalOfJournalId ?? null,
        lines: lines.map((line) => ({
          accountCode: line.accountCode,
          direction: line.direction,
          currency: line.currency,
          amountOriginal: line.amountOriginal.toString(),
          amountCny: line.amountCny.toString(),
          fxRateToCny: line.fxRateToCny.toString(),
          financeAccountId: line.financeAccountId ?? null,
          supplierAccountId: line.supplierAccountId ?? null,
          fxRateSnapshotId: line.fxRateSnapshotId ?? null,
          memo: line.memo ?? null
        }))
      })
    )
    .digest('hex');
}

export function replayCashCostFingerprint(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || !('cashHistoricalCost' in metadata)) return null;
  const evidence = metadata.cashHistoricalCost;
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    !('version' in evidence) ||
    evidence.version !== 1 ||
    !('inputFingerprint' in evidence) ||
    typeof evidence.inputFingerprint !== 'string'
  ) {
    throw new ConflictException('财务现金历史成本凭证缺少可核对的原始请求');
  }
  return evidence.inputFingerprint;
}

export async function lockCashHistoricalCostAccounts(
  tx: V2CommandTransaction,
  input: FinancePostingInput,
  lines: NormalizedFinancePostingLine[]
) {
  // A reversal is an exact mirror of an immutable original, never a new disposal.
  if (
    input.journalType === 'reversal' ||
    !lines.some(
      (line) =>
        line.accountCode === 'cash' &&
        line.financeAccountId &&
        line.direction === 'credit' &&
        line.currency !== 'CNY' &&
        !line.amountOriginal.isZero()
    )
  ) {
    return undefined;
  }
  const accounts = new Map<string, LockedCashAccount>();
  const accountIds = [
    ...new Set(
      lines
        .filter((line) => line.accountCode === 'cash' && line.financeAccountId)
        .map((line) => line.financeAccountId!)
    )
  ].sort();
  for (const id of accountIds) {
    const account = await lockFinanceAccount(tx, id);
    if (!account || account.status !== 'active')
      throw new BadRequestException('资金账户不存在或已停用');
    accounts.set(id, account);
  }
  return accounts;
}

export async function prepareCashHistoricalCost(
  tx: V2CommandTransaction,
  input: FinancePostingInput,
  lines: NormalizedFinancePostingLine[],
  lockedAccounts?: Map<string, LockedCashAccount>
) {
  assertCashCostMetadataInput(input.metadata);
  if (input.journalType === 'reversal')
    return { lines, metadata: input.metadata, accounts: undefined };
  const accounts = lockedAccounts ?? (await lockCashHistoricalCostAccounts(tx, input, lines));
  if (!accounts) return { lines, metadata: input.metadata, accounts: undefined };
  const output = [...lines];
  const evidence: CashCostEvidence[] = [];
  for (const [id, account] of accounts) {
    const cashLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.accountCode === 'cash' && line.financeAccountId === id);
    if (cashLines.some(({ line }) => line.currency !== account.currency))
      throw new BadRequestException('现金分录币种与资金账户不一致');
    const credits = cashLines.filter(
      ({ line }) => line.direction === 'credit' && !line.amountOriginal.isZero()
    );
    if (account.currency === 'CNY' || !credits.length) continue;
    if (
      account.currentBalance.isNegative() ||
      account.currentBalanceCny.isNegative() ||
      account.currentBalance.isZero() !== account.currentBalanceCny.isZero()
    )
      throw new ConflictException('外币资金账户历史成本异常，请先核对');
    const incoming = cashLines.filter(({ line }) => line.direction === 'debit');
    const incomingOriginal = sum(incoming.map(({ line }) => line.amountOriginal));
    const incomingCny = sum(incoming.map(({ line }) => line.amountCny));
    const quantity = account.currentBalance.add(incomingOriginal);
    const cost = account.currentBalanceCny.add(incomingCny);
    const creditOriginal = sum(credits.map(({ line }) => line.amountOriginal));
    if (creditOriginal.gt(quantity)) throw new ConflictException('资金账户余额不足');
    if (quantity.lte(0) || cost.lte(0))
      throw new ConflictException('外币资金账户历史成本异常，请先核对');
    const carryingCost = creditOriginal.equals(quantity)
      ? cost
      : proportional(cost, creditOriginal, quantity);
    if (!creditOriginal.equals(quantity) && carryingCost.gte(cost))
      throw new ConflictException('剩余外币现金成本低于金额精度，请核对或全额结转');
    const bookRate = cost.ratio(quantity);
    if (bookRate.lte(0)) throw new ConflictException('外币现金历史成本低于汇率精度，请先核对');
    let remainingCost = carryingCost;
    let remainingQuantity = creditOriginal;
    const allocations: CashCostEvidence['lineAllocations'] = [];
    for (const { line, index } of credits) {
      const allocated = line.amountOriginal.equals(remainingQuantity)
        ? remainingCost
        : proportional(remainingCost, line.amountOriginal, remainingQuantity);
      allocations.push({
        lineNo: index + 1,
        transactionAmountCny: line.amountCny.toString(),
        transactionFxRateToCny: line.fxRateToCny.toString(),
        transactionFxRateSnapshotId: line.fxRateSnapshotId ?? null,
        bookCostCny: allocated.toString()
      });
      output[index] = {
        ...line,
        amountCny: allocated,
        fxRateToCny: bookRate,
        fxRateSnapshotId: null
      };
      remainingCost = remainingCost.sub(allocated);
      remainingQuantity = remainingQuantity.sub(line.amountOriginal);
    }
    const transactionCost = sum(credits.map(({ line }) => line.amountCny));
    const gain = transactionCost.sub(carryingCost);
    if (!gain.isZero())
      output.push({
        accountCode: 'realized_fx_gain_loss',
        direction: gain.gt(0) ? 'credit' : 'debit',
        currency: 'CNY',
        amountOriginal: gain.abs(),
        amountCny: gain.abs(),
        fxRateToCny: Rate8.one(),
        financeAccountId: id,
        memo: '外币现金按历史成本结转与本次交易价值差额'
      });
    evidence.push({
      financeAccountId: id,
      currency: account.currency,
      balanceBefore: account.currentBalance.toString(),
      balanceBeforeCny: account.currentBalanceCny.toString(),
      incomingOriginal: incomingOriginal.toString(),
      incomingCny: incomingCny.toString(),
      creditOriginal: creditOriginal.toString(),
      transactionCreditCny: transactionCost.toString(),
      carryingCreditCny: carryingCost.toString(),
      realizedFxCny: gain.toString(),
      lineAllocations: allocations
    });
  }
  const base =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : { originalMetadata: input.metadata ?? null };
  return {
    lines: output,
    metadata: toV2JsonDocument({
      ...base,
      cashHistoricalCost: {
        version: 1,
        inputFingerprint: cashCostRequestFingerprint(input, lines),
        accounts: evidence
      }
    }),
    accounts
  };
}

function sum(amounts: Amount4[]) {
  return amounts.reduce((total, amount) => total.add(amount), Amount4.zero());
}
function proportional(cost: Amount4, quantity: Amount4, totalQuantity: Amount4) {
  return Amount4.from(
    divideDecimalStrings(
      multiplyDecimalStrings(cost.toString(), quantity.toString(), 8),
      totalQuantity.toString(),
      4
    )
  );
}
function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
