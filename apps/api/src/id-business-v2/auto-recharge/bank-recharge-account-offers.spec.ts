import { describe, expect, it } from 'vitest';
import { accountOfferUpdate, assertAccountEditVersion } from './bank-recharge-account-offers';

describe('账号优惠人工修改', () => {
  it('仅修改其他资料不会将自动判定变成人工标记', () => {
    expect(accountOfferUpdate(undefined)).toEqual({});
    expect(accountOfferUpdate('free_trial')).toMatchObject({
      offerStatus: 'free_trial',
      offerSource: 'manual',
      offerObservedAt: expect.any(Date)
    });
  });
  it('拒绝未定义的优惠值', () => {
    for (const value of ['free', null, '', 0]) {
      expect(() => accountOfferUpdate(value)).toThrow('优惠状况无效');
    }
  });
  it('拒绝覆盖打开编辑后发生的自动或人工变更', () => {
    const current = new Date('2026-10-02T00:00:01Z');
    expect(() => assertAccountEditVersion(current.toISOString(), current)).not.toThrow();
    expect(() => assertAccountEditVersion('2026-10-02T00:00:00.000Z', current)).toThrow('已变化');
  });
});
