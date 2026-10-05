import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2HistoricalCashService } from './id-business-v2-historical-cash.service';
import {
  historicalCashBatchFingerprint,
  historicalCashSourceFingerprint,
  historicalCashSourceLineFingerprint,
  normalizeHistoricalCashBatch,
  type HistoricalCashBatch,
  type HistoricalCashSourceJournal
} from './id-business-v2-historical-cash.types';

const accountId = '10000000-0000-4000-8000-000000000001';
const journalId = '10000000-0000-4000-8000-000000000002';
const lineId = '10000000-0000-4000-8000-000000000003';
const userId = '10000000-0000-4000-8000-000000000004';
const now = new Date('2026-10-04T16:00:00.000Z');
const operator = {
  id: userId,
  username: 'auditor',
  displayName: '核账员',
  roles: ['admin'],
  permissions: []
};

function source(): HistoricalCashSourceJournal {
  return {
    id: journalId,
    journalNo: 'OLD-RECEIPT',
    journalType: 'manual_adjustment',
    sourceType: 'manual',
    sourceId: null,
    sourceReference: null,
    businessDate: new Date('2026-08-01'),
    periodMonth: '2026-08',
    occurredAt: new Date('2026-08-01T10:00:00Z'),
    status: 'posted',
    reversalOfJournalId: null,
    reversedAt: null,
    summary: '原现金凭证',
    metadata: { immutable: true },
    createdByUserId: userId,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    lines: [
      {
        id: lineId,
        journalId,
        lineNo: 1,
        accountCode: 'cash',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: '1350.0000',
        fxRateToCny: '1.00000000',
        amountCny: '1350.0000',
        financeAccountId: null,
        supplierAccountId: null,
        fxRateSnapshotId: null,
        memo: null
      }
    ]
  };
}

function batch(journal = source()): HistoricalCashBatch {
  return {
    idempotencyKey: 'historic-cash-001',
    reason: '原凭证及账户收支已核对',
    evidenceReference: '核对单001',
    accounts: [
      {
        accountId,
        expectedUpdatedAt: now.toISOString(),
        expectedBalanceOriginal: '10000',
        expectedBalanceCny: '10000'
      }
    ],
    adjustments: [
      {
        kind: 'assign_unassigned_cash',
        sourceLineId: lineId,
        sourceFingerprint: historicalCashSourceFingerprint(journal),
        targetAccountId: accountId,
        evidenceReference: '资金流水核对001'
      }
    ]
  };
}

describe('历史现金补偿冻结证据', () => {
  it('Prisma decimal representations and extra runtime fields do not change canonical source evidence', () => {
    const original = source();
    const variant = {
      ...source(),
      temporary: true,
      lines: source().lines.map((line) => ({
        ...line,
        amountOriginal: Amount4.from('1350'),
        fxRateToCny: '1',
        amountCny: '1350',
        unexpected: 'ignored'
      }))
    };
    expect(historicalCashSourceFingerprint(original)).toBe(
      historicalCashSourceFingerprint(variant)
    );
    variant.summary = '凭证已改动';
    expect(historicalCashSourceFingerprint(original)).not.toBe(
      historicalCashSourceFingerprint(variant)
    );
  });

  it('line evidence uses a fixed SQL-verifiable scale and field sequence', () => {
    const journal = source();
    const expected = createHash('sha256')
      .update(`${journalId}|manual||${lineId}|1|cash|debit|CNY|1350.0000|1.00000000|1350.0000|||`)
      .digest('hex');
    expect(historicalCashSourceLineFingerprint(journal, journal.lines[0])).toBe(expected);
  });

  it('normalization is idempotent and amount/target changes alter the batch hash', () => {
    const input = batch();
    expect(historicalCashBatchFingerprint(input)).toBe(
      historicalCashBatchFingerprint(normalizeHistoricalCashBatch(input))
    );
    const changed = { ...input, accounts: [{ ...input.accounts[0], expectedBalanceCny: '10001' }] };
    expect(historicalCashBatchFingerprint(input)).not.toBe(historicalCashBatchFingerprint(changed));
  });

  it('rejects duplicate sources and financial inputs exceeding four decimal places', () => {
    const input = batch();
    expect(() =>
      normalizeHistoricalCashBatch({
        ...input,
        adjustments: [...input.adjustments, ...input.adjustments]
      })
    ).toThrow('重复');
    expect(() =>
      normalizeHistoricalCashBatch({
        ...input,
        accounts: [{ ...input.accounts[0], expectedBalanceOriginal: '0.00001' }]
      })
    ).toThrow('4 位小数');
  });
});

