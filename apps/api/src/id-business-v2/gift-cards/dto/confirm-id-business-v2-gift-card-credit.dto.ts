export interface ConfirmIdBusinessV2GiftCardCreditDto {
  code: string;
  faceValue: string | number;
  exchangeRate: string | number;
  exchangeRateSnapshotId?: string | null;
  exchangeRatePrefilledValue?: string | number | null;
  supplierOptionId: string;
  idempotencyKey: string;
  remark?: string | null;
}
