import { describe, expect, it, vi } from 'vitest';
import { synchronizePostedOrderProfit } from './id-business-v2-order-posted-profit';

type Journal = {
  sourceId: string;
  status: 'posted' | 'reversed';
  metadata: Record<string, string> | null;
  lines: Array<{ direction: 'debit' | 'credit'; amountCny: string }>;
};
const journal = (
  sourceId: string,
  credit: string,
  debit = '0',
  metadata: Journal['metadata'] = null,
  status: Journal['status'] = 'posted'
): Journal => ({
  sourceId,
  status,
  metadata,
  lines: [
    { direction: 'credit', amountCny: credit },
    { direction: 'debit', amountCny: debit }
  ]
});
function fixture(journals: Journal[]) {
  const update = vi.fn(async (input) => input);
  const tx = {
    idBusinessV2FinanceJournal: { findMany: async () => journals },
    idBusinessV2Order: { update }
  };
  return { tx, update };
}

describe('posted order profit projection', () => {
  it('keeps original and reversal lines and includes both positive and negative FX exactly', async () => {
    const { tx, update } = fixture([
      journal('order', '100.1234', '20.0123'),
      journal('order', '0', '80', null, 'reversed'),
      journal('order', '80'),
      journal('order', '5.1111'),
      journal('order', '0', '2.2222')
    ]);
    const profit = await synchronizePostedOrderProfit(tx as never, 'order');
    expect(profit.toString()).toBe('83');
    expect(update).toHaveBeenCalledWith({ where: { id: 'order' }, data: { profitAmount: '83' } });
  });
  it('allocates restored customer cost to the original sale without increasing global profit twice', async () => {
    const all = [
      journal('original-sale', '100', '80'),
      journal('after-sale', '10'),
      journal('after-sale', '30', '0', {
        restoredSourceOrderId: 'original-sale',
        restoredSourceOrderCostAmount: '30'
      })
    ];
    const original = fixture(all),
      afterSale = fixture(all);
    expect(
      (await synchronizePostedOrderProfit(original.tx as never, 'original-sale')).toString()
    ).toBe('50');
    expect(
      (await synchronizePostedOrderProfit(afterSale.tx as never, 'after-sale')).toString()
    ).toBe('10');
  });
  it('nets a reversed cross-order cost allocation together with its reversed financial lines', async () => {
    const all = [
      journal('original-sale', '100', '80'),
      journal('after-sale', '10'),
      journal(
        'after-sale',
        '30',
        '0',
        { restoredSourceOrderId: 'original-sale', restoredSourceOrderCostAmount: '30' },
        'reversed'
      ),
      journal('after-sale', '0', '30')
    ];
    expect(
      (await synchronizePostedOrderProfit(fixture(all).tx as never, 'original-sale')).toString()
    ).toBe('20');
    expect(
      (await synchronizePostedOrderProfit(fixture(all).tx as never, 'after-sale')).toString()
    ).toBe('10');
  });
  it('refuses to invent profit when the order has no financial source evidence', async () => {
    const { tx, update } = fixture([journal('other-order', '100')]);
    await expect(synchronizePostedOrderProfit(tx as never, 'missing-order')).rejects.toThrow(
      '缺少财务凭证'
    );
    expect(update).not.toHaveBeenCalled();
  });
});
