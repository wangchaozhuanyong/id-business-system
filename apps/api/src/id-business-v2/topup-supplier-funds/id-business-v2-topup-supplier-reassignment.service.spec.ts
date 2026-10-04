import { describe, expect, it } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { IdBusinessV2TopupSupplierReassignmentService } from './id-business-v2-topup-supplier-reassignment.service';

const cardId = '11111111-1111-4111-8111-111111111111';
const oldSupplier = '22222222-2222-4222-8222-222222222222';
const newSupplier = '33333333-3333-4333-8333-333333333333';
const oldWallet = '44444444-4444-4444-8444-444444444444';
const newWallet = '55555555-5555-4555-8555-555555555555';
const operator = {
  id: '66666666-6666-4666-8666-666666666666',
  username: 'synthetic',
  displayName: '合成验收',
  roles: ['admin'],
  permissions: []
};
const dto = {
  supplierOptionId: newSupplier,
  reason: '核对供应商归属',
  idempotencyKey: 'reassign-closure-123'
};

type LedgerInput = {
  supplierAccountId: string;
  idempotencyKey: string;
  reason: string;
  giftCardId: string;
  amountCny: string;
  balanceBeforeCny: string;
  balanceAfterCny: string;
};
type SavedLedger = Omit<LedgerInput, 'amountCny' | 'balanceBeforeCny' | 'balanceAfterCny'> & {
  id: string;
  amountCny: Amount4;
  balanceBeforeCny: Amount4;
  balanceAfterCny: Amount4;
  supplierAccount: unknown;
};

function fixture(options: { auditFails?: boolean; currency?: string; status?: string } = {}) {
  const makeWallet = (id: string, supplierOptionId: string, balance: string) => ({
    id,
    supplierOptionId,
    supplierName: '合成供应商',
    currency: options.currency ?? 'CNY',
    initializedAt: new Date(),
    currentBalance: Amount4.from(balance),
    currentBalanceCny: Amount4.from(balance)
  });
  let state = {
    card: {
      id: cardId,
      codeMasked: '合成卡',
      supplierOptionId: oldSupplier,
      status: options.status ?? 'credited',
      purchaseSupplierAccountId: oldWallet
    },
    wallets: new Map([
      [oldWallet, makeWallet(oldWallet, oldSupplier, '300')],
      [newWallet, makeWallet(newWallet, newSupplier, '1000')]
    ]),
    ledgers: [] as SavedLedger[],
    journals: [] as Array<Record<string, unknown>>,
    audits: [] as unknown[]
  };
  const purchaseJournal = {
    id: 'original-purchase',
    amountCny: '700',
    supplierAccountId: oldWallet
  };
  let previous: Promise<unknown> = Promise.resolve();
  const tx = { $queryRaw: async () => [] };
  const manager = {
    execute: (fn: (transaction: typeof tx) => Promise<unknown>) => {
      const next = previous.then(async () => {
        const snapshot = {
          card: { ...state.card },
          wallets: new Map(state.wallets),
          ledgers: [...state.ledgers],
          journals: [...state.journals],
          audits: [...state.audits]
        };
        try {
          return await fn(tx);
        } catch (error) {
          state = snapshot;
          throw error;
        }
      });
      previous = next.catch(() => undefined);
      return next;
    }
  };
  const repository = {
    lockGiftCardForReassignment: async () => state.card,
    findReassignmentReplays: async (_: unknown, outgoing: string, incoming: string) => ({
      outgoing: state.ledgers.find((l) => l.idempotencyKey === outgoing),
      incoming: state.ledgers.find((l) => l.idempotencyKey === incoming)
    }),
    findReassignmentJournal: async (_: unknown, key: string) =>
      state.journals.find((j) => j.idempotencyKey === key),
    findActiveSupplier: async (_: unknown, id: string) => ({ id, name: '合成新供应商' }),
    findActiveGiftCardDebit: async () => ({
      id: 'active-original-debit',
      supplierAccountId: oldWallet,
      currency: options.currency ?? 'CNY',
      amount: Amount4.from('700'),
      amountCny: Amount4.from('700')
    }),
    findSupplierAccountRecord: async () => state.wallets.get(newWallet),
    lockSupplierAccountsByIds: async () => state.wallets,
    createLedger: async (_: unknown, input: LedgerInput) => {
      const ledger = {
        ...input,
        id: `ledger-${state.ledgers.length + 1}`,
        amountCny: Amount4.from(input.amountCny),
        balanceBeforeCny: Amount4.from(input.balanceBeforeCny),
        balanceAfterCny: Amount4.from(input.balanceAfterCny),
        supplierAccount: state.wallets.get(input.supplierAccountId)
      };
      state.ledgers.push(ledger);
      return ledger;
    },
    updateSupplierAccountBalances: async (_: unknown, input: Record<string, string>) => {
      const wallet = state.wallets.get(input.accountId)!;
      state.wallets.set(input.accountId, {
        ...wallet,
        currentBalance: Amount4.from(input.currentBalance),
        currentBalanceCny: Amount4.from(input.currentBalanceCny)
      });
    },
    updateGiftCardSupplier: async (
      _: unknown,
      input: { supplierOptionId: string; purchaseSupplierAccountId: string }
    ) => {
      state.card = {
        ...state.card,
        supplierOptionId: input.supplierOptionId,
        purchaseSupplierAccountId: input.purchaseSupplierAccountId
      };
      return state.card;
    }
  };
  const posting = new IdBusinessV2FinancePostingService({
    findJournalReplay: async (_: unknown, key: string) =>
      state.journals.find((j) => j.idempotencyKey === key),
    createJournal: async (
      _: unknown,
      data: { lines: { create: unknown[] }; [key: string]: unknown }
    ) => {
      const saved = { ...data, lines: data.lines.create };
      state.journals.push(saved);
      return saved;
    }
  } as never);
  const audit = {
    append: async (_: unknown, value: unknown) => {
      if (options.auditFails) throw new Error('audit-failure');
      state.audits.push(value);
    }
  };
  return {
    service: new IdBusinessV2TopupSupplierReassignmentService(
      repository as never,
      manager as never,
      audit as never,
      posting
    ),
    getState: () => state,
    purchaseJournal
  };
}

