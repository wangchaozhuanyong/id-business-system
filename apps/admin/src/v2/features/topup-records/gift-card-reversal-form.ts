import { formatV2Decimal } from '@/v2/utils/decimal';
import type {
  V2GiftCardRecord,
  V2GiftCardReversalAction,
  V2GiftCardReversalPayload
} from './contracts';

export interface PendingGiftCardReversal {
  giftCard: V2GiftCardRecord;
  action: V2GiftCardReversalAction;
}

export function canOfferGiftCardAccountLoss(
  pending: PendingGiftCardReversal | null,
  hasPermission: boolean
) {
  return Boolean(
    hasPermission &&
    pending?.action === 'redeemed' &&
    pending.giftCard.account.lossStatus === 'active'
  );
}

export function getGiftCardReversalCopy(
  pending: PendingGiftCardReversal | null,
  reportAccountLoss: boolean
) {
  if (!pending) {
    return { title: '', confirmText: '', message: '' };
  }
  const { giftCard, action } = pending;
  if (action === 'redeemed' && reportAccountLoss) {
    return {
      title: '确认被赎回并报损 ID',
      confirmText: '确认被赎回并报损 ID',
      message: `确认先将 ${giftCard.code} 标记为被赎回，并从 ${
        giftCard.account.appleIdMasked
      } 扣减余额 ${formatV2Decimal(
        giftCard.faceValue
      )}；随后报损冻结该 ID，保留扣卡后的剩余余额和人民币成本并计入损耗。`
    };
  }
  const actionLabel = action === 'redeemed' ? '标记为被赎回' : '撤回';
  return {
    title: action === 'redeemed' ? '确认标记被赎回' : '确认撤回礼品卡',
    confirmText: action === 'redeemed' ? '确认被赎回并扣减' : '确认撤回并扣减',
    message: `确认将 ${giftCard.code} ${actionLabel}，并从 ${
      giftCard.account.appleIdMasked
    } 扣减余额 ${formatV2Decimal(giftCard.faceValue)}。`
  };
}

export function buildGiftCardReversalPayload(
  pending: PendingGiftCardReversal,
  reason: string,
  idempotencyKey: string,
  reportAccountLoss: boolean
): V2GiftCardReversalPayload {
  return {
    action: pending.action,
    reason,
    idempotencyKey,
    reportAccountLoss: pending.action === 'redeemed' && reportAccountLoss
  };
}
