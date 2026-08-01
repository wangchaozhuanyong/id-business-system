import { describe, expect, it, vi } from 'vitest';
import { calculateFinanceHistoryAssetOpening } from './persistence/id-business-v2-finance-history-opening.repository';

describe('calculateFinanceHistoryAssetOpening', () => {
  it('normalizes Cloudflare-style aggregate decimals before calculating the opening difference', async () => {
    const client = createClient({
      giftCardInventory: edgeDecimal('1032.728'),
      idInventory: edgeDecimal('40'),
      supplierPrepayment: edgeDecimal('8677'),
      supplierRefundReceivable: edgeDecimal('0'),
      gl: [
        {
          accountCode: 'gift_card_inventory',
          direction: 'credit',
          _sum: { amountCny: edgeDecimal('112.872') }
        },
        {
          accountCode: 'supplier_prepayment',
          direction: 'debit',
          _sum: { amountCny: edgeDecimal('8677') }
        }
      ]
    });

    const result = await calculateFinanceHistoryAssetOpening(client as never);

    expect(result.willCreate).toBe(true);
    expect(result.adjustmentTotalCny.toString()).toBe('1185.6');
    expect(result.journalLineCount).toBe(4);
    expect(
      result.adjustments.map((item) => ({
        accountCode: item.accountCode,
        direction: item.direction,
        amountCny: item.amountCny.toString()
      }))
    ).toEqual([
      {
        accountCode: 'gift_card_inventory',
        direction: 'debit',
        amountCny: '1145.6'
      },
      {
        accountCode: 'id_inventory',
        direction: 'debit',
        amountCny: '40'
      }
    ]);
  });

  it('creates a credit adjustment when the existing asset book value exceeds the target', async () => {
    const client = createClient({
      giftCardInventory: edgeDecimal('10'),
      idInventory: edgeDecimal('0'),
      supplierPrepayment: edgeDecimal('0'),
      supplierRefundReceivable: edgeDecimal('0'),
      gl: [
        {
          accountCode: 'gift_card_inventory',
          direction: 'debit',
          _sum: { amountCny: edgeDecimal('15') }
        }
      ]
    });

    const result = await calculateFinanceHistoryAssetOpening(client as never);

    expect(result.adjustmentTotalCny.toString()).toBe('5');
    expect(result.journalLineCount).toBe(2);
    expect(result.adjustments[0]).toMatchObject({
      accountCode: 'gift_card_inventory',
      direction: 'credit'
    });
    expect(result.adjustments[0]?.amountCny.toString()).toBe('5');
  });
});

function edgeDecimal(value: string) {
  return {
    toString: () => value
  };
}

function createClient(input: {
  giftCardInventory: ReturnType<typeof edgeDecimal>;
  idInventory: ReturnType<typeof edgeDecimal>;
  supplierPrepayment: ReturnType<typeof edgeDecimal>;
  supplierRefundReceivable: ReturnType<typeof edgeDecimal>;
  gl: Array<{
    accountCode: string;
    direction: string;
    _sum: { amountCny: ReturnType<typeof edgeDecimal> };
  }>;
}) {
  return {
    idBusinessV2FinanceJournal: {
      findUnique: vi.fn().mockResolvedValue(null)
    },
    idBusinessV2Account: {
      aggregate: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            where.soldByOrderId === null
              ? { _sum: { purchaseCost: input.idInventory } }
              : { _sum: { balanceCostAmount: input.giftCardInventory } }
          )
        )
    },
    idBusinessV2TopupSupplierAccount: {
      aggregate: vi.fn().mockResolvedValue({
        _sum: { currentBalanceCny: input.supplierPrepayment }
      })
    },
    idBusinessV2GiftCard: {
      aggregate: vi.fn().mockResolvedValue({
        _sum: { supplierRefundAmountCny: input.supplierRefundReceivable }
      })
    },
    idBusinessV2FinanceJournalLine: {
      groupBy: vi.fn().mockResolvedValue(input.gl)
    }
  };
}
