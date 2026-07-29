import { describe, expect, it } from 'vitest';
import type { V2GiftCardRecord } from './contracts';
import {
  buildGiftCardReversalPayload,
  canOfferGiftCardAccountLoss,
  getGiftCardReversalCopy
} from './gift-card-reversal-form';

function makeGiftCard(lossStatus: 'active' | 'reported' = 'active') {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    codeMasked: 'X123****CDEF',
    faceValue: '20',
    status: 'credited',
    account: {
      id: '11111111-1111-4111-8111-111111111111',
      appleIdMasked: 'us***@example.com',
      lossStatus,
      lossReportedAt: lossStatus === 'reported' ? '2026-07-29T12:00:00.000Z' : null
    }
  } as V2GiftCardRecord;
}

describe('gift card reversal account-loss form', () => {
  it('offers permanent ID loss only for redeemed, active IDs with both permissions', () => {
    const giftCard = makeGiftCard();

    expect(canOfferGiftCardAccountLoss({ giftCard, action: 'redeemed' }, true)).toBe(true);
    expect(canOfferGiftCardAccountLoss({ giftCard, action: 'withdrawn' }, true)).toBe(false);
    expect(canOfferGiftCardAccountLoss({ giftCard, action: 'redeemed' }, false)).toBe(false);
    expect(
      canOfferGiftCardAccountLoss({ giftCard: makeGiftCard('reported'), action: 'redeemed' }, true)
    ).toBe(false);
  });

  it('keeps the existing card-only confirmation by default', () => {
    const copy = getGiftCardReversalCopy({ giftCard: makeGiftCard(), action: 'redeemed' }, false);

    expect(copy.title).toBe('确认标记被赎回');
    expect(copy.confirmText).toBe('确认被赎回并扣减');
    expect(copy.message).not.toContain('永久报损');
  });

  it('shows permanent-loss copy and sends the selected option with the shared reason', () => {
    const pending = { giftCard: makeGiftCard(), action: 'redeemed' as const };
    const copy = getGiftCardReversalCopy(pending, true);
    const payload = buildGiftCardReversalPayload(
      pending,
      '卡片和 ID 同时报损',
      'reversal-12345678',
      true
    );

    expect(copy.confirmText).toBe('确认被赎回并报损 ID');
    expect(copy.message).toContain('清零扣卡后的全部剩余余额和人民币成本');
    expect(payload).toEqual({
      action: 'redeemed',
      reason: '卡片和 ID 同时报损',
      idempotencyKey: 'reversal-12345678',
      reportAccountLoss: true
    });
  });

  it('never carries permanent ID loss into a withdrawal request', () => {
    expect(
      buildGiftCardReversalPayload(
        { giftCard: makeGiftCard(), action: 'withdrawn' },
        '撤回错误加卡',
        'reversal-12345678',
        true
      ).reportAccountLoss
    ).toBe(false);
  });
});
