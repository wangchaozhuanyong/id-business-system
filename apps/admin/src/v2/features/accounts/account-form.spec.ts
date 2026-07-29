import { describe, expect, it } from 'vitest';
import {
  calculateBalanceCost,
  calculateExchangeRate,
  isNonNegativeExchangeRate
} from './account-form';

describe('account balance exchange rate calculations', () => {
  it('calculates RMB cost from balance multiplied by exchange rate', () => {
    expect(calculateBalanceCost('20', '5.7')).toBe('114');
    expect(calculateBalanceCost('0.1', '5.7')).toBe('0.57');
  });

  it('rounds RMB cost half up to four decimal places without floating point arithmetic', () => {
    expect(calculateBalanceCost('1.0001', '1.5')).toBe('1.5002');
  });

  it('derives the exchange rate from an existing balance and RMB cost', () => {
    expect(calculateExchangeRate('20', '70')).toBe('3.5');
    expect(calculateExchangeRate('0', '0')).toBe('0');
  });

  it('accepts at most four decimal places for exchange rates', () => {
    expect(isNonNegativeExchangeRate('5.7001')).toBe(true);
    expect(isNonNegativeExchangeRate('5.70001')).toBe(false);
  });
});
