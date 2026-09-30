import { describe, expect, it } from 'vitest';
import { parseChatgptAccountImport } from './chatgpt-account-import';

describe('ChatGPT 账号粘贴导入', () => {
  it('按空格解析多行，并保留备注里的空格', () => {
    expect(
      parseChatgptAccountImport(
        'first@example.com pass1 - 第一条 备注\nsecond@example.com pass2 ABCD'
      )
    ).toEqual([
      { email: 'first@example.com', password: 'pass1', totpSecret: '', remark: '第一条 备注' },
      { email: 'second@example.com', password: 'pass2', totpSecret: 'ABCD', remark: '' }
    ]);
  });

  it('按 Tab 解析空的 2FA 列，并拒绝超出四列的数据', () => {
    expect(parseChatgptAccountImport('first@example.com\tpass1\t\t有备注')).toEqual([
      { email: 'first@example.com', password: 'pass1', totpSecret: '', remark: '有备注' }
    ]);
    expect(() => parseChatgptAccountImport('a@b.co\tp\t-\t备注\t多余')).toThrow('第 1 行');
  });

  it('拒绝空输入和缺少密码的行', () => {
    expect(() => parseChatgptAccountImport('  ')).toThrow('1 至 200 行');
    expect(() => parseChatgptAccountImport('first@example.com')).toThrow('第 1 行');
  });
});
