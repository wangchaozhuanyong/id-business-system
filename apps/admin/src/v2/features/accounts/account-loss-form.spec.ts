import { describe, expect, it } from 'vitest';
import { isAccountLossConfirmationValid } from './account-loss-form';

describe('account loss confirmation', () => {
  it('requires an explicit confirmation and a 2 to 500 character reason', () => {
    expect(isAccountLossConfirmationValid('ID 死亡', false)).toBe(false);
    expect(isAccountLossConfirmationValid('a', true)).toBe(false);
    expect(isAccountLossConfirmationValid('ID 死亡', true)).toBe(true);
    expect(isAccountLossConfirmationValid('x'.repeat(501), true)).toBe(false);
  });

  it('validates the trimmed reason', () => {
    expect(isAccountLossConfirmationValid('  a  ', true)).toBe(false);
    expect(isAccountLossConfirmationValid('  无法登录  ', true)).toBe(true);
  });
});
