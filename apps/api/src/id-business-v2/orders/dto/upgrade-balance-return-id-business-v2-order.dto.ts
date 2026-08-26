export interface PreviewUpgradeBalanceReturnIdBusinessV2OrderDto {
  returnedBalanceAmount: string | number;
}

export interface RecordUpgradeBalanceReturnIdBusinessV2OrderDto extends PreviewUpgradeBalanceReturnIdBusinessV2OrderDto {
  reason: string;
  idempotencyKey: string;
}

export interface ReverseUpgradeBalanceReturnIdBusinessV2OrderDto {
  reason: string;
  idempotencyKey: string;
}
