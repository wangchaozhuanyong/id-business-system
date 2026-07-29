export type IdBusinessV2GiftCardReversalAction = 'redeemed' | 'withdrawn';

export interface ReverseIdBusinessV2GiftCardDto {
  action: IdBusinessV2GiftCardReversalAction;
  reason: string;
  idempotencyKey: string;
  reportAccountLoss?: boolean;
}
