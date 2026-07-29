import { describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  divideDecimalStrings,
  formatV2Decimal,
  multiplyDecimalStrings,
  roundDecimalString
} from './decimal';

describe('V2 decimal policy', () => {
  it('rounds all displayed decimals to at most four places', () => {
    expect(formatV2Decimal('1234567.89165')).toBe('1,234,567.8917');
    expect(formatV2Decimal('5.0000')).toBe('5');
    expect(formatV2Decimal('5', { minimumFractionDigits: 2 })).toBe('5.00');
  });

  it('uses exact half-up arithmetic for business previews', () => {
    expect(roundDecimalString('1.23455')).toBe('1.2346');
    expect(multiplyDecimalStrings('100', '5.6789')).toBe('567.89');
    expect(addDecimalStrings('110.1254', '567.89')).toBe('678.0154');
    expect(divideDecimalStrings('690', '120')).toBe('5.75');
  });
});
