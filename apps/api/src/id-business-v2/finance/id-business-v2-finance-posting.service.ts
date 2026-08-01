import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type {
  IdBusinessV2FinanceAccountCode,
  IdBusinessV2FinanceCurrency,
  IdBusinessV2FinanceJournalType,
  IdBusinessV2FinanceLineDirection,
  IdBusinessV2FinanceSourceType
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  Rate8,
  type V2CommandTransaction,
  type V2DecimalInput,
  type V2JsonDocument
} from '../runtime/public-api';
import { toKualaLumpurBusinessDate } from './id-business-v2-finance-input';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import {
  findLockedFinancePeriodStatus,
  lockFinanceAccount
} from './persistence/id-business-v2-finance-posting.repository';

export interface FinancePostingLineInput {
  accountCode: IdBusinessV2FinanceAccountCode;
  direction: IdBusinessV2FinanceLineDirection;
  currency: IdBusinessV2FinanceCurrency;
  amountOriginal: V2DecimalInput;
  fxRateToCny: V2DecimalInput;
  amountCny: V2DecimalInput;
  financeAccountId?: string | null;
  supplierAccountId?: string | null;
  fxRateSnapshotId?: string | null;
  memo?: string | null;
}

export interface FinancePostingInput {
  journalType: IdBusinessV2FinanceJournalType;
  sourceType: IdBusinessV2FinanceSourceType;
  sourceId?: string | null;
  sourceReference?: string | null;
  occurredAt: Date;
  summary: string;
  metadata?: V2JsonDocument;
  reversalOfJournalId?: string | null;
  idempotencyKey: string;
  operator?: AuthenticatedUser;
  lines: FinancePostingLineInput[];
}

interface NormalizedFinancePostingLine extends Omit<
  FinancePostingLineInput,
  'amountOriginal' | 'fxRateToCny' | 'amountCny'
> {
  amountOriginal: Amount4;
  fxRateToCny: Rate8;
  amountCny: Amount4;
}

interface FinanceJournalReplay {
  id: string;
  journalType: IdBusinessV2FinanceJournalType;
  sourceType: IdBusinessV2FinanceSourceType;
  sourceId: string | null;
  sourceReference: string | null;
  occurredAt: Date;
  summary: string;
  metadata: unknown;
  reversalOfJournalId: string | null;
  lines: Array<{
    lineNo: number;
    accountCode: IdBusinessV2FinanceAccountCode;
    direction: IdBusinessV2FinanceLineDirection;
    currency: IdBusinessV2FinanceCurrency;
    amountOriginal: string;
    fxRateToCny: string;
    amountCny: string;
    financeAccountId: string | null;
    supplierAccountId: string | null;
    fxRateSnapshotId: string | null;
    memo: string | null;
  }>;
}

@Injectable()
export class IdBusinessV2FinancePostingService {
  constructor(private readonly repository: IdBusinessV2FinanceCommandRepository) {}

  async post(tx: V2CommandTransaction, input: FinancePostingInput) {
    if (input.lines.length < 2) throw new BadRequestException('财务日记至少需要两条分录');
    const normalizedLines = input.lines.map((line, index) => this.normalizeLine(line, index));
    this.assertBalanced(normalizedLines);

    const replay = await this.repository.findJournalReplay(tx, input.idempotencyKey);
    if (replay) {
      this.assertReplayMatches(replay, input, normalizedLines);
      return replay;
    }

    const business = toKualaLumpurBusinessDate(input.occurredAt);
    await this.assertPeriodOpen(tx, business.month);

    const journalId = randomUUID();
    const journal = await this.repository.createJournal(tx, {
      id: journalId,
      journalNo: this.buildJournalNo(input.occurredAt),
      journalType: input.journalType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceReference: input.sourceReference,
      businessDate: business.date,
      periodMonth: business.month,
      occurredAt: input.occurredAt,
      summary: input.summary,
      metadata: input.metadata,
      reversalOfJournalId: input.reversalOfJournalId,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.operator?.id,
      lines: {
        create: normalizedLines.map((line, index) => ({
          id: randomUUID(),
          lineNo: index + 1,
          accountCode: line.accountCode,
          direction: line.direction,
          currency: line.currency,
          amountOriginal: line.amountOriginal.toString(),
          fxRateToCny: line.fxRateToCny.toString(),
          amountCny: line.amountCny.toString(),
          financeAccountId: line.financeAccountId,
          supplierAccountId: line.supplierAccountId,
          fxRateSnapshotId: line.fxRateSnapshotId,
          memo: line.memo
        }))
      }
    });
    await this.applyFinanceAccountMovements(tx, normalizedLines);
    return journal;
  }

