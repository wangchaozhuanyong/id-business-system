import { describe, expect, it } from 'vitest';
import { parseCsv, resolveAccountCountryCsvHeader } from './csv';

describe('parseCsv', () => {
  it('parses Excel-compatible BOM, CRLF, quoted commas and escaped quotes', () => {
    expect(parseCsv('\uFEFFID账号,备注\r\nuser@example.com,"含,逗号和""引号"""\r\n')).toEqual([
      ['ID账号', '备注'],
      ['user@example.com', '含,逗号和"引号"']
    ]);
  });

  it('ignores blank rows and rejects an unclosed quoted value', () => {
    expect(parseCsv('ID账号\n\nuser@example.com\n')).toEqual([['ID账号'], ['user@example.com']]);
    expect(() => parseCsv('ID账号,备注\nuser@example.com,"未闭合')).toThrow(
      'CSV 文件存在未闭合的引号'
    );
  });

  it('prefers the country header and accepts the compatible ID region header', () => {
    expect(resolveAccountCountryCsvHeader(['ID账号', '国家', 'ID地区'])).toBe('国家');
    expect(resolveAccountCountryCsvHeader(['ID账号', 'ID地区'])).toBe('ID地区');
    expect(resolveAccountCountryCsvHeader(['ID账号', 'ID状态'])).toBeNull();
  });
});
