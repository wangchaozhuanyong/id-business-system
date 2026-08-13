export interface RefundIdBusinessV2OrderDto {
  refundCostAmount: string | number;
  reason: string;
  restoreBalance?: boolean;
  idempotencyKey: string;
}
