import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';

const mysqlIntegrationUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const describeMysql = mysqlIntegrationUrl ? describe : describe.skip;

describeMysql('IdBusinessV2FinancePostingService real MySQL integrity', () => {
  let prisma: PrismaService;
  let transactions: V2CommandTransactionManager;
  let posting: IdBusinessV2FinancePostingService;

  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: mysqlIntegrationUrl });
    await prisma.$connect();
    transactions = new V2CommandTransactionManager(prisma);
    posting = new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps posting, rollback, idempotency, and concurrent reversal exact', async () => {
    const financeAccountId = randomUUID();
    await prisma.idBusinessV2FinanceAccount.create({
      data: {
        id: financeAccountId,
        name: '财务完整性真实 MySQL 账户',
        accountType: 'bank',
        currency: 'CNY',
        openingBalance: '100.0000',
        currentBalance: '100.0000',
        openingBalanceCny: '100.0000',
        currentBalanceCny: '100.0000'
      }
    });

    const occurredAt = new Date('2026-08-28T10:00:00.000Z');
    const idempotencyKey = `financial-integrity:post:${randomUUID()}`;
    const postingInput = {
      journalType: 'manual_operating_income' as const,
      sourceType: 'manual' as const,
      sourceId: randomUUID(),
      sourceReference: 'FINANCIAL-INTEGRITY-CONCURRENT',
      occurredAt,
      summary: '真实 MySQL 并发幂等入账',
      metadata: { acceptance: 'financial-integrity' },
      idempotencyKey,
      lines: [
        {
          accountCode: 'cash' as const,
          direction: 'debit' as const,
          currency: 'CNY' as const,
          amountOriginal: '25.4321',
          fxRateToCny: '1',
          amountCny: '25.4321',
          financeAccountId
        },
        {
          accountCode: 'other_operating_revenue' as const,
          direction: 'credit' as const,
          currency: 'CNY' as const,
          amountOriginal: '25.4321',
          fxRateToCny: '1',
          amountCny: '25.4321'
        }
      ]
    };

    const postOnce = () =>
      transactions.execute((tx) => posting.post(tx, postingInput), {
        changedScopes: ['finance-accounts', 'finance-ledger', 'finance-reports'],
        requestId: randomUUID(),
        retryMode: 'fullReplay',
        maxWriteConflictRetries: 8,
        maxWaitMs: 15_000,
        timeoutMs: 15_000,
        idempotencyKey,
        replay: (tx) => posting.post(tx, postingInput)
      });

    const concurrentResults = await Promise.all(Array.from({ length: 8 }, () => postOnce()));
    expect(new Set(concurrentResults.map((journal) => journal.id)).size).toBe(1);
    const journalId = concurrentResults[0]!.id;
    expect(await prisma.idBusinessV2FinanceJournal.count({ where: { idempotencyKey } })).toBe(1);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
          where: { id: financeAccountId },
          select: { currentBalance: true }
        })
      ).currentBalance.toString()
    ).toBe('125.4321');

    const failedKey = `financial-integrity:rollback:${randomUUID()}`;
    await expect(
      transactions.execute(
        async (tx) => {
          await posting.post(tx, {
            ...postingInput,
            sourceId: randomUUID(),
            sourceReference: 'FINANCIAL-INTEGRITY-ROLLBACK',
            summary: '故障注入后必须整体回滚',
            idempotencyKey: failedKey
          });
          throw new Error('financial-integrity-forced-rollback');
        },
        {
          changedScopes: ['finance-accounts', 'finance-ledger', 'finance-reports'],
          requestId: randomUUID()
        }
      )
    ).rejects.toThrow('financial-integrity-forced-rollback');
    expect(
      await prisma.idBusinessV2FinanceJournal.count({ where: { idempotencyKey: failedKey } })
    ).toBe(0);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
          where: { id: financeAccountId },
          select: { currentBalance: true }
        })
      ).currentBalance.toString()
    ).toBe('125.4321');

    const reverseOnce = (key: string) =>
      transactions.execute((tx) => posting.reverse(tx, journalId, '并发冲销验收', key), {
        changedScopes: ['finance-accounts', 'finance-ledger', 'finance-reports'],
        requestId: randomUUID(),
        writeConflictMessage: '并发冲销冲突已被阻止'
      });
    const reversalResults = await Promise.allSettled([
      reverseOnce(`financial-integrity:reverse-a:${randomUUID()}`),
      reverseOnce(`financial-integrity:reverse-b:${randomUUID()}`)
    ]);
    expect(reversalResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(reversalResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = reversalResults.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { reversalOfJournalId: journalId }
      })
    ).toBe(1);
    expect(
      await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
        where: { id: journalId },
        select: { status: true }
      })
    ).toEqual({ status: 'reversed' });
    const finalAccount = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: financeAccountId },
      select: { currentBalance: true, currentBalanceCny: true }
    });
    expect(finalAccount.currentBalance.toString()).toBe('100');
    expect(finalAccount.currentBalanceCny.toString()).toBe('100');
  }, 60_000);
});
