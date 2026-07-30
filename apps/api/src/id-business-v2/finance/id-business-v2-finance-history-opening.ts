import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { roundV2Decimal, toV2Decimal } from '../decimal-policy';

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
  amountCny: PrismaNamespace.Decimal;
}

export interface FinanceHistoryAssetOpening {
  willCreate: boolean;
  adjustmentTotalCny: PrismaNamespace.Decimal;
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

const ZERO = new PrismaNamespace.Decimal(0);

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
      where: {
        accountCode: {
          in: [...FINANCE_HISTORY_ASSET_ACCOUNT_CODES]
        }
      },
      _sum: { amountCny: true }
    })
  ]);

  const targets: ReadonlyArray<[FinanceHistoryAssetAccountCode, PrismaNamespace.Decimal]> = [
    ['gift_card_inventory', toV2Decimal(accountAssets._sum.balanceCostAmount ?? 0)],
    ['id_inventory', toV2Decimal(unsoldIds._sum.purchaseCost ?? 0)],
    ['supplier_prepayment', toV2Decimal(supplierWallets._sum.currentBalanceCny ?? 0)],
    ['supplier_refund_receivable', toV2Decimal(pendingRefunds._sum.supplierRefundAmountCny ?? 0)]
  ];
  const bookBalances = new Map<FinanceHistoryAssetAccountCode, PrismaNamespace.Decimal>();
  for (const item of gl) {
    if (!isFinanceHistoryAssetAccountCode(item.accountCode)) continue;
    const amount = toV2Decimal(item._sum.amountCny ?? 0);
    const signedAmount = item.direction === 'debit' ? amount : amount.negated();
    bookBalances.set(
      item.accountCode,
      (bookBalances.get(item.accountCode) ?? ZERO).add(signedAmount)
    );
  }

  const adjustments: FinanceHistoryAssetOpeningAdjustment[] = [];
  for (const [accountCode, target] of targets) {
    const difference = roundV2Decimal(target.sub(bookBalances.get(accountCode) ?? ZERO));
    if (difference.eq(0)) continue;
    adjustments.push({
      accountCode,
      direction: difference.gt(0) ? 'debit' : 'credit',
      amountCny: difference.abs()
    });
  }
  const adjustmentTotalCny = roundV2Decimal(
    adjustments.reduce((total, item) => total.add(item.amountCny), ZERO)
  );

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
