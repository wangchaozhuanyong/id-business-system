import type { Amount4 } from '../runtime/public-api';

export interface AccountLossResponseRow {
  id: string;
  accountId: string;
  ledgerEntryId: string;
  appleIdMasked: string;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  supplierOptionId: string | null;
  supplierName: string | null;
  saleState: 'available' | 'sold';
  soldOrderId: string | null;
  soldOrderNo: string | null;
  lossBalance: Amount4;
  lossCostAmount: Amount4;
  idPurchaseCostLossAmount: Amount4;
  reason: string;
  reportedByName: string | null;
  reportedAt: Date;
  reportedBy: { id: string; username: string; displayName: string } | null;
}

export function toAccountLossRecordResponse(loss: AccountLossResponseRow) {
  return {
    id: loss.id,
    accountId: loss.accountId,
    ledgerEntryId: loss.ledgerEntryId,
    appleIdMasked: loss.appleIdMasked,
    countryOptionId: loss.countryOptionId,
    countryName: loss.countryName,
    currencyCode: loss.currencyCode,
    supplierOptionId: loss.supplierOptionId,
    supplierName: loss.supplierName,
    saleState: loss.saleState,
    soldOrderId: loss.soldOrderId,
    soldOrderNo: loss.soldOrderNo,
    lossBalance: loss.lossBalance.toString(),
    lossCostAmount: loss.lossCostAmount.toString(),
    idPurchaseCostLossAmount: loss.idPurchaseCostLossAmount.toString(),
    reason: loss.reason,
    reportedByName: loss.reportedByName,
    reportedBy: loss.reportedBy,
    reportedAt: loss.reportedAt.toISOString()
  };
}

export function toAccountLossReportResult(loss: AccountLossResponseRow, idempotentReplay: boolean) {
  return {
    lossRecord: toAccountLossRecordResponse(loss),
    account: {
      id: loss.accountId,
      appleIdMasked: loss.appleIdMasked,
      lossStatus: 'reported' as const,
      lossReportedAt: loss.reportedAt.toISOString(),
      currentBalance: '0',
      balanceCostAmount: '0'
    },
    idempotentReplay
  };
}