describe('历史现金补偿守卫与专用过账', () => {
  let original: HistoricalCashSourceJournal;
  const tx = { $queryRaw: vi.fn() };
  const commands = {
    execute: vi.fn(
      async (work: (transaction: typeof tx, context: { businessTime: Date }) => Promise<unknown>) =>
        work(tx, { businessTime: now })
    )
  };
  const repository = {
    lockBatchGate: vi.fn(),
    readOperator: vi.fn(),
    findBatchReceipt: vi.fn(),
    findVerification: vi.fn(),
    findAdjustment: vi.fn(),
    findSourceExpense: vi.fn(),
    findSourceJournalIds: vi.fn(),
    lockSource: vi.fn(),
    lockAccount: vi.fn(),
    lockOrder: vi.fn(),
    findOrderJournalIds: vi.fn(),
    attributeOrder: vi.fn()
  };
  const finance = { createJournal: vi.fn(), incrementFinanceAccount: vi.fn() };
  const posting = { post: vi.fn() };
  const audit = { append: vi.fn() };
  const service = new IdBusinessV2HistoricalCashService(
    commands as never,
    repository as never,
    finance as never,
    posting as never,
    audit as never
  );

  beforeEach(() => {
    vi.resetAllMocks();
    original = source();
    tx.$queryRaw.mockResolvedValue([]);
    repository.lockBatchGate.mockResolvedValue(true);
    repository.readOperator.mockResolvedValue({
      id: userId,
      username: operator.username,
      displayName: operator.displayName,
      status: 'active',
      deletedAt: null,
      v2AuthIdentity: { enabled: true, mustResetPassword: false },
      userRoles: [{ role: { code: 'admin', rolePermissions: [] } }],
      systemSuperAdminId: null
    });
    repository.findBatchReceipt.mockResolvedValue([]);
    repository.findVerification.mockResolvedValue([]);
    repository.findAdjustment.mockResolvedValue(null);
    repository.findSourceExpense.mockResolvedValue(null);
    repository.findSourceJournalIds.mockResolvedValue([{ id: lineId, journalId }]);
    repository.lockSource.mockImplementation(async () => original);
    repository.lockAccount.mockResolvedValue({
      id: accountId,
      status: 'active',
      currency: 'CNY',
      updatedAt: now,
      currentBalance: Amount4.from('10000'),
      currentBalanceCny: Amount4.from('10000')
    });
    finance.createJournal.mockImplementation(async (_transaction, data) => ({
      ...data,
      lines: data.lines.create
    }));
    audit.append.mockResolvedValue({ id: 'audit-only' });
  });

  it('mirrors one exact unassigned CNY line without creating profit or changing its source', async () => {
    const before = structuredClone(original);
    const result = await service.execute(batch(original), operator);
    const data = finance.createJournal.mock.calls[0][1];
    expect(data.lines.create).toMatchObject([
      {
        accountCode: 'cash',
        direction: 'credit',
        financeAccountId: null,
        amountOriginal: '1350',
        amountCny: '1350'
      },
      {
        accountCode: 'cash',
        direction: 'debit',
        financeAccountId: accountId,
        amountOriginal: '1350',
        amountCny: '1350'
      }
    ]);
    expect(data.occurredAt).toEqual(now);
    expect(data.periodMonth).toBe('2026-10');
    expect(finance.incrementFinanceAccount).toHaveBeenCalledWith(tx, accountId, '1350', '1350');
    expect(posting.post).not.toHaveBeenCalled();
    expect(original).toEqual(before);
    expect(result.adjustmentJournalIds).toHaveLength(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('rejects a caller forged admin role when the current database user has no permissions', async () => {
    repository.readOperator.mockResolvedValue({
      id: userId,
      status: 'active',
      deletedAt: null,
      v2AuthIdentity: { enabled: true, mustResetPassword: false },
      userRoles: [],
      systemSuperAdminId: null
    });
    await expect(service.execute(batch(), operator)).rejects.toThrow('财务查看');
    expect(finance.createJournal).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, mustResetPassword: false },
    { enabled: true, mustResetPassword: true }
  ])('rejects inactive authentication identity %j', async (identity) => {
    const current = await repository.readOperator();
    repository.readOperator.mockResolvedValue({ ...current, v2AuthIdentity: identity });
    await expect(service.execute(batch(), operator)).rejects.toThrow('身份验证');
    expect(finance.createJournal).not.toHaveBeenCalled();
  });

  it('rejects a closed current period rather than posting in the old source period', async () => {
    tx.$queryRaw.mockResolvedValue([{ status: 'closed' }]);
    await expect(service.execute(batch(), operator)).rejects.toThrow('2026-10 已关账');
    expect(repository.lockSource).not.toHaveBeenCalled();
  });

  it.each(['CNY wrong rate', 'foreign null cash', 'already has reversal', 'changed source'])(
    'rejects unsafe source: %s',
    async (scenario) => {
      const input = batch(original);
      if (scenario === 'CNY wrong rate') original.lines[0].fxRateToCny = '2';
      if (scenario === 'foreign null cash') original.lines[0].currency = 'USDT';
      if (scenario === 'already has reversal') original.hasReversal = true;
      if (scenario === 'changed source') original.lines[0].memo = 'changed';
      if (scenario !== 'changed source')
        input.adjustments[0].sourceFingerprint = historicalCashSourceFingerprint(original);
      await expect(service.execute(input, operator)).rejects.toThrow();
      expect(finance.createJournal).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
    }
  );

  it('requires an unchanged initial account balance/version', async () => {
    const input = batch();
    input.accounts[0].expectedBalanceCny = '10001';
    await expect(service.execute(input, operator)).rejects.toThrow('账户已变化');
    expect(finance.createJournal).not.toHaveBeenCalled();
  });

  it('returns an exact committed replay without reading stale account CAS or appending another audit', async () => {
    const input = batch();
    const batchHash = historicalCashBatchFingerprint(input);
    const id = '10000000-0000-4000-8000-000000000005';
    repository.findBatchReceipt.mockResolvedValue([
      {
        id: 'receipt',
        afterData: {
          version: 1,
          batchHash,
          batchSize: 1,
          sourceLineIds: [lineId],
          adjustmentJournalIds: [id],
          verifiedSourceLineIds: []
        }
      }
    ]);
    repository.findAdjustment.mockResolvedValue({
      id,
      metadata: {
        historicalCashAdjustment: {
          batchHash,
          sourceFingerprint: input.adjustments[0].sourceFingerprint
        }
      }
    });
    await expect(service.execute(input, operator)).resolves.toEqual({
      batchHash,
      adjustmentJournalIds: [id],
      replayed: true
    });
    expect(repository.lockAccount).not.toHaveBeenCalled();
    expect(finance.createJournal).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    await expect(
      service.execute({ ...input, reason: '同一请求更换凭据依据' }, operator)
    ).rejects.toThrow('幂等键已用于其他内容');
  });

  it('records a verified zero cost difference only as an audit and never a zero journal', async () => {
    original.journalType = 'expense';
    original.sourceType = 'expense';
    original.sourceId = journalId;
    repository.findSourceExpense.mockResolvedValue({
      id: journalId,
      financeAccountId: accountId,
      currency: 'USDT',
      amountOriginal: '10',
      amountCny: '70'
    });
    original.lines[0] = {
      ...original.lines[0],
      direction: 'credit',
      currency: 'USDT',
      financeAccountId: accountId,
      amountOriginal: '10',
      amountCny: '70',
      fxRateToCny: '7'
    };
    repository.lockAccount.mockResolvedValue({
      id: accountId,
      status: 'active',
      currency: 'USDT',
      updatedAt: now,
      currentBalance: Amount4.from('10000'),
      currentBalanceCny: Amount4.from('10000')
    });
    const input = batch(original);
    input.adjustments = [
      {
        kind: 'restate_foreign_cash_cost',
        sourceLineId: lineId,
        sourceFingerprint: historicalCashSourceFingerprint(original),
        expectedBookCostCny: '70',
        recomputedBookCostCny: '70',
        evidenceReference: '加权成本核对相同'
      }
    ];
    const result = await service.execute(input, operator);
    expect(result.adjustmentJournalIds).toEqual([]);
    expect(finance.createJournal).not.toHaveBeenCalled();
    expect(posting.post).not.toHaveBeenCalled();
    expect(audit.append.mock.calls.map((call) => call[1].action)).toEqual([
      'id_business_v2.historical_cash.verify',
      'id_business_v2.historical_cash.execute'
    ]);
  });

  it.each([1, '1', 2, null, ''])(
    'rejects historical recomputation for existing cash cost evidence version %j',
    async (version) => {
      original.journalType = 'expense';
      original.sourceType = 'expense';
      original.metadata = { cashHistoricalCost: { version } };
      original.lines[0] = {
        ...original.lines[0],
        direction: 'credit',
        currency: 'USDT',
        financeAccountId: accountId,
        amountOriginal: '10',
        amountCny: '70'
      };
      const input = batch(original);
      input.adjustments = [
        {
          kind: 'restate_foreign_cash_cost',
          sourceLineId: lineId,
          sourceFingerprint: historicalCashSourceFingerprint(original),
          expectedBookCostCny: '70',
          recomputedBookCostCny: '71',
          evidenceReference: '重复核对'
        }
      ];
      await expect(service.execute(input, operator)).rejects.toThrow('已有现金历史成本依据');
      expect(posting.post).not.toHaveBeenCalled();
    }
  );

  it.each(['71', '70'])(
    'rejects only partially resolving duplicate cash credits at cost %s',
    async (cost) => {
      original.journalType = 'expense';
      original.sourceType = 'expense';
      original.lines[0] = {
        ...original.lines[0],
        direction: 'credit',
        currency: 'USDT',
        financeAccountId: accountId,
        amountOriginal: '10',
        amountCny: '70',
        fxRateToCny: '7'
      };
      original.lines.push({ ...original.lines[0], id: userId, lineNo: 2 });
      const input = batch(original);
      input.adjustments = [
        {
          kind: 'restate_foreign_cash_cost',
          sourceLineId: lineId,
          sourceFingerprint: historicalCashSourceFingerprint(original),
          expectedBookCostCny: '70',
          recomputedBookCostCny: cost,
          evidenceReference: '坏历史双现金分录'
        }
      ];
      await expect(service.execute(input, operator)).rejects.toThrow('必须唯一');
      expect(posting.post).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
    }
  );

  it.each([
    'missing record',
    'wrong CNY amount',
    'wrong original amount',
    'wrong account',
    'wrong currency'
  ])('rejects a labelled expense with %s', async (scenario) => {
    original.journalType = 'expense';
    original.sourceType = 'expense';
    original.sourceId = journalId;
    original.lines[0] = {
      ...original.lines[0],
      direction: 'credit',
      currency: 'USDT',
      financeAccountId: accountId,
      amountOriginal: '10',
      amountCny: '70',
      fxRateToCny: '7'
    };
    const expense = {
      id: journalId,
      financeAccountId: accountId,
      currency: 'USDT',
      amountOriginal: '10',
      amountCny: '70'
    };
    if (scenario === 'wrong CNY amount') expense.amountCny = '71';
    if (scenario === 'wrong original amount') expense.amountOriginal = '11';
    if (scenario === 'wrong account') expense.financeAccountId = userId;
    if (scenario === 'wrong currency') expense.currency = 'CNY';
    repository.findSourceExpense.mockResolvedValue(scenario === 'missing record' ? null : expense);
    const input = batch(original);
    input.adjustments = [
      {
        kind: 'restate_foreign_cash_cost',
        sourceLineId: lineId,
        sourceFingerprint: historicalCashSourceFingerprint(original),
        expectedBookCostCny: '70',
        recomputedBookCostCny: '71',
        evidenceReference: '不存在原开支'
      }
    ];
    await expect(service.execute(input, operator)).rejects.toThrow('原开支资料');
    expect(posting.post).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});
