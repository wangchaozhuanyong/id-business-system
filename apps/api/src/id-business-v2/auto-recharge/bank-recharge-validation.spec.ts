import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { bankRechargePassword } from './bank-recharge-validation';

describe('bank recharge password validation', () => {
  it('keeps exact password bytes, including intentional outer spaces', () => {
    expect(bankRechargePassword(' a secret ')).toBe(' a secret ');
  });

  it('rejects empty and control-character passwords', () => {
    expect(() => bankRechargePassword('')).toThrow(BadRequestException);
    expect(() => bankRechargePassword('a\nsecret')).toThrow(BadRequestException);
  });
});
