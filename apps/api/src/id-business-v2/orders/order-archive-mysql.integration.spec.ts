import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2Order } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinanceFxService } from '../finance/id-business-v2-finance-fx.service';
import { IdBusinessV2FinancePostingService } from '../finance/id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from '../finance/persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from '../finance/persistence/id-business-v2-finance-query.repository';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2OrderArchiveService } from './id-business-v2-order-archive.service';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrderConsumptionService } from './id-business-v2-order-consumption.service';
import { IdBusinessV2OrderEntryService } from './id-business-v2-order-entry.service';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const databaseUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const suite = databaseUrl?.includes('/id_business_v2_order_archive_integrity_')
  ? describe.sequential
  : describe.skip;
const key = () => `archive-integration:${randomUUID()}`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type ArchiveCommand = {
  expectedUpdatedAt: string;
  reason: string;
  idempotencyKey: string;
};

// Only synthetic rows in a caller-owned, migrated, disposable local MySQL database.
// No Docker/AWS operation, production connection, trigger disabling or fixture cleanup here.
suite('ordinary order archive/restore real MySQL preservation', () => {
  let prisma: PrismaService;
  let transactions: V2CommandTransactionManager;
  let repository: IdBusinessV2OrdersRepository;
  let archive: IdBusinessV2OrderArchiveService;
  let reads: IdBusinessV2OrdersService;
  let entry: IdBusinessV2OrderEntryService;
  let consume: IdBusinessV2OrderConsumptionService;
  let complete: IdBusinessV2OrderCompletionService;
  let locks: IdBusinessV2OrderLockService;
  let lifecycle: IdBusinessV2OrderLifecycleService;
  let actor: AuthenticatedUser;
  let customerId: string;
  let countryId: string;
  let categoryId: string;
  let serviceId: string;
  let normalId: string;
  let platformId: string;
  let cashId: string;
  let fixtures: IdBusinessV2Order[];
  let pending: IdBusinessV2Order;
  let firstCommand: ArchiveCommand;
  let firstOutcome: Awaited<ReturnType<IdBusinessV2OrderArchiveService['archive']>>;

  async function order(id: string) {
    return prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id } });
  }
  const command = (row: IdBusinessV2Order): ArchiveCommand => ({
    expectedUpdatedAt: row.updatedAt.toISOString(),
    reason: '整理合成历史订单，保留原账与全部资料',
    idempotencyKey: key()
  });

  async function protectedTables() {
    const columns = await prisma.$queryRawUnsafe<
      Array<{ tableName: string; columnName: string }>
    >(`SELECT c.TABLE_NAME tableName,c.COLUMN_NAME columnName
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA
         AND t.TABLE_NAME=c.TABLE_NAME AND t.TABLE_TYPE='BASE TABLE'
       WHERE c.TABLE_SCHEMA=DATABASE() ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION`);
    const ignored = new Set([
      'id_business_v2_orders',
      'audit_logs',
      'id_business_v2_scope_versions'
    ]);
    const tables = new Map<string, string[]>();
    for (const { tableName, columnName } of columns) {
      expect(tableName).toMatch(/^[A-Za-z0-9_]+$/);
      expect(columnName).toMatch(/^[A-Za-z0-9_]+$/);
      if (ignored.has(tableName)) continue;
      tables.set(tableName, [...(tables.get(tableName) ?? []), columnName]);
    }
    const fingerprints: Array<{ table: string; count: number; sha256: string }> = [];
    for (const [table, names] of tables) {
      const expression = names
        .map((name) => `IF(\`${name}\` IS NULL,NULL,HEX(CAST(\`${name}\` AS BINARY)))`)
        .join(',');
      const rows = await prisma.$queryRawUnsafe<Array<{ rowHash: string }>>(
        `SELECT SHA2(JSON_ARRAY(${expression}),256) rowHash FROM \`${table}\` ORDER BY rowHash`
      );
      fingerprints.push({ table, count: rows.length, sha256: hash(rows) });
    }
    return fingerprints;
  }

  async function businessOrders() {
    return hash(
      (await prisma.idBusinessV2Order.findMany({ orderBy: { id: 'asc' } })).map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([name]) => !['archivedAt', 'updatedAt'].includes(name))
        )
      )
    );
  }

  async function integrityCounts() {
    const audit = (await import(
      pathToFileURL(resolve(__dirname, '../../../../../scripts/lib/v2-data-integrity-audit.mjs'))
        .href
    )) as { V2_DATA_INTEGRITY_CHECKS: Array<{ code: string; sql: string }> };
    expect(audit.V2_DATA_INTEGRITY_CHECKS).toHaveLength(49);
    const counts: Array<{ code: string; count: number }> = [];
    for (const rule of audit.V2_DATA_INTEGRITY_CHECKS) {
      const [result] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) count FROM (${rule.sql}) checked_rows`
      );
      counts.push({ code: rule.code, count: Number(result!.count) });
    }
    return counts;
  }

  async function seedOrder(
    status: 'completed' | 'cancelled' | 'pending',
    disposition: 'retained' | 'sold' = 'retained'
  ) {
    const account = await prisma.idBusinessV2Account.create({
      data: {
        appleIdEncrypted: 'synthetic-encrypted-placeholder',
        appleIdHash: randomUUID(),
        appleIdMasked: 'synthetic***@integration.invalid',
        countryOptionId: countryId,
        statusOptionId: normalId,
        currentBalance: '100',
        balanceCostAmount: '100',
        createdByUserId: actor.id
      }
    });
    await prisma.idBusinessV2BalanceLedger.create({
      data: {
        accountId: account.id,
        entryType: 'opening_balance',
        direction: 'credit',
        balanceAmount: '100',
        costAmount: '100',
        balanceBefore: '0',
        balanceAfter: '100',
        costBefore: '0',
        costAfter: '100',
        averageCostBefore: '0',
        averageCostAfter: '1',
        idempotencyKey: key(),
        createdByUserId: actor.id,
        createdAt: new Date('2026-01-01T00:00:00Z')
      }
    });
    const now = new Date();
    // Real entry/consume/completion commands produce snapshots, ledger, locks,
    // activation cache, receipts, journal lines and cash-cost evidence.
    const created = await entry.create(
      {
        customerId,
        serviceOptionId: serviceId,
        accountId: account.id,
        settlementPlatformOptionId: platformId,
        receivedFinanceAccountId: cashId,
        receivedAmount: '100',
        receivedOriginalAmount: '100',
        receivedCurrency: 'CNY',
        balanceAmount: '10',
        openedAt: now.toISOString(),
        dueAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        accountDisposition: disposition,
        idempotencyKey: key()
      },
      actor
    );
    if (status === 'completed') {
      await consume.consume(created.order.id, { idempotencyKey: key() }, actor);
      await complete.complete(created.order.id, actor);
    } else if (status === 'cancelled') {
      await lifecycle.cancel(
        created.order.id,
        { reason: '合成订单取消验收', idempotencyKey: key() },
        actor
      );
    }
    return order(created.order.id);
  }

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    expect(target.hostname).toBe('127.0.0.1');
    expect(target.pathname).toMatch(/^\/id_business_v2_order_archive_integrity_\d+$/);
    prisma = new PrismaService({ datasourceUrl: databaseUrl });
    await prisma.$connect();
    const [actual] = await prisma.$queryRawUnsafe<Array<{ databaseName: string }>>(
      'SELECT DATABASE() databaseName'
    );
    expect(actual!.databaseName).toBe(target.pathname.slice(1));
    const [mode] = await prisma.$queryRawUnsafe<Array<{ sqlMode: string }>>(
      'SELECT @@SESSION.sql_mode sqlMode'
    );
    expect(mode!.sqlMode.split(',')).toContain('ANSI_QUOTES');
    expect(await prisma.idBusinessV2Order.count()).toBe(0);
    transactions = new V2CommandTransactionManager(prisma);
    repository = new IdBusinessV2OrdersRepository(prisma);
    const encryption = new FieldEncryptionService({ get: () => undefined } as never);
    reads = new IdBusinessV2OrdersService(repository, encryption, undefined as never);
    const rowReader = { get: (id: string) => order(id) } as unknown as IdBusinessV2OrdersService;
    const posting = new IdBusinessV2FinancePostingService(
      new IdBusinessV2FinanceCommandRepository()
    );
    locks = new IdBusinessV2OrderLockService(repository, transactions);
    const calculator = new IdBusinessV2BalanceCalculatorService();
    const fx = new IdBusinessV2FinanceFxService(
      transactions,
      new IdBusinessV2FinanceCommandRepository(),
      new IdBusinessV2FinanceQueryRepository(prisma),
      undefined as never,
      undefined as never
    );
    // Only response presentation is replaced; all business mutations are real.
    entry = new IdBusinessV2OrderEntryService(
      repository,
      encryption,
      rowReader,
      locks,
      fx,
      transactions,
      undefined as never
    );
    consume = new IdBusinessV2OrderConsumptionService(
      locks,
      calculator,
      rowReader,
      repository,
      transactions
    );
    complete = new IdBusinessV2OrderCompletionService(rowReader, posting, repository, transactions);
    lifecycle = new IdBusinessV2OrderLifecycleService(
      encryption,
      calculator,
      locks,
      rowReader,
      posting,
      transactions,
      repository
    );
    archive = new IdBusinessV2OrderArchiveService(repository, transactions);
    const user = await prisma.user.create({
      data: {
        username: key(),
        displayName: '合成归档验收管理员',
        passwordHash: 'synthetic-not-login'
      }
    });
    actor = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: ['admin'],
      permissions: ['apple.order.update', 'apple.order.view']
    };
    customerId = (await prisma.idBusinessV2Customer.create({ data: { name: '合成归档客户' } })).id;
    countryId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'country',
          code: key(),
          uniqueKey: key(),
          name: '合成国家',
          currencyCode: 'USD'
        }
      })
    ).id;
    categoryId = (
      await prisma.idBusinessV2Option.create({
        data: { type: 'business_category', code: key(), uniqueKey: key(), name: '合成分类' }
      })
    ).id;
    serviceId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'service',
          code: key(),
          uniqueKey: key(),
          name: '合成服务',
          countryOptionId: countryId,
          parentId: categoryId,
          businessAmount: '10'
        }
      })
    ).id;
    normalId = (
      await prisma.idBusinessV2Option.create({
        data: { type: 'id_status', code: 'normal', uniqueKey: key(), name: '正常' }
      })
    ).id;
    platformId = (
      await prisma.idBusinessV2Option.create({
        data: { type: 'settlement_platform', code: key(), uniqueKey: key(), name: '合成平台' }
      })
    ).id;
    const cash = await prisma.idBusinessV2FinanceAccount.create({
      data: {
        name: '合成归档资金',
        accountType: 'bank',
        currency: 'CNY',
        openingBalance: '1000',
        currentBalance: '1000',
        openingBalanceCny: '1000',
        currentBalanceCny: '1000',
        createdByUserId: actor.id
      }
    });
    cashId = cash.id;
    const expenseCategory = await prisma.idBusinessV2Option.create({
      data: { type: 'expense_category', code: key(), uniqueKey: key(), name: '合成开支分类' }
    });
    const content = Buffer.from('Synthetic archive preservation receipt');
    const receipt = await prisma.attachment.create({
      data: {
        originalName: 'synthetic.pdf',
        storageKey: key(),
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        contentEncrypted: encryption.encrypt(content.toString('base64')),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        createdByUserId: actor.id
      }
    });
    const expenseId = randomUUID();
    const expenseJournal = await transactions.execute(
      (tx) =>
        posting.post(tx, {
          journalType: 'expense',
          sourceType: 'expense',
          sourceId: expenseId,
          occurredAt: new Date(),
          summary: '合成保留手工开支',
          idempotencyKey: key(),
          operator: actor,
          metadata: { receiptAttachmentId: receipt.id },
          lines: [
            {
              accountCode: 'cash',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: '5',
              amountCny: '5',
              fxRateToCny: '1',
              financeAccountId: cashId
            },
            {
              accountCode: 'operating_expense',
              direction: 'debit',
              currency: 'CNY',
              amountOriginal: '5',
              amountCny: '5',
              fxRateToCny: '1'
            }
          ]
        }),
      { changedScopes: ['finance-ledger'], requestId: key() }
    );
    await prisma.idBusinessV2FinanceExpense.create({
      data: {
        id: expenseId,
        journalId: expenseJournal.id,
        categoryOptionId: expenseCategory.id,
        categoryNameSnapshot: expenseCategory.name,
        financeAccountId: cashId,
        financeAccountNameSnapshot: cash.name,
        currency: 'CNY',
        amountOriginal: '5',
        fxRateToCny: '1',
        amountCny: '5',
        occurredAt: expenseJournal.occurredAt,
        receiptAttachmentId: receipt.id,
        idempotencyKey: key(),
        createdByUserId: actor.id
      }
    });
    const inflowId = randomUUID();
    const inflowJournal = await transactions.execute(
      (tx) =>
        posting.post(tx, {
          journalType: 'capital_contribution',
          sourceType: 'inflow',
          sourceId: inflowId,
          occurredAt: new Date(),
          summary: '合成保留手工收款',
          idempotencyKey: key(),
          operator: actor,
          lines: [
            {
              accountCode: 'cash',
              direction: 'debit',
              currency: 'CNY',
              amountOriginal: '15',
              amountCny: '15',
              fxRateToCny: '1',
              financeAccountId: cashId
            },
            {
              accountCode: 'contributed_capital',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: '15',
              amountCny: '15',
              fxRateToCny: '1'
            }
          ]
        }),
      { changedScopes: ['finance-ledger'], requestId: key() }
    );
    await prisma.idBusinessV2FinanceInflow.create({
      data: {
        id: inflowId,
        journalId: inflowJournal.id,
        nature: 'capital_contribution',
        financeAccountId: cashId,
        financeAccountNameSnapshot: cash.name,
        currency: 'CNY',
        amountOriginal: '15',
        fxRateToCny: '1',
        amountCny: '15',
        occurredAt: inflowJournal.occurredAt,
        idempotencyKey: key(),
        createdByUserId: actor.id
      }
    });
    const name = await prisma.idBusinessV2RegistrationName.create({
      data: { displayName: `Synthetic registration ${randomUUID()}`, usageCount: 1 }
    });
    const proxy = await prisma.idBusinessV2RechargeProxy.create({
      data: {
        countryCode: 'US',
        kind: 'static_residential',
        connectionMode: 'direct',
        protocol: 'http',
        urlEncrypted: encryption.encrypt('synthetic.invalid:1234')!,
        urlHash: createHash('sha256').update(key()).digest('hex'),
        createdByUserId: actor.id
      }
    });
    await prisma.idBusinessV2RegistrationJob.create({
      data: {
        ownerId: actor.id,
        mailboxAliasId: key(),
        proxyId: proxy.id,
        nameId: name.id,
        displayName: name.displayName,
        emailEncrypted: encryption.encrypt('synthetic@integration.invalid')!,
        emailHash: createHash('sha256').update(key()).digest('hex'),
        emailMasked: 'synthetic***@integration.invalid',
        birthDateEncrypted: encryption.encrypt('1990-01-01')!,
        passwordEncrypted: encryption.encrypt('synthetic-never-login')!,
        state: 'partial',
        step: 'email_code',
        browserProfileId: 'synthetic-retained-window',
        leaseUntil: new Date(Date.now() + 3_600_000)
      }
    });
    await prisma.idBusinessV2RechargeAddress.create({
      data: { ownerId: actor.id, line1: '100 Synthetic preservation street' }
    });
    await prisma.idBusinessV2RechargeName.create({
      data: {
        nameEncrypted: encryption.encrypt('Synthetic preserved name')!,
        nameHash: createHash('sha256').update(key()).digest('hex')
      }
    });
    fixtures = [
      await seedOrder('completed'),
      await seedOrder('completed'),
      await seedOrder('completed'),
      await seedOrder('cancelled')
    ];
    pending = await seedOrder('pending');
    firstCommand = command(fixtures[0]!);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('starts with all 49 financial and storage checks healthy', async () => {
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
  });

  it('refuses a terminal order with a still valid target lock without changing any stored data', async () => {
    const fixture = fixtures[0]!;
    // Deliberately unsafe synthetic terminal-lock input; release through the real
    // existing command afterwards, without disabling triggers or deleting evidence.
    await prisma.idBusinessV2AccountLock.create({
      data: {
        accountId: fixture.accountId!,
        orderId: fixture.id,
        serviceOptionId: fixture.serviceOptionId,
        lockScope: 'by_service',
        lockToken: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdByUserId: actor.id
      }
    });
    const stored = await order(fixture.id);
    const before = await protectedTables();
    const audits = await prisma.auditLog.count();
    try {
      await expect(archive.archive(fixture.id, command(stored), actor)).rejects.toThrow(/占用|锁/);
      expect(await order(fixture.id)).toEqual(stored);
      expect(await protectedTables()).toEqual(before);
      expect(await prisma.auditLog.count()).toBe(audits);
    } finally {
      await locks.releaseOrderLock(fixture.id, '合成有效占用验收结束', actor);
    }
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
  });

  it('archives four terminal orders while every protected table and business field stays exact', async () => {
    const before = await protectedTables();
    const ordersBefore = await businessOrders();
    for (const [index, fixture] of fixtures.entries()) {
      const result = await archive.archive(
        fixture.id,
        index === 0 ? firstCommand : command(fixture),
        actor
      );
      expect(result.idempotentReplay).toBe(false);
      expect(result.archivedAt).not.toBeNull();
      if (index === 0) firstOutcome = result;
    }
    expect(await protectedTables()).toEqual(before);
    expect(await businessOrders()).toBe(ordersBefore);
    expect(await prisma.auditLog.count({ where: { action: 'id_business_v2.order.archive' } })).toBe(
      4
    );
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
  });

  it('keeps active/archived/all pagination and financial detail access consistent', async () => {
    const active = await reads.list({ page: 1, pageSize: 2 });
    expect(active.total).toBe(1);
    expect(active.items.map((item) => item.id)).toEqual([pending.id]);
    const first = await reads.list({ archived: 'archived', page: 1, pageSize: 2 });
    const last = await reads.list({ archived: 'archived', page: 2, pageSize: 2 });
    expect(first.total).toBe(4);
    expect(last.total).toBe(4);
    expect(new Set([...first.items, ...last.items].map((item) => item.id))).toEqual(
      new Set(fixtures.map((item) => item.id))
    );
    expect((await reads.list({ archived: 'all', page: 1, pageSize: 2 })).total).toBe(5);
    expect((await reads.list({ archived: 'archived', page: 3, pageSize: 2 })).items).toEqual([]);
    const detail = await reads.get(fixtures[0]!.id);
    expect(detail.archivedAt).toBe(firstOutcome.archivedAt);
    expect(detail.status).toBe('completed');
    expect((await order(detail.id)).deletedAt).toBeNull();
  });

  it('replays the original command without rewriting version, audit or scope versions', async () => {
    const audits = await prisma.auditLog.count();
    const scopes = await prisma.idBusinessV2ScopeVersion.findMany({ orderBy: { scope: 'asc' } });
    const afterArchive = await order(fixtures[0]!.id);
    const replay = await archive.archive(fixtures[0]!.id, firstCommand, actor);
    expect(replay).toEqual({ ...firstOutcome, idempotentReplay: true });
    expect(await order(fixtures[0]!.id)).toEqual(afterArchive);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.idBusinessV2ScopeVersion.findMany({ orderBy: { scope: 'asc' } })).toEqual(
      scopes
    );
    await expect(
      archive.archive(fixtures[0]!.id, { ...firstCommand, reason: '同键改变内容' }, actor)
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      archive.archive(fixtures[0]!.id, { ...firstCommand, idempotencyKey: key() }, actor)
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      archive.archive(fixtures[0]!.id, command(afterArchive), actor)
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(archive.unarchive(fixtures[0]!.id, firstCommand, actor)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it('rolls back the archive field and version if its mandatory audit cannot be saved', async () => {
    const id = fixtures[0]!.id;
    const stored = await order(id);
    const protectedBefore = await protectedTables();
    const audits = await prisma.auditLog.count();
    const scopes = await prisma.idBusinessV2ScopeVersion.findMany({ orderBy: { scope: 'asc' } });
    const fault = vi
      .spyOn(repository, 'appendAudit')
      .mockRejectedValueOnce(new Error('synthetic mandatory audit failure'));
    try {
      await expect(archive.unarchive(id, command(stored), actor)).rejects.toThrow(
        'synthetic mandatory audit failure'
      );
    } finally {
      fault.mockRestore();
    }
    expect(await order(id)).toEqual(stored);
    expect(await protectedTables()).toEqual(protectedBefore);
    expect(await prisma.auditLog.count()).toBe(audits);
    expect(await prisma.idBusinessV2ScopeVersion.findMany({ orderBy: { scope: 'asc' } })).toEqual(
      scopes
    );
  });

  it('rejects nonterminal archive and stale restore without any committed write', async () => {
    const before = await protectedTables();
    const pendingBefore = await order(pending.id);
    const audits = await prisma.auditLog.count();
    await expect(archive.archive(pending.id, command(pendingBefore), actor)).rejects.toThrow();
    await expect(
      archive.unarchive(fixtures[0]!.id, command(fixtures[0]!), actor)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await order(pending.id)).toEqual(pendingBefore);
    expect(await protectedTables()).toEqual(before);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it('requires restoring an archived order before ordinary edits, refunds, cancellation or deletion', async () => {
    const id = fixtures[0]!.id;
    const version = (await order(id)).updatedAt.toISOString();
    const before = await protectedTables();
    const stored = await order(id);
    const audits = await prisma.auditLog.count();
    await expect(
      lifecycle.update(id, { expectedUpdatedAt: version, remark: '不允许修改归档订单' }, actor)
    ).rejects.toThrow(/归档|恢复/);
    await expect(
      lifecycle.refund(
        id,
        {
          reason: '不允许归档退款',
          refundCostAmount: '0',
          balanceRefundMode: 'none',
          idempotencyKey: key()
        },
        actor
      )
    ).rejects.toThrow(/归档|恢复/);
    await expect(
      lifecycle.cancel(id, { reason: '不允许归档取消', idempotencyKey: key() }, actor)
    ).rejects.toThrow(/归档|恢复/);
    await expect(lifecycle.remove(id, { reason: '不允许归档删除' }, actor)).rejects.toThrow(
      /归档|恢复/
    );
    await expect(consume.consume(id, { idempotencyKey: key() }, actor)).rejects.toThrow(
      /归档|恢复/
    );
    await expect(complete.complete(id, actor)).rejects.toThrow(/归档|恢复/);
    expect(await order(id)).toEqual(stored);
    expect(await protectedTables()).toEqual(before);
    expect(await prisma.auditLog.count()).toBe(audits);
  });

  it('restores once, keeps original receipts/journals/ledger unchanged and leaves a new order visible', async () => {
    const id = fixtures[0]!.id;
    const current = await order(id);
    const before = await protectedTables();
    const businessBefore = await businessOrders();
    const restoreCommand = { ...command(current), reason: '恢复合成历史订单' };
    const restored = await archive.unarchive(id, restoreCommand, actor);
    expect(restored.archivedAt).toBeNull();
    expect(restored.idempotentReplay).toBe(false);
    expect(await archive.unarchive(id, restoreCommand, actor)).toEqual({
      ...restored,
      idempotentReplay: true
    });
    const currentRestored = await order(id);
    expect(await archive.archive(id, firstCommand, actor)).toEqual({
      ...firstOutcome,
      idempotentReplay: true
    });
    expect(await order(id)).toEqual(currentRestored);
    expect(await protectedTables()).toEqual(before);
    expect(await businessOrders()).toBe(businessBefore);
    expect(
      await prisma.auditLog.count({
        where: { objectId: id, action: 'id_business_v2.order.unarchive' }
      })
    ).toBe(1);
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
    const newlyEntered = await seedOrder('pending');
    expect(newlyEntered.archivedAt).toBeNull();
    const active = await reads.list({ page: 1, pageSize: 20 });
    expect(new Set(active.items.map((row) => row.id))).toEqual(
      new Set([id, pending.id, newlyEntered.id])
    );
    expect((await reads.list({ archived: 'archived', page: 1, pageSize: 20 })).total).toBe(3);
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
  });

  it('keeps an archived original sale available as the source of a later customer-owned request', async () => {
    const source = await seedOrder('completed', 'sold');
    await archive.archive(source.id, command(source), actor);
    const storedSource = await order(source.id);
    const sourceActivation = await prisma.idBusinessV2Activation.findUniqueOrThrow({
      where: { orderId: source.id }
    });
    const account = await prisma.idBusinessV2Account.findUniqueOrThrow({
      where: { id: source.accountId! }
    });
    const journalBefore = await prisma.idBusinessV2FinanceJournal.findMany({
      where: { sourceId: source.id },
      include: { lines: true },
      orderBy: { id: 'asc' }
    });
    const ledgerBefore = await prisma.idBusinessV2BalanceLedger.findMany({
      where: { accountId: account.id },
      orderBy: { id: 'asc' }
    });
    const now = new Date();
    const child = await transactions.execute(
      (tx) =>
        entry.createWaitingExternalOrderInTransaction(
          tx,
          {
            sourceActivationId: sourceActivation.id,
            customerId,
            serviceOptionId: serviceId,
            accountId: account.id,
            settlementPlatformOptionId: platformId,
            receivedFinanceAccountId: cashId,
            platformOrderNo: null,
            websiteAccountEncrypted: null,
            websiteAccountHash: null,
            websiteAccountMasked: null,
            websiteAccountSearchTokens: [],
            receivedAmount: '100',
            balanceAmount: '10',
            openedAt: now,
            dueAt: new Date(now.getTime() + 30 * 86_400_000),
            idempotencyKey: key(),
            remark: null
          },
          actor
        ),
      { changedScopes: ['orders'], requestId: key(), operator: actor }
    );
    expect(child.order.accountSource).toBe('customer_owned');
    expect(child.order.sourceSoldOrderId).toBe(source.id);
    expect(await order(source.id)).toEqual(storedSource);
    expect(
      await prisma.idBusinessV2Account.findUniqueOrThrow({ where: { id: account.id } })
    ).toEqual(account);
    expect(
      await prisma.idBusinessV2FinanceJournal.findMany({
        where: { sourceId: source.id },
        include: { lines: true },
        orderBy: { id: 'asc' }
      })
    ).toEqual(journalBefore);
    expect(
      await prisma.idBusinessV2BalanceLedger.findMany({
        where: { accountId: account.id },
        orderBy: { id: 'asc' }
      })
    ).toEqual(ledgerBefore);
    expect((await integrityCounts()).filter((rule) => rule.count !== 0)).toEqual([]);
  });
});
