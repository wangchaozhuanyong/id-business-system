import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  IdBusinessV2FinancePostingService,
  type FinancePostingInput
} from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';

function fixture(quantity = '100', cost = '700') {
  const accountId = randomUUID();
  const account = {
    id: accountId,
    currency: 'USD',
    status: 'active',
    currentBalance: quantity,
    currentBalanceCny: cost
  };
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
      const sql = query.join('');
      if (sql.includes('finance_periods')) return [];
      if (sql.includes('finance_journal_lines'))
        return (rows.find((row) => row.id === values[0])?.lines as unknown[]) ?? [];
      if (sql.includes('finance_journals'))
        return rows.filter((row) => row.idempotencyKey === values[0]);
      return [{ ...account }];
    },
    idBusinessV2FinanceAccount: {
      update: async ({
        data
      }: {
        data: { currentBalance: { increment: string }; currentBalanceCny: { increment: string } };
      }) => {
        account.currentBalance = Amount4.from(account.currentBalance)
          .add(data.currentBalance.increment)
          .toString();
        account.currentBalanceCny = Amount4.from(account.currentBalanceCny)
          .add(data.currentBalanceCny.increment)
          .toString();
        return account;
      }
    },
    idBusinessV2FinanceJournal: {
      findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        rows.find((row) =>
          where.id ? row.id === where.id : row.idempotencyKey === where.idempotencyKey
        ) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          ...data,
          status: 'posted',
          reversedBy: null,
          lines: (data.lines as { create: unknown[] }).create
        };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where }: { where: { id: string } }) => {
        const row = rows.find((item) => item.id === where.id);
        if (!row || row.status !== 'posted') return { count: 0 };
        row.status = 'reversed';
        return { count: 1 };
      }
    }
  };
  const service = new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository());
  function expense(amount: string, rate = '8'): FinancePostingInput {
    const cny = Rate8.from(rate).apply(Amount4.from(amount));
    return {
      journalType: 'expense',
      sourceType: 'expense',
      occurredAt: new Date('2026-10-04T08:00:00Z'),
      summary: '外币现金结转回归',
      idempotencyKey: randomUUID(),
      lines: [
        {
          accountCode: 'operating_expense',
          direction: 'debit',
          currency: 'USD',
          amountOriginal: amount,
          amountCny: cny,
          fxRateToCny: rate
        },
        {
          accountCode: 'cash',
          direction: 'credit',
          currency: 'USD',
          amountOriginal: amount,
          amountCny: cny,
          fxRateToCny: rate,
          financeAccountId: accountId,
          fxRateSnapshotId: randomUUID()
        }
      ]
    };
  }
  return { service, account, rows, tx, expense };
}

