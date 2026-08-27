import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4 } from '../../runtime/public-api';

export interface LockedFinanceGiftCardRefund {
  id: string;
  codeMasked: string;
  supplierRefundStatus: string;
  supplierRefundAmount: ReturnType<typeof mapAmount4>;
  supplierRefundAmountCny: ReturnType<typeof mapAmount4>;
  purchaseSupplierAccountId: string | null;
}

export async function lockFinanceGiftCardRefund(
  tx: Prisma.TransactionClient,
  giftCardId: string
): Promise<LockedFinanceGiftCardRefund | null> {
  const rows = await tx.$queryRaw<
    Array<{
      id: string;
      codeMasked: string;
      supplierRefundStatus: string;
      supplierRefundAmount: unknown;
      supplierRefundAmountCny: unknown;
      purchaseSupplierAccountId: string | null;
    }>
  >`
    SELECT
      "id",
      "code_masked" AS "codeMasked",
      "supplier_refund_status" AS "supplierRefundStatus",
      "supplier_refund_amount" AS "supplierRefundAmount",
      "supplier_refund_amount_cny" AS "supplierRefundAmountCny",
      "purchase_supplier_account_id" AS "purchaseSupplierAccountId"
    FROM "id_business_v2_gift_cards"
    WHERE "id" = ${giftCardId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        supplierRefundAmount: mapAmount4(
          row.supplierRefundAmount,
          'gift card supplierRefundAmount'
        ),
        supplierRefundAmountCny: mapAmount4(
          row.supplierRefundAmountCny,
          'gift card supplierRefundAmountCny'
        )
      }
    : null;
}

@Injectable()
export class IdBusinessV2FinanceGiftCardRefundRepository {
  lock(tx: V2CommandTransaction, giftCardId: string) {
    return lockFinanceGiftCardRefund(tx, giftCardId);
  }

  findOriginalSupplierWalletId(tx: V2CommandTransaction, giftCardId: string) {
    return tx.idBusinessV2TopupSupplierLedger
      .findFirst({
        where: { giftCardId, entryType: 'gift_card_debit' },
        orderBy: { createdAt: 'desc' },
        select: { supplierAccountId: true }
      })
      .then((row) => row?.supplierAccountId ?? null);
  }

  createReceivedLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2TopupSupplierLedgerUncheckedCreateInput
  ) {
    return tx.idBusinessV2TopupSupplierLedger.create({ data });
  }

  updateSupplierWalletBalances(
    tx: V2CommandTransaction,
    id: string,
    currentBalance: string,
    currentBalanceCny: string,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2TopupSupplierAccount.update({
      where: { id },
      data: { currentBalance, currentBalanceCny, updatedByUserId }
    });
  }

  closeGiftCard(
    tx: V2CommandTransaction,
    id: string,
    status: 'received' | 'written_off',
    closedAt: Date,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2GiftCard.update({
      where: { id },
      data: {
        supplierRefundStatus: status,
        supplierRefundClosedAt: closedAt,
        updatedByUserId
      }
    });
  }
}
