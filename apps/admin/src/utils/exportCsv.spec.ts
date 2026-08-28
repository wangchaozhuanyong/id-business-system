import { describe, expect, it } from 'vitest';
import { decodeCsvTextSafetyPrefix, formatCsvValue } from './exportCsv';

describe('formatCsvValue', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+SUM(A1:A2)', "'+SUM(A1:A2)"],
    ['-cmd', "'-cmd"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['  =HYPERLINK("https://example.invalid")', '"\'  =HYPERLINK(""https://example.invalid"")"'],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', '"\'\r=1+1"'],
    ['\u00A0=1+1', "'\u00A0=1+1"],
    ['\uFEFF@SUM(A1:A2)', "'\uFEFF@SUM(A1:A2)"]
  ])('neutralizes spreadsheet formula text %j', (value, expected) => {
    expect(formatCsvValue(value)).toBe(expected);
  });

  it('keeps strict negative numbers numeric while rejecting formula-like minus text', () => {
    expect(formatCsvValue(-12.34)).toBe('-12.34');
    expect(formatCsvValue('-12.3400')).toBe('-12.3400');
    expect(formatCsvValue('-1+2')).toBe("'-1+2");
  });

  it('preserves regular CSV quoting and non-string values', () => {
    expect(formatCsvValue('含,逗号和"引号"')).toBe('"含,逗号和""引号"""');
    expect(formatCsvValue(true)).toBe('true');
    expect(formatCsvValue(null)).toBe('');
  });
});

describe('decodeCsvTextSafetyPrefix', () => {
  it('restores only prefixes emitted for dangerous exported text', () => {
    for (const value of [
      '=1+1',
      '+8613800000000',
      '-cmd',
      '@SUM(A1:A2)',
      '\tvalue',
      "'=1+1",
      "''@SUM(A1:A2)"
    ]) {
      const exported = formatCsvValue(value);
      expect(decodeCsvTextSafetyPrefix(exported)).toBe(value);
    }
    expect(decodeCsvTextSafetyPrefix("'普通文本")).toBe("'普通文本");
  });
});
