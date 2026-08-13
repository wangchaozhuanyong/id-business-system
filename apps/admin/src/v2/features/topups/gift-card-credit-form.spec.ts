import { describe, expect, it } from 'vitest';
import {
  buildManualGiftCardCreditPayload,
  getGiftCardCodeError,
  normalizeGiftCardCode
} from './gift-card-credit-form';

describe('gift card manual rate form', () => {
  it('normalizes and validates gift card codes with the server contract', () => {
    expect(normalizeGiftCardCode('x123-4567-89ab-cdef')).toBe('X123456789ABCDEF');
    expect(getGiftCardCodeError('x123-4567-89ab-cdef')).toBe('');
    expect(getGiftCardCodeError('ABC12')).toBe('礼品卡号必须是 10 至 64 位且同时包含字母和数字');
    expect(getGiftCardCodeError('1234567890')).toBe(
      '礼品卡号必须是 10 至 64 位且同时包含字母和数字'
    );
  });

  it('posts the card identity, country, manual rate and business credit time', () => {
    const payload = buildManualGiftCardCreditPayload({
      code: 'ABCD123456',
      faceValue: ' 200 ',
      cardNameOptionId: 'card-name-1',
      countryOptionId: 'country-1',
      exchangeRate: ' 5.4 ',
      supplierOptionId: 'supplier-1',
      creditedAt: '2026-07-29T03:00:00.000Z',
      idempotencyKey: 'request-1',
      confirmedSoldByOrderId: 'order-1',
      remark: ' manual rate '
    });

    expect(payload).toEqual({
      code: 'ABCD123456',
      faceValue: '200',
      cardNameOptionId: 'card-name-1',
      countryOptionId: 'country-1',
      exchangeRate: '5.4',
      supplierOptionId: 'supplier-1',
      creditedAt: '2026-07-29T03:00:00.000Z',
      idempotencyKey: 'request-1',
      confirmedSoldByOrderId: 'order-1',
      remark: 'manual rate'
    });
    expect(payload).not.toHaveProperty('purchaseCurrency');
    expect(payload).not.toHaveProperty('purchaseOriginalAmount');
    expect(payload).not.toHaveProperty('paidAt');
  });
});
