export interface CreateIdBusinessV2ManualRenewalDto {
  serviceOptionId: string;
  settlementPlatformOptionId?: string | null;
  platformOrderNo?: string | null;
  receivedAmount: string | number;
  balanceAmount: string | number;
  openedAt: string;
  dueAt: string;
  idempotencyKey: string;
  remark?: string | null;
}
