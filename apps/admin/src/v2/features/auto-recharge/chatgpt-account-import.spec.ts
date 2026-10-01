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

  it('只要求邮箱，密码和 2FA 均可稍后补充', () => {
    expect(parseChatgptAccountImport('first@example.com')).toEqual([
      { email: 'first@example.com', password: '', totpSecret: '', remark: '' }
    ]);
    expect(parseChatgptAccountImport('first@example.com\t\tJBSWY3DPEHPK3PXP')).toEqual([
      { email: 'first@example.com', password: '', totpSecret: 'JBSWY3DPEHPK3PXP', remark: '' }
    ]);
    expect(parseChatgptAccountImport('first@example.com - JBSWY3DPEHPK3PXP')).toEqual([
      { email: 'first@example.com', password: '', totpSecret: 'JBSWY3DPEHPK3PXP', remark: '' }
    ]);
  });

  it('无密码格式直接导入邮箱和 2FA，备注可包含空格', () => {
    expect(
      parseChatgptAccountImport(
        'first@example.com JBSWY3DPEHPK3PXP 两段 备注\nsecond@example.com\tJBSWY3DPEHPK3PXP',
        'without_password'
      )
    ).toEqual([
      {
        email: 'first@example.com',
        password: '',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        remark: '两段 备注'
      },
      { email: 'second@example.com', password: '', totpSecret: 'JBSWY3DPEHPK3PXP', remark: '' }
    ]);
  });

  it('无密码格式保留空 2FA 列和完整 otpauth 链接', () => {
    const uri = 'otpauth://totp/Test:user?secret=JBSWY3DPEHPK3PXP&issuer=Test';
    expect(
      parseChatgptAccountImport(
        `first@example.com\t${uri}\t备注\nsecond@example.com\t\t无密钥`,
        'without_password'
      )
    ).toEqual([
      { email: 'first@example.com', password: '', totpSecret: uri, remark: '备注' },
      { email: 'second@example.com', password: '', totpSecret: '', remark: '无密钥' }
    ]);
  });

  it('含密码格式不会将类似 Base32 的密码猜成 2FA', () => {
    expect(parseChatgptAccountImport('first@example.com JBSWY3DPEHPK3PXP')).toEqual([
      { email: 'first@example.com', password: 'JBSWY3DPEHPK3PXP', totpSecret: '', remark: '' }
    ]);
  });

  it('拒绝空输入、空邮箱和与所选格式不符的 Tab 列数', () => {
    expect(() => parseChatgptAccountImport('  ')).toThrow('1 至 200 行');
    expect(() => parseChatgptAccountImport('\t\tJBSWY3DPEHPK3PXP')).toThrow('第 1 行');
    expect(() => parseChatgptAccountImport('a@b.co\t密钥\t备注\t多余', 'without_password')).toThrow(
      '第 1 行'
    );
    expect(() => parseChatgptAccountImport(Array(201).fill('a@b.co').join('\n'))).toThrow(
      '1 至 200 行'
    );
  });
});
