import { describe, expect, it } from 'vitest';
import { cardNumber, parseManagedCard } from './bank-recharge-card-validation';

describe('银行卡资料校验', () => {
  it('校验卡号并生成尾号', () => {
    expect(cardNumber('5555 5555 5555 4444')).toBe('5555555555554444');
    expect(parseManagedCard({ number: '5555555555554444', expiry: '12/39' }, 'USD').last4).toBe(
      '4444'
    );
    expect(() => cardNumber('5555555555554445')).toThrow('校验失败');
  });

  it('拒绝过期、非法列和疑似安全码备注', () => {
    expect(() => parseManagedCard({ number: '5555555555554444', expiry: '01/20' }, 'USD')).toThrow(
      '过有效期'
    );
    expect(() =>
      parseManagedCard({ number: '5555555555554444', expiry: '12/39', cvc: '123' }, 'USD')
    ).toThrow('安全码不能');
    expect(() =>
      parseManagedCard({ number: '5555555555554444', expiry: '12/39', remark1: '123' }, 'USD')
    ).toThrow('不能把安全码');
  });
});
