import { describe, expect, it } from 'vitest';
import { isAccountLossRecoveryReasonValid } from './account-loss-recovery-form';

describe('account loss recovery form', () => {
  it('requires a trimmed reason between 2 and 500 characters', () => {
    expect(isAccountLossRecoveryReasonValid(' ')).toBe(false);
    expect(isAccountLossRecoveryReasonValid('已恢复正常')).toBe(true);
    expect(isAccountLossRecoveryReasonValid('a'.repeat(501))).toBe(false);
  });
});
