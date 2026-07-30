import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import {
  IdBusinessV2FinanceAccountCode,
  IdBusinessV2FinanceCurrency,
  IdBusinessV2FinanceJournalType,
  IdBusinessV2FinanceLineDirection,
  IdBusinessV2FinanceSourceType,
  Prisma as PrismaNamespace
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
import { toKualaLumpurBusinessDate } from './id-business-v2-finance-input';

export interface FinancePostingLineInput {
  accountCode: IdBusinessV2FinanceAccountCode;
  direction: IdBusinessV2FinanceLineDirection;
  currency: IdBusinessV2FinanceCurrency;
  amountOriginal: PrismaNamespace.Decimal.Value;
  fxRateToCny: PrismaNamespace.Decimal.Value;
  amountCny: PrismaNamespace.Decimal.Value;
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
  metadata?: Prisma.InputJsonValue;
  reversalOfJournalId?: string | null;
  idempotencyKey: string;
  operator?: AuthenticatedUser;
  lines: FinancePostingLineInput[];
}

@Injectable()
export class IdBusinessV2FinancePostingService {
  async post(tx: Prisma.TransactionClient, input: FinancePostingInput) {
    const replay = await tx.idBusinessV2FinanceJournal.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    if (replay) return replay;

    if (input.lines.length < 2) throw new BadRequestException('财务日记至少需要两条分录');
    const normalizedLines = input.lines.map((line, index) => {
      const amountOriginal = roundV2Decimal(line.amountOriginal);
      const amountCny = roundV2Decimal(line.amountCny);
      const fxRateToCny = new PrismaNamespace.Decimal(String(line.fxRateToCny)).toDecimalPlaces(
        8,
        PrismaNamespace.Decimal.ROUND_HALF_UP
      );
      if (amountOriginal.lt(0) || amountCny.lt(0) || fxRateToCny.lte(0)) {
        throw new BadRequestException(`第 ${index + 1} 条分录金额或汇率不正确`);
      }
      return { ...line, amountOriginal, amountCny, fxRateToCny };
    });
    const debit = normalizedLines
      .filter((line) => line.direction === 'debit')
      .reduce((total, line) => total.add(line.amountCny), new PrismaNamespace.Decimal(0));
    const credit = normalizedLines
      .filter((line) => line.direction === 'credit')
      .reduce((total, line) => total.add(line.amountCny), new PrismaNamespace.Decimal(0));
    if (!debit.equals(credit)) {
      throw new BadRequestException(
        `财务日记借贷不平：借 ${toV2DecimalString(debit)}，贷 ${toV2DecimalString(credit)}`
      );
    }

    const business = toKualaLumpurBusinessDate(input.occurredAt);
    const period = await tx.idBusinessV2FinancePeriod.findUnique({
      where: { month: business.month },
      select: { status: true }
    });
    if (period?.status === 'closed') {
      throw new ConflictException(`${business.month} 已关账，请先重新打开月份`);
    }

    const journalId = randomUUID();
    const journal = await tx.idBusinessV2FinanceJournal.create({
      data: {
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
            amountOriginal: line.amountOriginal,
            fxRateToCny: line.fxRateToCny,
            amountCny: line.amountCny,
            financeAccountId: line.financeAccountId,
            supplierAccountId: line.supplierAccountId,
            fxRateSnapshotId: line.fxRateSnapshotId,
            memo: line.memo
          }))
        }
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    await this.applyFinanceAccountMovements(tx, normalizedLines);
    return journal;
  }

  async reverse(
    tx: Prisma.TransactionClient,
    journalId: string,
    reason: string,
    idempotencyKey: string,
    operator?: AuthenticatedUser
  ) {
    const existingReplay = await tx.idBusinessV2FinanceJournal.findUnique({
      where: { idempotencyKey },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    if (existingReplay) return existingReplay;

    const original = await tx.idBusinessV2FinanceJournal.findUnique({
      where: { id: journalId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
    });
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
    await tx.idBusinessV2FinanceJournal.update({
      where: { id: original.id },
      data: { status: 'reversed', reversedAt: now }
    });
    return tx.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { id: reversal.id },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
  }

  private async applyFinanceAccountMovements(
    tx: Prisma.TransactionClient,
    lines: Array<
      FinancePostingLineInput & {
        amountOriginal: PrismaNamespace.Decimal;
        amountCny: PrismaNamespace.Decimal;
      }
    >
  ) {
    const movements = new Map<
      string,
      { original: PrismaNamespace.Decimal; cny: PrismaNamespace.Decimal }
    >();
    for (const line of lines) {
      if (!line.financeAccountId || line.accountCode !== 'cash') continue;
      const sign = line.direction === 'debit' ? 1 : -1;
      const current = movements.get(line.financeAccountId) ?? {
        original: new PrismaNamespace.Decimal(0),
        cny: new PrismaNamespace.Decimal(0)
      };
      current.original = current.original.add(line.amountOriginal.mul(sign));
      current.cny = current.cny.add(line.amountCny.mul(sign));
      movements.set(line.financeAccountId, current);
    }
    for (const [accountId, movement] of movements) {
      const account = await tx.idBusinessV2FinanceAccount.findUnique({
        where: { id: accountId },
        select: { id: true, status: true, currentBalance: true }
      });
      if (!account || account.status !== 'active') {
        throw new BadRequestException('资金账户不存在或已停用');
      }
      if (account.currentBalance.add(movement.original).lt(0)) {
        throw new ConflictException('资金账户余额不足');
      }
      await tx.idBusinessV2FinanceAccount.update({
        where: { id: accountId },
        data: {
          currentBalance: { increment: movement.original },
          currentBalanceCny: { increment: movement.cny }
        }
      });
    }
  }

  private buildJournalNo(occurredAt: Date) {
    const date = toKualaLumpurBusinessDate(occurredAt).text.replaceAll('-', '');
    return `F${date}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  }
}
