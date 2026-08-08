import { describe, expect, it } from 'vitest';
import { isAccountRecordStatusReasonValid } from './account-record-status-form';

describe('account record status reason', () => {
  it('requires a trimmed reason between 2 and 200 characters', () => {
    expect(isAccountRecordStatusReasonValid('')).toBe(false);
    expect(isAccountRecordStatusReasonValid('a')).toBe(false);
    expect(isAccountRecordStatusReasonValid(' 库存复核暂停使用 ')).toBe(true);
    expect(isAccountRecordStatusReasonValid('a'.repeat(201))).toBe(false);
  });
});
