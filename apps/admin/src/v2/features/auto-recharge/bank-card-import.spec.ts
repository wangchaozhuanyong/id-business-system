import { describe, expect, it } from 'vitest';
import { parseBankCardImport } from './bank-card-import';

describe('银行卡粘贴导入', () => {
  it('支持空格与 Tab 分列，并允许留空备注', () => {
    expect(
      parseBankCardImport('5555555555554444 12/39 第一张 备用\n4111111111111111\t11/39\t\t第二张')
    ).toEqual([
      { number: '5555555555554444', expiry: '12/39', remark1: '第一张', remark2: '备用' },
      { number: '4111111111111111', expiry: '11/39', remark1: '', remark2: '第二张' }
    ]);
  });

  it('拒绝多出的安全码列和放在备注里的安全码', () => {
    expect(() => parseBankCardImport('5555555555554444 12/39 备注 备用 123')).toThrow(
      '安全码不能导入'
    );
    expect(() => parseBankCardImport('5555555555554444 12/39 123')).toThrow('可能包含安全码');
  });
});
