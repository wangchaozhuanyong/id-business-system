export interface RefundIdBusinessV2OrderDto {
  refundCostAmount: string | number;
  reason: string;
  restoreBalance?: boolean;
  accountReturned?: boolean;
  idempotencyKey: string;
}
