import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toIdBusinessV2BusinessDate
} from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import {
  createHistoricalCashMysqlFixtures,
  type HistoricalCashMysqlFixtures
} from './persistence/historical-cash-mysql.fixtures';
import { IdBusinessV2HistoricalCashService } from './id-business-v2-historical-cash.service';
import {
  historicalCashSourceFingerprint,
  type HistoricalCashBatch
} from './id-business-v2-historical-cash.types';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2HistoricalCashRepository } from './persistence/id-business-v2-historical-cash.repository';

const url = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('historical cash immutable compensation real MySQL', () => {
  let prisma: PrismaService;
  let service: IdBusinessV2HistoricalCashService;
  let fixtures: HistoricalCashMysqlFixtures;
  let operator: AuthenticatedUser;
  let adminRoleId: string;
  const accountIds: string[] = [];
  const orderIds: string[] = [];
  const evidence = 'synthetic-disposable-bank-evidence';
  const key = () => randomUUID();
  const serial = (value: unknown) => JSON.stringify(value);

  function command(
    audit = new V2TransactionalAuditService(),
    repository = new IdBusinessV2FinanceCommandRepository()
  ) {
    return new IdBusinessV2HistoricalCashService(
      new V2CommandTransactionManager(prisma),
      new IdBusinessV2HistoricalCashRepository(),
      repository,
      new IdBusinessV2FinancePostingService(repository),
      audit
    );
  }

  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.protocol !== 'mysql:' ||
      target.hostname !== '127.0.0.1' ||
      !/^\/id_business_v2_financial_integrity_\d+$/.test(target.pathname)
    )
      throw new Error('只允许本机隔离财务验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    const prepared = await createHistoricalCashMysqlFixtures(prisma, accountIds, orderIds);
    operator = prepared.operator;
    adminRoleId = prepared.adminRoleId;
    fixtures = prepared.fixtures;
    service = command();
  });

  afterAll(async () => {
    // Original journals and lines are immutable, including synthetic negatives.
    // The enclosing harness destroys the entire disposable container after this phase.
    await prisma?.$disconnect();
  });

  const account = (...args: Parameters<HistoricalCashMysqlFixtures['account']>) =>
    fixtures.account(...args);
  const source = (...args: Parameters<HistoricalCashMysqlFixtures['source']>) =>
    fixtures.source(...args);
  const order = (...args: Parameters<HistoricalCashMysqlFixtures['order']>) =>
    fixtures.order(...args);

  type Account = Awaited<ReturnType<typeof account>>;
  type Source = Awaited<ReturnType<typeof source>>;
  const snapshot = (row: Account) => ({
    accountId: row.id,
    expectedUpdatedAt: row.updatedAt.toISOString(),
    expectedBalanceOriginal: row.currentBalance.toString(),
    expectedBalanceCny: row.currentBalanceCny.toString()
  });
  const assign = (row: Source, target: Account) => ({
    kind: 'assign_unassigned_cash' as const,
    sourceLineId: row.lines[0]!.id,
    sourceFingerprint: historicalCashSourceFingerprint(row),
    targetAccountId: target.id,
    evidenceReference: evidence
  });
  const batch = (rows: Source[], target: Account): HistoricalCashBatch => ({
    idempotencyKey: key(),
    reason: '已核对原始收支且未重复记账',
    evidenceReference: evidence,
    accounts: [snapshot(target)],
    adjustments: rows.map((row) => assign(row, target))
  });
  const state = () => fixtures.state();
  async function unchanged(run: () => Promise<unknown>, message?: string) {
    const before = serial(await state());
    if (message) await expect(run()).rejects.toThrow(message);
    else await expect(run()).rejects.toThrow();
    expect(serial(await state())).toBe(before);
  }
  const cashTotal = (original = false) => fixtures.cashTotal(original);

  it('assigns receipt/refund/extra expense in one +1340 batch without changing originals or total cash', async () => {
    const target = await account();
    const completed = await order('completed', '1350');
    const refunded = await order('refunded', '130');
    const rows = await Promise.all([
      source('1350', 'debit', completed.id),
      source('130', 'debit', refunded.id),
      source('130', 'credit', refunded.id),
      source('10', 'credit', refunded.id)
    ]);
    const total = await cashTotal();
    const input = {
      ...batch(rows, target),
      orderAttributions: [completed, refunded].map((row) => ({
        orderId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        targetAccountId: target.id
      }))
    };
    const result = await service.execute(input, operator);
    expect(result.adjustmentJournalIds).toHaveLength(4);
    expect(result.replayed).toBe(false);
    const after = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: target.id }
    });
    expect(after.currentBalance.toString()).toBe('4340');
    expect(after.currentBalanceCny.toString()).toBe('4340');
    expect(await cashTotal()).toBe(total);
    expect(
      await fixtures.cashAudit([...rows.map((row) => row.id), ...result.adjustmentJournalIds])
    ).toEqual({ cashSource: [], historicalCost: [], compensation: [], accountBalance: [] });
    for (const row of rows)
      expect(
        serial(
          await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
            where: { id: row.id },
            include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
          })
        )
      ).toBe(serial(row));
    for (const row of [completed, refunded]) {
      const repaired = await prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id: row.id } });
      expect(repaired.receivedFinanceAccountId).toBe(target.id);
      expect(repaired.receivedAmount.toString()).toBe(row.receivedAmount.toString());
      expect(repaired.profitAmount?.toString() ?? null).toBe(row.profitAmount?.toString() ?? null);
      expect(repaired.status).toBe(row.status);
      expect(
        serial({
          ...repaired,
          receivedFinanceAccountId: row.receivedFinanceAccountId,
          updatedByUserId: row.updatedByUserId,
          updatedAt: row.updatedAt
        })
      ).toBe(serial(row));
    }
    const auditCount = await prisma.auditLog.count({ where: { userId: operator.id } });
    expect(auditCount).toBeGreaterThan(0);
    const replay = await service.execute(input, operator);
    expect(replay).toMatchObject({
      adjustmentJournalIds: result.adjustmentJournalIds,
      replayed: true
    });
    expect(await prisma.auditLog.count({ where: { userId: operator.id } })).toBe(auditCount);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: target.id } })
      ).currentBalance.toString()
    ).toBe('4340');
    await unchanged(() => service.execute({ ...input, reason: '同键修改核对原因' }, operator));
  });

  it('applies all three carrying-cost deltas with one initial CAS per shared account and zero quantity', async () => {
    const usdt = await account('USDT', '1612.96', '10782.3526', '1670', '11163.0810');
    const myr = await account('MYR', '9878', '16292.1432', '9918', '16358.4999');
    const values = [
      [usdt, '51.5', '343.6173', '344.2256'],
      [myr, '40', '66.3567', '65.9750'],
      [usdt, '5.54', '37.1111', '37.0293']
    ] as const;
    const sources: Source[] = [];
    for (const [target, quantity, oldCost] of values)
      sources.push(await fixtures.expenseSource(target, quantity, oldCost));
    const quantityBefore = await cashTotal(true);
    const originalRows = await prisma.idBusinessV2FinanceExpense.findMany({
      where: { journalId: { in: sources.map((row) => row.id) } },
      orderBy: { id: 'asc' }
    });
    const input: HistoricalCashBatch = {
      idempotencyKey: key(),
      reason: '核对外币历史持有成本',
      evidenceReference: evidence,
      accounts: [snapshot(usdt), snapshot(myr)],
      adjustments: sources.map((row, index) => ({
        kind: 'restate_foreign_cash_cost',
        sourceLineId: row.lines[0]!.id,
        sourceFingerprint: historicalCashSourceFingerprint(row),
        expectedBookCostCny: values[index]![2],
        recomputedBookCostCny: values[index]![3],
        evidenceReference: evidence
      }))
    };
    const result = await service.execute(input, operator);
    expect(result.adjustmentJournalIds).toHaveLength(3);
    expect(
      await fixtures.cashAudit([...sources.map((row) => row.id), ...result.adjustmentJournalIds])
    ).toEqual({ cashSource: [], historicalCost: [], compensation: [], accountBalance: [] });
    const afterUsdt = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: usdt.id }
    });
    const afterMyr = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: myr.id }
    });
    expect([afterUsdt.currentBalance.toString(), afterUsdt.currentBalanceCny.toString()]).toEqual([
      '1612.96',
      '10781.8261'
    ]);
    expect([afterMyr.currentBalance.toString(), afterMyr.currentBalanceCny.toString()]).toEqual([
      '9878',
      '16292.5249'
    ]);
    expect(await cashTotal(true)).toBe(quantityBefore);
    const adjusted = await prisma.idBusinessV2FinanceJournal.findMany({
      where: { id: { in: result.adjustmentJournalIds } },
      include: { lines: true }
    });
    expect(
      adjusted
        .flatMap((row) => row.lines)
        .filter((line) => line.accountCode === 'cash')
        .every((line) => line.amountOriginal.isZero())
    ).toBe(true);
    expect(
      serial(
        await prisma.idBusinessV2FinanceExpense.findMany({
          where: { journalId: { in: sources.map((row) => row.id) } },
          orderBy: { id: 'asc' }
        })
      )
    ).toBe(serial(originalRows));
    for (const row of sources)
      expect(
        serial(
          await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
            where: { id: row.id },
            include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
          })
        )
      ).toBe(serial(row));

    const correction = adjusted.find(
      (row) =>
        (row.metadata as { historicalCashAdjustment?: { originalLineId?: string } } | null)
          ?.historicalCashAdjustment?.originalLineId === sources[0]!.lines[0]!.id
    );
    expect(correction).toBeDefined();
    const reverseKey = key();
    const posting = new IdBusinessV2FinancePostingService(
      new IdBusinessV2FinanceCommandRepository()
    );
    const reverse = () =>
      new V2CommandTransactionManager(prisma).execute(
        (tx) => posting.reverse(tx, sources[0]!.id, '合成已补偿开支完整冲销', reverseKey, operator),
        { changedScopes: ['finance-accounts', 'finance-ledger'], requestId: key(), operator }
      );
    const reversed = await reverse();
    expect((await reverse()).id).toBe(reversed.id);
    const restored = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: usdt.id }
    });
    expect([restored.currentBalance.toString(), restored.currentBalanceCny.toString()]).toEqual([
      '1664.46',
      '11126.0517'
    ]);
    const reversedOriginals = await prisma.idBusinessV2FinanceJournal.findMany({
      where: { id: { in: [sources[0]!.id, correction!.id] } }
    });
    expect(reversedOriginals.every((row) => row.status === 'reversed')).toBe(true);
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { reversalOfJournalId: { in: [sources[0]!.id, correction!.id] } }
      })
    ).toBe(2);
    expect(
      await fixtures.cashAudit([...sources.map((row) => row.id), ...result.adjustmentJournalIds])
    ).toEqual({ cashSource: [], historicalCost: [], compensation: [], accountBalance: [] });
  });

  it('records equal-cost verification without cash mutation or zero journal, and rejects another batch claim', async () => {
    const target = await account('MYR', '100', '160', '101', '161.6');
    const row = await fixtures.expenseSource(target, '1', '1.6');
    const input: HistoricalCashBatch = {
      idempotencyKey: key(),
      reason: '确认原开支持有成本一致',
      evidenceReference: evidence,
      accounts: [snapshot(target)],
      adjustments: [
        {
          kind: 'restate_foreign_cash_cost',
          sourceLineId: row.lines[0]!.id,
          sourceFingerprint: historicalCashSourceFingerprint(row),
          expectedBookCostCny: '1.6',
          recomputedBookCostCny: '1.6',
          evidenceReference: evidence
        }
      ]
    };
    const before = await state();
    const result = await service.execute(input, operator);
    expect(result.adjustmentJournalIds).toHaveLength(0);
    expect(await fixtures.cashAudit([row.id])).toEqual({
      cashSource: [],
      historicalCost: [],
      compensation: [],
      accountBalance: []
    });
    const after = await state();
    expect(serial(after.accounts)).toBe(serial(before.accounts));
    expect(serial(after.journals)).toBe(serial(before.journals));
    expect(after.audits.length).toBe(before.audits.length + 2);
    expect(
      after.audits.some(
        (audit) =>
          audit.action === 'id_business_v2.historical_cash.verify' &&
          audit.objectId === row.lines[0]!.id
      )
    ).toBe(true);
    expect((await service.execute(input, operator)).replayed).toBe(true);
    expect(serial(await state())).toBe(serial(after));
    await unchanged(() => service.execute({ ...input, idempotencyKey: key() }, operator));
  });

  it('closes compensation competing with source expense reversal without an orphan posted correction', async () => {
    const target = await account('USDT', '98', '736', '100', '750');
    const row = await fixtures.expenseSource(target, '2', '14');
    const input: HistoricalCashBatch = {
      idempotencyKey: key(),
      reason: '合成原开支与历史补偿并发核对',
      evidenceReference: evidence,
      accounts: [snapshot(target)],
      adjustments: [
        {
          kind: 'restate_foreign_cash_cost',
          sourceLineId: row.lines[0]!.id,
          sourceFingerprint: historicalCashSourceFingerprint(row),
          expectedBookCostCny: '14',
          recomputedBookCostCny: '15',
          evidenceReference: evidence
        }
      ]
    };
    const posting = new IdBusinessV2FinancePostingService(
      new IdBusinessV2FinanceCommandRepository()
    );
    const reverseKey = key();
    const reverse = (tx: Parameters<IdBusinessV2FinancePostingService['reverse']>[0]) =>
      posting.reverse(tx, row.id, '合成并发开支冲销', reverseKey, operator);
    const [compensated, reversed] = await Promise.allSettled([
      service.execute(input, operator),
      new V2CommandTransactionManager(prisma).execute(reverse, {
        changedScopes: ['finance-accounts', 'finance-ledger'],
        requestId: key(),
        operator,
        retryMode: 'fullReplay',
        idempotencyKey: reverseKey,
        replay: reverse,
        maxWriteConflictRetries: 8,
        maxWaitMs: 15000,
        timeoutMs: 15000
      })
    ]);
    expect(reversed.status).toBe('fulfilled');
    if (compensated.status === 'rejected')
      expect(compensated.reason).toBeInstanceOf(ConflictException);
    const corrections = await prisma.idBusinessV2FinanceJournal.findMany({
      where: { idempotencyKey: `historical_cash:restate_foreign_cash_cost:${row.lines[0]!.id}` }
    });
    expect(corrections).toHaveLength(compensated.status === 'fulfilled' ? 1 : 0);
    expect(corrections.every((correction) => correction.status === 'reversed')).toBe(true);
    const restored = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: target.id }
    });
    expect([restored.currentBalance.toString(), restored.currentBalanceCny.toString()]).toEqual([
      '100',
      '750'
    ]);
    const original = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { id: row.id },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    expect(original.status).toBe('reversed');
    expect(serial(original.lines)).toBe(serial(row.lines));
    expect(
      await fixtures.cashAudit([row.id, ...corrections.map((correction) => correction.id)])
    ).toEqual({ cashSource: [], historicalCost: [], compensation: [], accountBalance: [] });
  }, 15000);

  it('rolls back journal, account and audit on an audit failure', async () => {
    const target = await account();
    const input = batch([await source()], target);
    const audit = new V2TransactionalAuditService();
    const fault = vi.spyOn(audit, 'append').mockImplementationOnce(() => {
      throw new Error('synthetic-historical-audit-failure');
    });
    try {
      await unchanged(
        () => command(audit).execute(input, operator),
        'synthetic-historical-audit-failure'
      );
    } finally {
      fault.mockRestore();
    }
    const unrelated = await prisma.auditLog.create({
      data: {
        userId: operator.id,
        module: 'synthetic-historical-fixture',
        action: 'unrelated_receipt'
      }
    });
    const append = audit.append.bind(audit);
    const missingReceipt = vi
      .spyOn(audit, 'append')
      .mockImplementation((tx, value) =>
        value.action === 'id_business_v2.historical_cash.execute'
          ? tx.auditLog.findUniqueOrThrow({ where: { id: unrelated.id } })
          : append(tx, value)
      );
    try {
      const committed = await command(audit).execute(input, operator);
      const sourceJournal = await prisma.idBusinessV2FinanceJournalLine.findUniqueOrThrow({
        where: { id: input.adjustments[0]!.sourceLineId }
      });
      const detected = await fixtures.cashAudit([
        sourceJournal.journalId,
        ...committed.adjustmentJournalIds
      ]);
      expect(detected.cashSource).toContain(sourceJournal.id);
      expect(detected.cashSource).toHaveLength(2);
      expect(detected.compensation).toEqual(committed.adjustmentJournalIds);
    } finally {
      missingReceipt.mockRestore();
    }
  });

  it('rolls back the whole batch when the second adjustment fails after the first', async () => {
    const target = await account();
    const input = batch([await source('10'), await source('20')], target);
    const repository = new IdBusinessV2FinanceCommandRepository();
    const create = repository.createJournal.bind(repository);
    let calls = 0;
    const spy = vi.spyOn(repository, 'createJournal').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('synthetic-historical-second-write-failure');
      return create(...args);
    });
    try {
      await unchanged(
        () => command(new V2TransactionalAuditService(), repository).execute(input, operator),
        'synthetic-historical-second-write-failure'
      );
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('allows exactly one concurrent batch to claim a source', async () => {
    const target = await account();
    const input = batch([await source('22')], target);
    const results = await Promise.allSettled([
      service.execute(input, operator),
      service.execute({ ...input, idempotencyKey: key() }, operator)
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: target.id } })
      ).currentBalance.toString()
    ).toBe('3022');
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: {
          idempotencyKey: `historical_cash:assign_unassigned_cash:${input.adjustments[0]!.sourceLineId}`
        }
      })
    ).toBe(1);
  });

  it('rejects stale account CAS without writes', async () => {
    const target = await account();
    const input = batch([await source()], target);
    input.accounts[0]!.expectedBalanceCny = '2999';
    await unchanged(() => service.execute(input, operator));
  });

  it('rejects order cash attribution that omits restoring the frozen order receipt account', async () => {
    const target = await account();
    const row = await order('completed', '20');
    const input = batch([await source('20', 'debit', row.id)], target);
    await unchanged(() => service.execute(input, operator));
  });

  it('rejects closed current period without writes and restores only its own test period', async () => {
    const target = await account();
    const input = batch([await source()], target);
    const month = toIdBusinessV2BusinessDate(new Date()).month;
    const previous = await prisma.idBusinessV2FinancePeriod.findUnique({ where: { month } });
    await prisma.idBusinessV2FinancePeriod.upsert({
      where: { month },
      create: { month, status: 'closed' },
      update: { status: 'closed' }
    });
    try {
      await unchanged(() => service.execute(input, operator), '已关账');
    } finally {
      if (previous)
        await prisma.idBusinessV2FinancePeriod.update({
          where: { month },
          data: { status: previous.status }
        });
      else await prisma.idBusinessV2FinancePeriod.delete({ where: { month } });
    }
  });

  it.each(['disabled', 'cross_currency'] as const)(
    'rejects %s attribution account without writes',
    async (kind) => {
      let target = await account(kind === 'cross_currency' ? 'USDT' : 'CNY');
      if (kind === 'disabled')
        target = await prisma.idBusinessV2FinanceAccount.update({
          where: { id: target.id },
          data: { status: 'disabled' }
        });
      const input = batch([await source()], target);
      await unchanged(() => service.execute(input, operator));
    }
  );

  it('rejects changed original fingerprint without writes', async () => {
    const target = await account();
    const input = batch([await source()], target);
    input.adjustments[0]!.sourceFingerprint = '0'.repeat(64);
    await unchanged(() => service.execute(input, operator));
  });

  it('rejects a posted source with an existing reversal even when its status is inconsistent', async () => {
    const target = await account();
    const row = await source();
    const input = batch([row], target);
    await fixtures.existingReversal(row);
    await unchanged(() => service.execute(input, operator));
  });

  it('rejects a caller spoofing admin roles when the real database grants no permission', async () => {
    const target = await account();
    const input = batch([await source()], target);
    await prisma.userRole.delete({
      where: { userId_roleId: { userId: operator.id, roleId: adminRoleId } }
    });
    try {
      await unchanged(() =>
        service.execute(input, {
          ...operator,
          roles: ['admin', 'super_admin'],
          permissions: ['finance.view', 'finance.post', 'finance.adjust']
        })
      );
    } finally {
      await prisma.userRole.create({ data: { userId: operator.id, roleId: adminRoleId } });
    }
  });
});