  async reverse(
    tx: V2CommandTransaction,
    journalId: string,
    reason: string,
    idempotencyKey: string,
    operator?: AuthenticatedUser
  ) {
    const existingReplay = await this.repository.findJournalReplay(tx, idempotencyKey);
    if (existingReplay) {
      if (
        existingReplay.journalType !== 'reversal' ||
        existingReplay.reversalOfJournalId !== journalId ||
        stableJson(existingReplay.metadata ?? null) !==
          stableJson({ reason, originalJournalId: journalId })
      ) {
        throw new ConflictException('冲销幂等键已用于其他内容');
      }
      return existingReplay;
    }

    const original = await this.repository.findJournalForReversal(tx, journalId);
    if (!original) throw new NotFoundException('财务日记不存在');
    if (original.status === 'reversed' || original.reversedBy) {
      throw new ConflictException('该财务日记已经冲销');
    }
    const now = new Date();
    const reversal = await this.post(tx, {
      journalType: 'reversal',
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      sourceReference: original.journalNo,
      occurredAt: now,
      summary: `冲销 ${original.journalNo}：${reason}`,
      metadata: { reason, originalJournalId: original.id },
      reversalOfJournalId: original.id,
      idempotencyKey,
      operator,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        direction: line.direction === 'debit' ? 'credit' : 'debit',
        currency: line.currency,
        amountOriginal: line.amountOriginal,
        fxRateToCny: line.fxRateToCny,
        amountCny: line.amountCny,
        financeAccountId: line.financeAccountId,
        supplierAccountId: line.supplierAccountId,
        fxRateSnapshotId: line.fxRateSnapshotId,
        memo: `冲销 ${original.journalNo}`
      }))
    });
    await this.repository.markJournalReversed(tx, original.id, now);
    return this.repository.findJournalWithLinesOrThrow(tx, reversal.id);
  }

  private normalizeLine(
    line: FinancePostingLineInput,
    index: number
  ): NormalizedFinancePostingLine {
    let amountOriginal: Amount4;
    let amountCny: Amount4;
    let fxRateToCny: Rate8;
    try {
      amountOriginal = Amount4.from(line.amountOriginal);
      amountCny = Amount4.from(line.amountCny);
      fxRateToCny = Rate8.from(line.fxRateToCny);
    } catch {
      throw new BadRequestException(`第 ${index + 1} 条分录金额或汇率不正确`);
    }
    if (amountOriginal.isNegative() || amountCny.isNegative() || fxRateToCny.lte('0')) {
      throw new BadRequestException(`第 ${index + 1} 条分录金额或汇率不正确`);
    }
    return { ...line, amountOriginal, amountCny, fxRateToCny };
  }

  private assertBalanced(lines: NormalizedFinancePostingLine[]) {
    const debit = lines
      .filter((line) => line.direction === 'debit')
      .reduce((total, line) => total.add(line.amountCny), Amount4.zero());
    const credit = lines
      .filter((line) => line.direction === 'credit')
      .reduce((total, line) => total.add(line.amountCny), Amount4.zero());
    if (!debit.equals(credit)) {
      throw new BadRequestException(
        `财务日记借贷不平：借 ${debit.toString()}，贷 ${credit.toString()}`
      );
    }
  }

  private async assertPeriodOpen(tx: V2CommandTransaction, month: string) {
    if ((await findLockedFinancePeriodStatus(tx, month)) === 'closed') {
      throw new ConflictException(`${month} 已关账，请先重新打开月份`);
    }
  }

  private async applyFinanceAccountMovements(
    tx: V2CommandTransaction,
    lines: NormalizedFinancePostingLine[]
  ) {
    const movements = new Map<string, { original: Amount4; cny: Amount4 }>();
    for (const line of lines) {
      if (!line.financeAccountId || line.accountCode !== 'cash') continue;
      const current = movements.get(line.financeAccountId) ?? {
        original: Amount4.zero(),
        cny: Amount4.zero()
      };
      const original =
        line.direction === 'debit' ? line.amountOriginal : line.amountOriginal.negated();
      const cny = line.direction === 'debit' ? line.amountCny : line.amountCny.negated();
      movements.set(line.financeAccountId, {
        original: current.original.add(original),
        cny: current.cny.add(cny)
      });
    }

    for (const accountId of [...movements.keys()].sort()) {
      const movement = movements.get(accountId)!;
      const account = await lockFinanceAccount(tx, accountId);
      if (!account || account.status !== 'active') {
        throw new BadRequestException('资金账户不存在或已停用');
      }
      if (account.currentBalance.add(movement.original).isNegative()) {
        throw new ConflictException('资金账户余额不足');
      }
      await this.repository.incrementFinanceAccount(
        tx,
        accountId,
        movement.original.toString(),
        movement.cny.toString()
      );
    }
  }

  private assertReplayMatches(
    replay: FinanceJournalReplay,
    input: FinancePostingInput,
    lines: NormalizedFinancePostingLine[]
  ) {
    const headerMatches =
      replay.journalType === input.journalType &&
      replay.sourceType === input.sourceType &&
      replay.sourceId === (input.sourceId ?? null) &&
      replay.sourceReference === (input.sourceReference ?? null) &&
      replay.occurredAt.getTime() === input.occurredAt.getTime() &&
      replay.summary === input.summary &&
      replay.reversalOfJournalId === (input.reversalOfJournalId ?? null) &&
      stableJson(replay.metadata ?? null) === stableJson(input.metadata ?? null);
    const linesMatch =
      replay.lines.length === lines.length &&
      replay.lines.every((saved, index) => {
        const expected = lines[index];
        return (
          saved.lineNo === index + 1 &&
          saved.accountCode === expected.accountCode &&
          saved.direction === expected.direction &&
          saved.currency === expected.currency &&
          Amount4.from(saved.amountOriginal).equals(expected.amountOriginal) &&
          Rate8.from(saved.fxRateToCny).equals(expected.fxRateToCny) &&
          Amount4.from(saved.amountCny).equals(expected.amountCny) &&
          saved.financeAccountId === (expected.financeAccountId ?? null) &&
          saved.supplierAccountId === (expected.supplierAccountId ?? null) &&
          saved.fxRateSnapshotId === (expected.fxRateSnapshotId ?? null) &&
          saved.memo === (expected.memo ?? null)
        );
      });
    if (!headerMatches || !linesMatch) {
      throw new ConflictException('财务日记幂等键已用于其他过账内容');
    }
  }

  private buildJournalNo(occurredAt: Date) {
    const date = toKualaLumpurBusinessDate(occurredAt).text.replaceAll('-', '');
    return `F${date}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  }
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
