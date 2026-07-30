import { describe, expect, it } from 'vitest';
import { getSafeV2Redirect, requiresPasswordResetRedirect } from '@/v2/router/passwordReset';

describe('V2 password reset redirect', () => {
  it('preserves an internal V2 destination including query parameters', () => {
    expect(getSafeV2Redirect('/v2/orders?status=pending')).toBe('/v2/orders?status=pending');
    expect(getSafeV2Redirect(['/v2/dashboard', '/v2/ignored'])).toBe('/v2/dashboard');
  });

  it.each([
    undefined,
    'https://example.com',
    '//example.com/v2',
    '/v2-unsafe',
    '/change-password',
    '/v2\\evil',
    '/v2/orders\nforged'
  ])('falls back for unsafe redirect value %s', (value) => {
    expect(getSafeV2Redirect(value)).toBe('/v2');
  });

  it('requires the reset page until the reset flag is cleared', () => {
    expect(requiresPasswordResetRedirect(true, undefined)).toBe(true);
    expect(requiresPasswordResetRedirect(true, false)).toBe(true);
    expect(requiresPasswordResetRedirect(true, true)).toBe(false);
    expect(requiresPasswordResetRedirect(false, undefined)).toBe(false);
  });
});
