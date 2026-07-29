export interface ReportIdBusinessV2AccountLossDto {
  reason: string;
  expectedCurrentBalance: string | number;
  expectedBalanceCostAmount: string | number;
  idempotencyKey: string;
}
