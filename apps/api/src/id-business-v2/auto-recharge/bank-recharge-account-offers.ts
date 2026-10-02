import { BadRequestException, ConflictException } from '@nestjs/common';
import { V2_ACCOUNT_OFFERS, type V2AccountOffer } from '@apple-business/shared';

export function accountOfferUpdate(
  value: unknown
): Partial<{ offerStatus: V2AccountOffer; offerSource: 'manual'; offerObservedAt: Date }> {
  if (value === undefined) return {};
  if (!V2_ACCOUNT_OFFERS.includes(value as V2AccountOffer))
    throw new BadRequestException('优惠状况无效');
  return {
    offerStatus: value as V2AccountOffer,
    offerSource: 'manual',
    offerObservedAt: new Date()
  };
}
export function assertAccountEditVersion(expected: unknown, updatedAt: Date) {
  if (expected !== undefined && expected !== updatedAt.toISOString())
    throw new ConflictException('账号资料已变化，请重新核对后保存');
}
