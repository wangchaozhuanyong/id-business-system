import { describe, expect, it } from 'vitest';
import { formatRechargeExpiry } from './recharge-form';

describe('formatRechargeExpiry', () => {
  it('formats four typed digits as MM/YY', () => {
    expect(formatRechargeExpiry('0')).toBe('0');
    expect(formatRechargeExpiry('08')).toBe('08');
    expect(formatRechargeExpiry('082')).toBe('08/2');
    expect(formatRechargeExpiry('0829')).toBe('08/29');
  });

  it('supports pasted separators, non-digit cleanup, and deletion', () => {
    expect(formatRechargeExpiry('08/29')).toBe('08/29');
    expect(formatRechargeExpiry('08 / 29')).toBe('08/29');
    expect(formatRechargeExpiry('08/2')).toBe('08/2');
    expect(formatRechargeExpiry('08/')).toBe('08');
    expect(formatRechargeExpiry('082912')).toBe('08/29');
  });
});
