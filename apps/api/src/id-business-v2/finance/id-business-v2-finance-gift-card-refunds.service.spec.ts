import { describe, expect, it } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceGiftCardRefundsService } from './id-business-v2-finance-gift-card-refunds.service';

const cardId = '11111111-1111-4111-8111-111111111111';
const walletId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-04T08:00:00Z');
const dto = {
  reason: '核对原卡商回款',
  idempotencyKey: 'refund-close-1234',
  receivedAt: now.toISOString()
};

function fixture(
  options: {
    currency?: string;
    source?: string;
    premature?: boolean;
    version?: number;
    walletId?: string;
    auditFails?: boolean;
  } = {}
) {
  const fundingWalletId = options.walletId ?? walletId;
  const evidence = {
    refundFundingVersion: options.version ?? 2,
    fundingSource: options.source ?? 'supplier_wallet',
    sourceLedgerId: 'original-active-debit',
    supplierAccountId: fundingWalletId,
    refundCurrency: options.currency ?? 'CNY',
    refundOriginalAmount: '700',
    refundCostAmountCny: '700'
  };
  let state = {
    card: {
      id: cardId,
      codeMasked: '合成卡',
      supplierRefundStatus: 'pending',
      supplierRefundAmount: Amount4.from('700'),
      supplierRefundAmountCny: Amount4.from('700'),
      purchaseSupplierAccountId: fundingWalletId
    },
    wallet: {
      id: fundingWalletId,
      currency: options.currency ?? 'CNY',
      currentBalance: Amount4.from('300'),
      currentBalanceCny: Amount4.from('300'),
      supplierName: '合成卡商'
    },
    journals: [] as Array<Record<string, unknown>>,
    ledgers: [] as Array<Record<string, unknown>>,
    audits: [] as unknown[]
  };
  let previous: Promise<unknown> = Promise.resolve();
  const tx = { $queryRaw: async () => [] };
  const manager = {
    execute: (fn: (transaction: typeof tx) => Promise<unknown>) => {
      const next = previous.then(async () => {
        const snapshot = {
          ...state,
          journals: [...state.journals],
          ledgers: [...state.ledgers],
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
  const commands = {
    findJournalReplay: async (_: unknown, key: string) =>
      state.journals.find((j) => j.idempotencyKey === key) ?? null,
    createJournal: async (_: unknown, data: { id: string; lines: { create: unknown[] } }) => {
      const journal = { ...data, lines: data.lines.create, status: 'posted' };
      state.journals.push(journal);
      return journal;
    }
  };
  const refunds = {
    lock: async () => state.card,
    findPrematureWithdrawal: async () => (options.premature ? { id: 'old-advance' } : null),
    findWithdrawalJournal: async () => ({ status: 'posted', metadata: evidence }),
    createReceivedLedger: async (_: unknown, data: Record<string, unknown>) => {
      state.ledgers.push(data);
      return data;
    },
    updateSupplierWalletBalances: async (_: unknown, id: string, original: string, cny: string) => {
      expect(id).toBe(state.wallet.id);
      state.wallet = {
        ...state.wallet,
        currentBalance: Amount4.from(original),
        currentBalanceCny: Amount4.from(cny)
      };
    },
    closeGiftCard: async (_: unknown, id: string, status: string) => {
      state.card = { ...state.card, supplierRefundStatus: status };
    }
  };
  const audit = {
    append: async (_: unknown, data: unknown) => {
      if (options.auditFails) throw new Error('audit-failure');
      state.audits.push(data);
    }
  };
  const posting = new IdBusinessV2FinancePostingService(commands as never);
  const service = new IdBusinessV2FinanceGiftCardRefundsService(
    manager as never,
    commands as never,
    refunds as never,
    { lock: async () => state.wallet } as never,
    audit as never,
    posting
  );
  return { service, getState: () => state };
}

describe('gift card refund closure', () => {
  it('adds the historical payment exactly once on receipt, including concurrent identical submissions', async () => {
    const { service, getState } = fixture();
    const [first, second] = await Promise.all([
      service.receive(cardId, dto),
      service.receive(cardId, dto)
    ]);
    expect(first.id).toBe(second.id);
    expect(getState().wallet.currentBalanceCny.toString()).toBe('1000');
    expect(getState().card.supplierRefundStatus).toBe('received');
    expect(getState().journals).toHaveLength(1);
    expect(getState().ledgers).toHaveLength(1);
    expect(getState().journals[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountCode: 'supplier_prepayment',
          direction: 'debit',
          amountCny: '700',
          supplierAccountId: walletId
        }),
        expect.objectContaining({
          accountCode: 'supplier_refund_receivable',
          direction: 'credit',
          amountCny: '700'
        })
      ])
    );
  });

  it('writes off the receivable without restoring spendable supplier funds', async () => {
    const { service, getState } = fixture();
    await service.writeOff(cardId, dto);
    expect(getState().wallet.currentBalanceCny.toString()).toBe('300');
    expect(getState().card.supplierRefundStatus).toBe('written_off');
    expect(getState().ledgers).toHaveLength(0);
    expect(getState().journals[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountCode: 'gift_card_redemption_loss',
          direction: 'debit',
          amountCny: '700'
        }),
        expect.objectContaining({
          accountCode: 'supplier_refund_receivable',
          direction: 'credit',
          amountCny: '700'
        })
      ])
    );
  });

  it('serializes receipt versus write-off so the same receivable cannot close twice', async () => {
    const { service, getState } = fixture();
    const results = await Promise.allSettled([
      service.receive(cardId, dto),
      service.writeOff(cardId, { ...dto, idempotencyKey: 'writeoff-competing-123' })
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(getState().journals).toHaveLength(1);
    expect(getState().wallet.currentBalanceCny.toString()).toBe('1000');
  });

  it('rolls back wallet, refund ledger, journal and status if final audit fails', async () => {
    const { service, getState } = fixture({ auditFails: true });
    await expect(service.receive(cardId, dto)).rejects.toThrow('audit-failure');
    expect(getState().wallet.currentBalanceCny.toString()).toBe('300');
    expect(getState().card.supplierRefundStatus).toBe('pending');
    expect(getState().journals).toHaveLength(0);
    expect(getState().ledgers).toHaveLength(0);
  });

  it.each(['receive', 'writeOff'] as const)(
    'blocks legacy premature balance restoration before %s',
    async (action) => {
      const { service, getState } = fixture({ premature: true });
      await expect(service[action](cardId, dto)).rejects.toThrow('旧版提前返还余额');
      expect(getState().card.supplierRefundStatus).toBe('pending');
      expect(getState().journals).toHaveLength(0);
    }
  );

  it('requires explicit historical reconciliation when the old pending journal has no frozen funding version', async () => {
    const { service } = fixture({ version: 1 });
    await expect(service.receive(cardId, dto)).rejects.toThrow('原付款与撤回应收证据');
  });

  it.each([{ currency: 'USD' }, { source: 'cash' }, { source: 'legacy_unverified' }])(
    'does not pretend unsupported source %j was received',
    async (options) => {
      const { service, getState } = fixture(options);
      await expect(service.receive(cardId, dto)).rejects.toThrow();
      expect(getState().wallet.currentBalanceCny.toString()).toBe('300');
      expect(getState().card.supplierRefundStatus).toBe('pending');
    }
  );

  it('uses the frozen reassigned wallet instead of searching the first historical debit', async () => {
    const reassignedWallet = '33333333-3333-4333-8333-333333333333';
    const { service, getState } = fixture({ walletId: reassignedWallet });
    await service.receive(cardId, dto);
    expect(getState().ledgers[0]?.supplierAccountId).toBe(reassignedWallet);
    expect(getState().wallet.currentBalanceCny.toString()).toBe('1000');
  });

  it('rejects reuse of the same key for another card or changed reason', async () => {
    const { service } = fixture();
    await service.receive(cardId, dto);
    await expect(service.receive('44444444-4444-4444-8444-444444444444', dto)).rejects.toThrow(
      '幂等键已用于不同'
    );
    await expect(service.receive(cardId, { ...dto, reason: '变更处理原因' })).rejects.toThrow(
      '幂等键已用于不同'
    );
  });
});
