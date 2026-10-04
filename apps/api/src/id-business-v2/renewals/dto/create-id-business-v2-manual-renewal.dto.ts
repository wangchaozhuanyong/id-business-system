export interface CreateIdBusinessV2ManualRenewalDto {
  serviceOptionId: string;
  settlementPlatformOptionId: string;
  platformOrderNo?: string | null;
  receivedAmount: string | number;
  receivedFinanceAccountId?: string | null;
  balanceAmount: string | number;
  openedAt: string;
  dueAt: string;
  idempotencyKey: string;
  remark?: string | null;
}
