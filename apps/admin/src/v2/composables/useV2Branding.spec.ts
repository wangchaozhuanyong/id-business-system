import { describe, expect, it } from 'vitest';
import { V2_BRANDING_DEFAULTS, splitV2BrandingHeroTitle } from '@apple-business/shared';
import { formatV2DocumentTitle, getV2BrandingSnapshot, setV2Branding } from './useV2Branding';

describe('useV2Branding', () => {
  it('splits configured login hero copy while keeping a default fallback', () => {
    expect(splitV2BrandingHeroTitle('订单\n余额')).toEqual(['订单', '余额']);
    expect(splitV2BrandingHeroTitle('   ')).toEqual(['把订单、余额与续费', '收进一条安全动线']);
  });

  it('formats document title with the configured suffix', () => {
    setV2Branding({
      ...V2_BRANDING_DEFAULTS,
      documentTitleSuffix: '会员后台',
      updatedByUserId: null,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z'
    });

    expect(formatV2DocumentTitle('登录')).toBe('登录 - 会员后台');
    expect(formatV2DocumentTitle('会员后台')).toBe('会员后台');
  });

  it('falls back to the default image logo when the configured URL is blank', () => {
    setV2Branding({
      ...V2_BRANDING_DEFAULTS,
      logoUrl: '   ',
      updatedByUserId: null,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z'
    });

    expect(getV2BrandingSnapshot().logoUrl).toBe('/brand/default-logo.svg');
  });
});
