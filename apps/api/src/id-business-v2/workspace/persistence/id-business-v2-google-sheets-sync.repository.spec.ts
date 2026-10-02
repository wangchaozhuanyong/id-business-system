import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { IdBusinessV2GoogleSheetsSyncRepository } from './id-business-v2-google-sheets-sync.repository';
import {
  GOOGLE_SHEETS_RETENTION_KEY,
  readGoogleSheetsRetention,
  writeGoogleSheetsRetention
} from '../id-business-v2-google-sheets-retention';

describe('Google Sheets report persistence boundary', () => {
  it('persists the cutoff through restart, ignores old-record edits and trims again after 100 additions', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      id: `card-${String(index + 1).padStart(6, '0')}`,
      createdAt: new Date('2026-10-02T00:00:00Z'),
      updatedAt: new Date('2026-10-02T00:00:00Z')
    }));
    type Filter = { where?: { OR?: Array<{ id?: { gt: string } }> }; take?: number };
    const eligible = (input: Filter) =>
      rows.filter((row) => !input.where?.OR || row.id > input.where.OR[1]!.id!.gt);
    const empty = () => ({ count: async () => 0, findMany: async () => [] });
    const bank = {
      count: vi.fn(async (input: Filter) => eligible(input).length),
      findMany: vi.fn(async (input: Filter) =>
        eligible(input).slice().reverse().slice(0, input.take)
      )
    };
    const queryRaw = vi.fn(async () => [{ createdAt: '2026-10-02T00:00:00.000123Z' }]);
    const tx = {
      idBusinessV2Order: empty(),
      idBusinessV2GiftCard: empty(),
      idBusinessV2Activation: empty(),
      idBusinessV2ChatgptAccount: empty(),
      idBusinessV2ManagedMailbox: empty(),
      idBusinessV2BankRechargeCard: bank,
      idBusinessV2Customer: empty(),
      idBusinessV2FinanceAccount: empty(),
      idBusinessV2FinanceJournalLine: empty(),
      idBusinessV2FinanceJournal: empty(),
      $queryRaw: queryRaw
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx));
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    const first = await new IdBusinessV2GoogleSheetsSyncRepository(prisma).loadReportSource();
    expect(first.bankCards).toHaveLength(9_900);
    expect(first.retention.records.bankCards?.id).toBe('card-000100');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      timeout: 60_000
    });
    const saved = readGoogleSheetsRetention({
      [GOOGLE_SHEETS_RETENTION_KEY]: writeGoogleSheetsRetention(first.retention)
    });
    rows[0]!.updatedAt = new Date('2026-10-03T00:00:00Z');
    const restarted = new IdBusinessV2GoogleSheetsSyncRepository(prisma);
    const same = await restarted.loadReportSource(saved);
    expect(same.bankCards).toHaveLength(9_900);
    expect(same.bankCards[0]!.id).toBe('card-000101');
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(bank.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { createdAt: { gt: '2026-10-02T00:00:00.000123Z' } },
            { createdAt: '2026-10-02T00:00:00.000123Z', id: { gt: 'card-000100' } }
          ]
        }
      })
    );
    for (let index = 10_001; index <= 10_099; index += 1)
      rows.push({
        id: `card-${String(index).padStart(6, '0')}`,
        createdAt: rows[0]!.createdAt,
        updatedAt: rows[0]!.updatedAt
      });
    expect((await restarted.loadReportSource(saved)).bankCards).toHaveLength(9_999);
    rows.push({ id: 'card-010100', createdAt: rows[0]!.createdAt, updatedAt: rows[0]!.updatedAt });
    const second = await restarted.loadReportSource(saved);
    expect(second.bankCards).toHaveLength(9_900);
    expect(second.bankCards[0]!.id).toBe('card-000201');
    expect(second.retention.records.bankCards?.id).toBe('card-000200');
    expect(rows).toHaveLength(10_100);
  });
  it('reads all requested modules with field whitelists and never selects encrypted credentials', async () => {
    const delegates = [
      'idBusinessV2Order',
      'idBusinessV2GiftCard',
      'idBusinessV2Activation',
      'idBusinessV2FinanceJournal',
      'idBusinessV2ChatgptAccount',
      'idBusinessV2ManagedMailbox',
      'idBusinessV2BankRechargeCard',
      'idBusinessV2Customer',
      'idBusinessV2FinanceAccount',
      'idBusinessV2FinanceJournalLine'
    ];
    const queries = Object.fromEntries(
      delegates.map((name) => [
        name,
        { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) }
      ])
    );
    const repository = new IdBusinessV2GoogleSheetsSyncRepository({
      ...queries,
      $transaction: async (fn: (tx: typeof queries) => unknown) => fn(queries)
    } as unknown as PrismaService);
    const result = await repository.loadReportSource();
    expect(Object.keys(result)).toHaveLength(11);
    for (const name of delegates) {
      const query = queries[name]!.findMany;
      expect(query).toHaveBeenCalledOnce();
      const input = query.mock.calls[0] as unknown as [
        { select: object; take: number; where?: object }
      ];
      expect(input[0].take).toBe(10_000);
      expect(JSON.stringify(input[0].select)).not.toMatch(
        /Encrypted|Hash|queryCodeHint|remark|metadata|summary|payee|payer/
      );
    }
    expect(queries.idBusinessV2Customer!.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } })
    );
    expect(queries.idBusinessV2BankRechargeCard!.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ last4: true })
      })
    );
    expect(queries.idBusinessV2ManagedMailbox!.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ email: true })
      })
    );
  });

  it('includes committed workspace mailbox changes in restart reconciliation', async () => {
    const findMany = vi.fn(async () => [{ scope: 'workspace', version: BigInt(2) }]);
    const repository = new IdBusinessV2GoogleSheetsSyncRepository({
      idBusinessV2ScopeVersion: { findMany }
    } as unknown as PrismaService);
    expect(await repository.listSourceVersions()).toEqual({ workspace: '2' });
    const input = findMany.mock.calls[0] as unknown as [{ where: { scope: { in: string[] } } }];
    expect(input[0].where.scope.in).toContain('workspace');
    expect(input[0].where.scope.in).toContain('auto-recharge');
    expect(input[0].where.scope.in).not.toContain('audit-logs');
  });
});
