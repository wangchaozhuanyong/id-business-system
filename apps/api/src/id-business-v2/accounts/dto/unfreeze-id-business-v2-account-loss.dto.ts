export interface UnfreezeIdBusinessV2AccountLossDto {
  reason: string;
  expectedLossId: string;
  idempotencyKey: string;
}
