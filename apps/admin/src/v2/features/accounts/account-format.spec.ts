import { describe, expect, it } from 'vitest';
import { formatAccountDate } from './account-format';

describe('account date display', () => {
  it('keeps Beijing time across a day boundary and repeated renders', () => {
    expect(formatAccountDate('2026-11-02T23:05:00Z')).toBe('2026/11/03 07:05');
    expect(formatAccountDate('2026-11-02T00:00:00Z')).toBe('2026/11/02 08:00');
    expect(formatAccountDate('2026-11-02T23:05:00Z')).toBe('2026/11/03 07:05');
  });
});
