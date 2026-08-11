import { describe, expect, it } from 'vitest';
import { matchCountryCurrencyCode, resolveCountryCurrencyAutoMatch } from './countryCurrency';

describe('country currency matching', () => {
  it('matches Filipino country names to Philippine peso', () => {
    expect(matchCountryCurrencyCode('菲律宾')).toBe('PHP');
    expect(matchCountryCurrencyCode(' Philippines ')).toBe('PHP');
    expect(matchCountryCurrencyCode('Republic   of the Philippines')).toBe('PHP');
  });

  it('fills or clears an untouched automatic match when the country name changes', () => {
    expect(resolveCountryCurrencyAutoMatch('菲律宾', '', '')).toEqual({
      currencyCode: 'PHP',
      autoMatchedCurrencyCode: 'PHP'
    });
    expect(resolveCountryCurrencyAutoMatch('未识别国家', 'PHP', 'PHP')).toEqual({
      currencyCode: '',
      autoMatchedCurrencyCode: ''
    });
  });

  it('preserves a manually selected currency', () => {
    expect(resolveCountryCurrencyAutoMatch('菲律宾', 'USD', '')).toEqual({
      currencyCode: 'USD',
      autoMatchedCurrencyCode: ''
    });
  });
});
