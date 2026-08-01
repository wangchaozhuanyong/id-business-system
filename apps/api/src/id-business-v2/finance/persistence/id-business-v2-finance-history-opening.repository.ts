import type { Prisma } from '@prisma/client';
import { Amount4, mapAmount4 } from '../../runtime/public-api';

export const FINANCE_HISTORY_ASSET_ACCOUNT_CODES = [
  'gift_card_inventory',
  'id_inventory',
  'supplier_prepayment',
  'supplier_refund_receivable'
] as const;

export type FinanceHistoryAssetAccountCode = (typeof FINANCE_HISTORY_ASSET_ACCOUNT_CODES)[number];

export interface FinanceHistoryAssetOpeningAdjustment {
  accountCode: FinanceHistoryAssetAccountCode;
  direction: 'debit' | 'credit';
  amountCny: Amount4;
}

export interface FinanceHistoryAssetOpening {
  willCreate: boolean;
  adjustmentTotalCny: Amount4;
  journalLineCount: number;
  adjustments: FinanceHistoryAssetOpeningAdjustment[];
}

type FinanceHistoryAssetOpeningClient = Pick<
  Prisma.TransactionClient,
  | 'idBusinessV2Account'
  | 'idBusinessV2TopupSupplierAccount'
  | 'idBusinessV2GiftCard'
  | 'idBusinessV2FinanceJournal'
  | 'idBusinessV2FinanceJournalLine'
>;

const ZERO = Amount4.zero();

export async function calculateFinanceHistoryAssetOpening(
  client: FinanceHistoryAssetOpeningClient
): Promise<FinanceHistoryAssetOpening> {
  const existing = await client.idBusinessV2FinanceJournal.findUnique({
    where: { idempotencyKey: 'legacy:asset_opening:v1' },
    select: { id: true }
  });
  if (existing) return emptyAssetOpening();

  const [accountAssets, unsoldIds, supplierWallets, pendingRefunds, gl] = await Promise.all([
    client.idBusinessV2Account.aggregate({
      where: { deletedAt: null, lossReportedAt: null },
      _sum: { balanceCostAmount: true }
    }),
    client.idBusinessV2Account.aggregate({
      where: { deletedAt: null, lossReportedAt: null, soldByOrderId: null },
      _sum: { purchaseCost: true }
    }),
    client.idBusinessV2TopupSupplierAccount.aggregate({
      where: { status: 'active' },
      _sum: { currentBalanceCny: true }
    }),
    client.idBusinessV2GiftCard.aggregate({
      where: { supplierRefundStatus: 'pending' },
      _sum: { supplierRefundAmountCny: true }
    }),
    client.idBusinessV2FinanceJournalLine.groupBy({
      by: ['accountCode', 'direction'],
      where: { accountCode: { in: [...FINANCE_HISTORY_ASSET_ACCOUNT_CODES] } },
      _sum: { amountCny: true }
    })
  ]);

  const targets: ReadonlyArray<[FinanceHistoryAssetAccountCode, Amount4]> = [
    [
      'gift_card_inventory',
      mapAmount4(accountAssets._sum.balanceCostAmount ?? 0, 'accounts.sum_balance_cost_amount')
    ],
    ['id_inventory', mapAmount4(unsoldIds._sum.purchaseCost ?? 0, 'accounts.sum_purchase_cost')],
    [
      'supplier_prepayment',
      mapAmount4(
        supplierWallets._sum.currentBalanceCny ?? 0,
        'supplier_accounts.sum_current_balance_cny'
      )
    ],
    [
      'supplier_refund_receivable',
      mapAmount4(
        pendingRefunds._sum.supplierRefundAmountCny ?? 0,
        'gift_cards.sum_supplier_refund_amount_cny'
      )
    ]
  ];
  const bookBalances = new Map<FinanceHistoryAssetAccountCode, Amount4>();
  for (const item of gl) {
    if (!isFinanceHistoryAssetAccountCode(item.accountCode)) continue;
    const amount = mapAmount4(item._sum.amountCny ?? 0, 'finance_journal_lines.sum_amount_cny');
    const signedAmount = item.direction === 'debit' ? amount : amount.negated();
    bookBalances.set(
      item.accountCode,
      (bookBalances.get(item.accountCode) ?? ZERO).add(signedAmount)
    );
  }

  const adjustments: FinanceHistoryAssetOpeningAdjustment[] = [];
  for (const [accountCode, target] of targets) {
    const difference = target.sub(bookBalances.get(accountCode) ?? ZERO);
    if (difference.isZero()) continue;
    adjustments.push({
      accountCode,
      direction: difference.gt(0) ? 'debit' : 'credit',
      amountCny: difference.abs()
    });
  }
  const adjustmentTotalCny = adjustments.reduce((total, item) => total.add(item.amountCny), ZERO);

  return {
    willCreate: adjustments.length > 0,
    adjustmentTotalCny,
    journalLineCount: adjustments.length * 2,
    adjustments
  };
}

function emptyAssetOpening(): FinanceHistoryAssetOpening {
  return {
    willCreate: false,
    adjustmentTotalCny: ZERO,
    journalLineCount: 0,
    adjustments: []
  };
}

function isFinanceHistoryAssetAccountCode(value: string): value is FinanceHistoryAssetAccountCode {
  return FINANCE_HISTORY_ASSET_ACCOUNT_CODES.some((accountCode) => accountCode === value);
}