describe('supplier reassignment ledger and GL closure', () => {
  it('returns old wallet and charges new wallet with matching GL and freezes the new source', async () => {
    const { service, getState, purchaseJournal } = fixture();
    await service.reassignGiftCardSupplier(cardId, dto, operator);
    expect(getState().wallets.get(oldWallet)?.currentBalanceCny.toString()).toBe('1000');
    expect(getState().wallets.get(newWallet)?.currentBalanceCny.toString()).toBe('300');
    expect(getState().card.purchaseSupplierAccountId).toBe(newWallet);
    expect(getState().journals).toHaveLength(1);
    expect(getState().journals[0]?.lines).toEqual([
      expect.objectContaining({
        accountCode: 'supplier_prepayment',
        direction: 'debit',
        supplierAccountId: oldWallet,
        amountOriginal: '700',
        amountCny: '700'
      }),
      expect.objectContaining({
        accountCode: 'supplier_prepayment',
        direction: 'credit',
        supplierAccountId: newWallet,
        amountOriginal: '700',
        amountCny: '700'
      })
    ]);
    expect(getState().journals[0]?.metadata).toMatchObject({
      originalDebitLedgerId: 'active-original-debit',
      outgoingLedgerId: 'ledger-1',
      incomingLedgerId: 'ledger-2',
      oldSupplierAccountId: oldWallet,
      newSupplierAccountId: newWallet,
      transferredCostCny: '700'
    });
    expect(purchaseJournal).toEqual({
      id: 'original-purchase',
      amountCny: '700',
      supplierAccountId: oldWallet
    });
  });

  it('serializes concurrent retries and preserves one transfer and one GL journal', async () => {
    const { service, getState } = fixture();
    const results = await Promise.all([
      service.reassignGiftCardSupplier(cardId, dto, operator),
      service.reassignGiftCardSupplier(cardId, dto, operator)
    ]);
    expect(results.map((result) => result.idempotentReplay)).toEqual([false, true]);
    expect(getState().ledgers).toHaveLength(2);
    expect(getState().journals).toHaveLength(1);
    await expect(
      service.reassignGiftCardSupplier(cardId, { ...dto, reason: '不同更正原因' }, operator)
    ).rejects.toThrow('幂等键');
  });

  it('rolls back card source, both wallets, both ledgers and GL when final audit fails', async () => {
    const { service, getState } = fixture({ auditFails: true });
    await expect(service.reassignGiftCardSupplier(cardId, dto, operator)).rejects.toThrow(
      'audit-failure'
    );
    expect(getState().wallets.get(oldWallet)?.currentBalanceCny.toString()).toBe('300');
    expect(getState().wallets.get(newWallet)?.currentBalanceCny.toString()).toBe('1000');
    expect(getState().card.purchaseSupplierAccountId).toBe(oldWallet);
    expect(getState().ledgers).toHaveLength(0);
    expect(getState().journals).toHaveLength(0);
  });

  it.each([{ currency: 'USD' }, { status: 'withdrawn' }, { status: 'redeemed' }])(
    'blocks unsupported source or lifecycle %j before mutation',
    async (options) => {
      const { service, getState } = fixture(options);
      await expect(service.reassignGiftCardSupplier(cardId, dto, operator)).rejects.toThrow();
      expect(getState().ledgers).toHaveLength(0);
      expect(getState().journals).toHaveLength(0);
    }
  );
});