describe('shared foreign cash historical cost posting', () => {
  it.each(['CNY', 'incoming', 'reversal'])(
    'rejects caller-supplied reserved cash evidence before every %s replay path',
    async (mode) => {
      const f = fixture();
      const input = f.expense('1');
      if (mode === 'CNY') input.lines = input.lines.map((line) => ({ ...line, currency: 'CNY' }));
      if (mode === 'incoming')
        input.lines = input.lines.map((line) => ({
          ...line,
          direction: line.direction === 'debit' ? 'credit' : 'debit'
        }));
      if (mode === 'reversal') input.journalType = 'reversal';
      input.metadata = { cashHistoricalCost: { version: 1, inputFingerprint: 'caller-forged' } };
      await expect(f.service.post(f.tx as never, input)).rejects.toThrow('只能由共享过账服务生成');
      expect(f.rows).toHaveLength(0);
    }
  );
  it('spends the full original balance, clears book cost and keeps transaction expense plus actual FX', async () => {
    const f = fixture();
    const journal = await f.service.post(f.tx as never, f.expense('100'));
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
    expect(journal.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
      '700'
    );
    expect(journal.lines.find((line) => line.accountCode === 'cash')?.fxRateSnapshotId).toBeNull();
    expect(
      journal.lines.find((line) => line.accountCode === 'operating_expense')?.amountCny.toString()
    ).toBe('800');
    expect(
      journal.lines
        .find((line) => line.accountCode === 'realized_fx_gain_loss')
        ?.amountCny.toString()
    ).toBe('100');
    expect(journal.metadata).toMatchObject({
      cashHistoricalCost: {
        version: 1,
        accounts: [
          {
            creditOriginal: '100',
            transactionCreditCny: '800',
            carryingCreditCny: '700',
            realizedFxCny: '100'
          }
        ]
      }
    });
  });

  it('allocates partial payments and every final four-place remainder without using a rounded rate to compute cost', async () => {
    const f = fixture('3', '10');
    const costs = [];
    for (let index = 0; index < 3; index++) {
      const posted = await f.service.post(f.tx as never, f.expense('1', '4'));
      costs.push(posted.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString());
    }
    expect(costs).toEqual(['3.3333', '3.3334', '3.3333']);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
  });

  it('records a realized loss when transaction value is below the frozen book cost', async () => {
    const f = fixture('100', '900');
    const posted = await f.service.post(f.tx as never, f.expense('100'));
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
    expect(posted.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
      '900'
    );
    const loss = posted.lines.find((line) => line.accountCode === 'realized_fx_gain_loss');
    expect([loss?.direction, loss?.amountCny.toString()]).toEqual(['debit', '100']);
    expect(posted.metadata).toMatchObject({
      cashHistoricalCost: { accounts: [{ realizedFxCny: '-100' }] }
    });
  });

  it('allocates multiple cash credit lines and gives their final line the exact journal remainder', async () => {
    const f = fixture('3', '10');
    const input = f.expense('2', '4');
    const credit = { ...input.lines[1], amountOriginal: '1', amountCny: '4' };
    input.lines.splice(1, 1, credit, { ...credit });
    const posted = await f.service.post(f.tx as never, input);
    expect(
      posted.lines.filter((line) => line.accountCode === 'cash').map((line) => line.amountCny)
    ).toEqual(['3.3334', '3.3333']);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['1', '3.3333']);
    expect(posted.metadata).toMatchObject({
      cashHistoricalCost: {
        accounts: [
          {
            lineAllocations: [
              { lineNo: 2, bookCostCny: '3.3334' },
              { lineNo: 3, bookCostCny: '3.3333' }
            ]
          }
        ]
      }
    });
    await f.service.post(f.tx as never, f.expense('1', '4'));
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
  });

  it('blocks a partial disposal that would consume all four-place cost while quantity remains', async () => {
    const f = fixture('3', '0.0001');
    await expect(f.service.post(f.tx as never, f.expense('2'))).rejects.toThrow('低于金额精度');
    expect(f.rows).toHaveLength(0);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['3', '0.0001']);
  });

  it('replays the original transaction request against its fingerprint without re-reading depleted balances', async () => {
    const f = fixture();
    const input = f.expense('100');
    const first = await f.service.post(f.tx as never, input);
    f.tx.$queryRaw = async () => {
      throw new Error('replay must not read current balance');
    };
    const replay = await f.service.post(f.tx as never, input);
    expect(replay.id).toBe(first.id);
    expect(f.rows).toHaveLength(1);
    await expect(
      f.service.post(f.tx as never, { ...input, summary: '其他交易内容' })
    ).rejects.toThrow('幂等键');
  });

  it('returns the same committed journal after two same-key requests contend for the cash lock', async () => {
    const f = fixture();
    const input = f.expense('100');
    let cashLock: Promise<void> = Promise.resolve();
    async function submit() {
      let release: (() => void) | undefined;
      const transaction = {
        ...f.tx,
        $queryRaw: async (query: TemplateStringsArray, ...values: unknown[]) => {
          if (query.join('').includes('finance_accounts') && !release) {
            const previous = cashLock;
            cashLock = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
          }
          return f.tx.$queryRaw(query, ...values);
        }
      };
      try {
        return await f.service.post(transaction as never, input);
      } finally {
        release?.();
      }
    }
    const journals = await Promise.all([submit(), submit()]);
    expect(journals[0].id).toBe(journals[1].id);
    expect(f.rows).toHaveLength(1);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
  });

  it('does not add a second FX adjustment when a caller already supplied the correct historical cash book cost', async () => {
    const f = fixture();
    const input = f.expense('100');
    input.lines[1] = { ...input.lines[1], amountCny: '700', fxRateToCny: '7' };
    input.lines.push({
      accountCode: 'realized_fx_gain_loss',
      direction: 'credit',
      currency: 'CNY',
      amountOriginal: '100',
      amountCny: '100',
      fxRateToCny: '1'
    });
    const posted = await f.service.post(f.tx as never, input);
    expect(
      posted.lines.filter((line) => line.accountCode === 'realized_fx_gain_loss')
    ).toHaveLength(1);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['0', '0']);
  });

  it('mirrors the exact original cash and FX amounts on reversal after an unrelated receipt changed the current rate', async () => {
    const f = fixture();
    const posted = await f.service.post(f.tx as never, f.expense('100'));
    f.account.currentBalance = '10';
    f.account.currentBalanceCny = '100';
    const reversed = await f.service.reverse(f.tx as never, posted.id, '撤销原开支', randomUUID());
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['110', '800']);
    expect(reversed.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
      '700'
    );
    expect(
      reversed.lines.find((line) => line.accountCode === 'realized_fx_gain_loss')?.direction
    ).toBe('debit');
    expect(
      reversed.lines.filter((line) => line.accountCode === 'realized_fx_gain_loss')
    ).toHaveLength(1);
  });

  it('supports a same-account receipt and fee in one journal using an explicit frozen combined basis', async () => {
    const f = fixture();
    const input = f.expense('20');
    input.lines.push(
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: 'USD',
        amountOriginal: '10',
        amountCny: '80',
        fxRateToCny: '8',
        financeAccountId: f.account.id
      },
      {
        accountCode: 'sales_revenue',
        direction: 'credit',
        currency: 'USD',
        amountOriginal: '10',
        amountCny: '80',
        fxRateToCny: '8'
      }
    );
    const posted = await f.service.post(f.tx as never, input);
    expect([f.account.currentBalance, f.account.currentBalanceCny]).toEqual(['90', '638.1818']);
    expect(posted.metadata).toMatchObject({
      cashHistoricalCost: {
        accounts: [
          {
            incomingOriginal: '10',
            incomingCny: '80',
            carryingCreditCny: '141.8182',
            realizedFxCny: '18.1818'
          }
        ]
      }
    });
  });

  it.each([
    ['0', '1'],
    ['100', '-1'],
    ['100', '0']
  ])('blocks unverified historical cash quantity/cost %s/%s', async (quantity, cost) => {
    const f = fixture(quantity, cost);
    await expect(f.service.post(f.tx as never, f.expense('1'))).rejects.toThrow('历史成本异常');
    expect(f.rows).toHaveLength(0);
  });
});
