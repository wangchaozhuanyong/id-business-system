import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceSupplierWalletsService } from './id-business-v2-finance-supplier-wallets.service';
import type { FinancePostingInput } from './id-business-v2-finance-posting.service';

function fixture(quantity = '100', bookCost = '700') {
  const walletId = randomUUID();
  const financeAccountId = randomUUID();
  let state = { quantity, bookCost, cash: '0', cashCost: '0' };
  let failAudit = false;
  const ledgers = new Map<string, Record<string, unknown>>();
  const journals: Array<{ id: string; lines: FinancePostingInput['lines']; metadata: unknown }> =
    [];
  const tx = {
    $queryRaw: async (query: TemplateStringsArray) =>
      query.join('').includes('finance_accounts')
        ? [
            {
              id: financeAccountId,
              status: 'active',
              currency: 'USD',
              currentBalance: state.cash,
              currentBalanceCny: state.cashCost
            }
          ]
        : []
  };
  const transactions = {
    execute: async (callback: (client: unknown) => Promise<unknown>) => {
      const before = { ...state },
        beforeLedgers = new Map(ledgers),
        journalCount = journals.length;
      try {
        return await callback(tx);
      } catch (error) {
        state = before;
        ledgers.clear();
        beforeLedgers.forEach((value, key) => ledgers.set(key, value));
        journals.splice(journalCount);
        throw error;
      }
    }
  };
  const audit = {
    append: async () => {
      if (failAudit) throw new Error('audit-failure');
    }
  };
  const wallet = { id: walletId, currency: 'USD', status: 'active' };
  const repository = {
    findWallet: async () => ({ ...wallet, currentBalance: state.quantity }),
    findWalletAndFinanceAccount: async () => ({
      wallet,
      financeAccount: { id: financeAccountId, currency: 'USD', status: 'active' }
    }),
    findLedgerReplay: async (_tx: unknown, key: string) => ledgers.get(key) ?? null,
    lock: async () => ({
      id: walletId,
      currency: 'USD',
      supplierName: '供应商',
      currentBalance: Amount4.from(state.quantity),
      currentBalanceCny: Amount4.from(state.bookCost)
    }),
    createLedger: async (_tx: unknown, data: Record<string, unknown>) => {
      ledgers.set(String(data.idempotencyKey), data);
      return data;
    },
    updateBalances: async (_tx: unknown, _id: string, next: string, nextCost: string) => {
      state.quantity = next;
      state.bookCost = nextCost;
    }
  };
  const postingRepository = {
    findJournalReplay: async () => null,
    createJournal: async (
      _tx: unknown,
      data: { id: string; lines: { create: FinancePostingInput['lines'] }; metadata: unknown }
    ) => {
      const journal = { id: data.id, lines: data.lines.create, metadata: data.metadata };
      journals.push(journal);
      return journal;
    },
    incrementFinanceAccount: async (_tx: unknown, _id: string, amount: string, cny: string) => {
      state.cash = Amount4.from(state.cash).add(amount).toString();
      state.cashCost = Amount4.from(state.cashCost).add(cny).toString();
    }
  };
  const posting = new IdBusinessV2FinancePostingService(postingRepository as never);
  const fx = {
    resolve: async (input: { manualRate: { toString(): string } | null }) => ({
      id: randomUUID(),
      rateToCny: input.manualRate?.toString() ?? '8'
    })
  };
  const service = new IdBusinessV2FinanceSupplierWalletsService(
    transactions as never,
    repository as never,
    audit as never,
    fx as never,
    posting
  );
  return {
    service,
    walletId,
    financeAccountId,
    journals,
    state: () => state,
    failAudit: () => {
      failAudit = true;
    }
  };
}

describe('supplier wallet commands with real balanced posting service', () => {
  it.each([
    ['8', 'credit', '100'],
    ['6', 'debit', '100']
  ])(
    'refunds book cost 700 at cash rate %s and recognizes FX %s %s',
    async (rate, direction, difference) => {
      const f = fixture();
      const dto = {
        financeAccountId: f.financeAccountId,
        amount: '100',
        receivedAt: new Date().toISOString(),
        fxRateToCny: rate,
        manualRateReason: '实际退款汇率',
        reason: '供应商退款',
        idempotencyKey: randomUUID()
      };
      await f.service.refund(f.walletId, dto);
      await f.service.refund(f.walletId, dto);
      expect(f.state()).toEqual({
        quantity: '0',
        bookCost: '0',
        cash: '100',
        cashCost: rate === '8' ? '800' : '600'
      });
      expect(f.journals).toHaveLength(1);
      expect(
        f.journals[0].lines.find((line) => line.accountCode === 'supplier_prepayment')
      ).toMatchObject({ amountCny: '700', fxRateToCny: '7' });
      expect(
        f.journals[0].lines.find((line) => line.accountCode === 'realized_fx_gain_loss')
      ).toMatchObject({ direction, amountCny: difference });
    }
  );

  it('adds incremental quantity cost and reduces proportional cost without revaluing the old balance', async () => {
    const f = fixture();
    const dto = {
      targetBalance: '110',
      fxRateToCny: '8',
      manualRateReason: '新增数量汇率',
      reason: '数量调整',
      idempotencyKey: randomUUID()
    };
    await f.service.adjust(f.walletId, dto);
    await f.service.adjust(f.walletId, dto);
    expect(f.state().bookCost).toBe('780');
    expect(f.journals).toHaveLength(1);
    const reduced = fixture();
    await reduced.service.adjust(reduced.walletId, {
      ...dto,
      targetBalance: '90',
      idempotencyKey: randomUUID()
    });
    expect(reduced.state().bookCost).toBe('630');
    await reduced.service.adjust(reduced.walletId, {
      ...dto,
      targetBalance: '0',
      idempotencyKey: randomUUID()
    });
    expect(reduced.state().bookCost).toBe('0');
  });

  it('rolls back wallet, journal and cash together when the final audit fails', async () => {
    const f = fixture();
    f.failAudit();
    await expect(
      f.service.refund(f.walletId, {
        financeAccountId: f.financeAccountId,
        amount: '100',
        receivedAt: new Date().toISOString(),
        fxRateToCny: '8',
        manualRateReason: '实际退款汇率',
        reason: '供应商退款',
        idempotencyKey: randomUUID()
      })
    ).rejects.toThrow('audit-failure');
    expect(f.state()).toEqual({ quantity: '100', bookCost: '700', cash: '0', cashCost: '0' });
    expect(f.journals).toHaveLength(0);
  });
});
