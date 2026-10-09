import { describe, expect, it } from 'vitest';
import { importLines, parseImportedCards } from './importInput';
describe('原版银行卡导入兼容性', () => {
  it('保留原版卡号、有效期、安全码、持卡人四段格式', () => {
    expect(parseImportedCards('4111111111111111|12/29|123|TEST USER')).toEqual([
      {
        number: '4111111111111111',
        expiryMonth: 12,
        expiryYear: 29,
        cvc: '123',
        holderName: 'TEST USER'
      }
    ]);
  });
  it('兼容拆分月份年份并接受空持卡姓名', () => {
    expect(parseImportedCards('4111111111111111|12|2029|123')[0]).toMatchObject({
      expiryMonth: 12,
      expiryYear: 2029,
      holderName: ''
    });
  });
  it('格式错误不在错误说明中回显卡号或安全码', () => {
    try {
      parseImportedCards('4111111111111111|18/29|999|TEST');
      throw new Error('应拒绝');
    } catch (error) {
      expect(String(error)).toContain('第 1 行');
      expect(String(error)).not.toContain('4111111111111111');
      expect(String(error)).not.toContain('999');
    }
  });
  it('单次导入数量保持 500 上限', () => {
    expect(() => importLines(Array.from({ length: 501 }, () => 'one').join('\n'))).toThrow('500');
    expect(importLines(' one \n\n two ')).toEqual(['one', 'two']);
  });
});
