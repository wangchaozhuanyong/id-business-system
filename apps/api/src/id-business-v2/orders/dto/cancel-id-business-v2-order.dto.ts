export interface CancelIdBusinessV2OrderDto {
  reason: string;
  idempotencyKey: string;
}
