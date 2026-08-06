import type { Amount4 } from '../runtime/public-api';

export interface AccountLossResponseRow {
  id: string;
  accountId: string;
  ledgerEntryId: string;
  status: 'active' | 'reversed';
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
  previousStatusOptionId: string | null;
  previousStatusName: string | null;
  previousRecordStatus: 'active' | 'disabled' | null;
  financeJournalId: string | null;
  reversalFinanceJournalId: string | null;
  reversalReason: string | null;
  reversedAt: Date | null;
  reversedByName: string | null;
  reversedBy: { id: string; username: string; displayName: string } | null;
}

export function toAccountLossRecordResponse(loss: AccountLossResponseRow) {
  return {
    id: loss.id,
    accountId: loss.accountId,
    ledgerEntryId: loss.ledgerEntryId,
    status: loss.status,
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
    reportedAt: loss.reportedAt.toISOString(),
    previousStatusOptionId: loss.previousStatusOptionId,
    previousStatusName: loss.previousStatusName,
    previousRecordStatus: loss.previousRecordStatus,
    financeJournalId: loss.financeJournalId,
    reversalFinanceJournalId: loss.reversalFinanceJournalId,
    reversalReason: loss.reversalReason,
    reversedAt: loss.reversedAt?.toISOString() ?? null,
    reversedByName: loss.reversedByName,
    reversedBy: loss.reversedBy
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
      activeLossId: loss.id,
      currentBalance: loss.lossBalance.toString(),
      balanceCostAmount: loss.lossCostAmount.toString()
    },
    idempotentReplay
  };
}

export function toAccountLossUnfreezeResult(
  loss: AccountLossResponseRow,
  idempotentReplay: boolean
) {
  return {
    lossRecord: toAccountLossRecordResponse(loss),
    account: {
      id: loss.accountId,
      appleIdMasked: loss.appleIdMasked,
      lossStatus: 'active' as const,
      lossReportedAt: null,
      activeLossId: null,
      currentBalance: loss.lossBalance.toString(),
      balanceCostAmount: loss.lossCostAmount.toString()
    },
    idempotentReplay
  };
}
