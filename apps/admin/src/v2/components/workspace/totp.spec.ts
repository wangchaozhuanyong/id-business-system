import { describe, expect, it } from 'vitest';
import { V2_TOTP_INPUT_LIMITS, generateV2TotpCodes, parseV2TotpInput } from './totp';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('workspace TOTP parser', () => {
  it('matches the RFC 6238 SHA1 test vector', () => {
    const result = parseV2TotpInput(
      `otpauth://totp/RFC:test?secret=${RFC_SECRET}&algorithm=SHA1&digits=8&period=30`
    );

    expect(result.errors).toEqual([]);
    expect(generateV2TotpCodes(result.accounts, 59_000)).toEqual([
      {
        id: 'totp-1',
        token: '94287082',
        remainingSeconds: 1,
        progress: expect.closeTo(3.333, 2)
      }
    ]);
  });

  it('parses raw and pipe-delimited secrets without retaining passwords in results', () => {
    const result = parseV2TotpInput(
      `${RFC_SECRET}\nuser-01|account-password|${RFC_SECRET}|mail@example.com|mail-password`
    );

    expect(result.errors).toEqual([]);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toMatchObject({
      label: '第 1 行',
      algorithm: 'SHA1',
      digits: 6,
      period: 30
    });
    expect(result.accounts[1]).toMatchObject({ label: 'user-01' });
    expect(JSON.stringify(result.accounts)).not.toContain('account-password');
    expect(JSON.stringify(result.accounts)).not.toContain('mail-password');
  });

  it('keeps valid rows when another row is invalid', () => {
    const result = parseV2TotpInput(`${RFC_SECRET}\nuser|password|invalid!|mail|password`);

    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toEqual([{ lineNumber: 2, message: '2FA 密钥必须是有效的 Base32 文本' }]);
    expect(JSON.stringify(result.errors)).not.toContain('password');
  });

  it('rejects short and obviously weak Base32 secrets', () => {
    const result = parseV2TotpInput(
      ['abcdefghijklmno', 'AAAAAAAAAAAAAAAA', 'ABABABABABABABAB', 'JBSWY3DPEHPK3PXP'].join('\n')
    );

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.lineNumber).toBe(4);
    expect(result.errors).toEqual([
      { lineNumber: 1, message: '2FA 密钥长度不能少于 16 位' },
      { lineNumber: 2, message: '2FA 密钥内容过于简单，请粘贴账号服务生成的真实密钥' },
      { lineNumber: 3, message: '2FA 密钥内容过于简单，请粘贴账号服务生成的真实密钥' }
    ]);
  });

  it('applies secret strength checks to otpauth URIs', () => {
    const result = parseV2TotpInput('otpauth://totp/Test?secret=AAAAAAAAAAAAAAAA');

    expect(result.accounts).toEqual([]);
    expect(result.errors).toEqual([
      { lineNumber: 1, message: '2FA 密钥内容过于简单，请粘贴账号服务生成的真实密钥' }
    ]);
  });

  it('rejects HOTP and bounded oversized input', () => {
    const hotp = parseV2TotpInput(`otpauth://hotp/Test?secret=${RFC_SECRET}&counter=0&digits=6`);
    expect(hotp.errors[0]?.message).toBe('仅支持基于时间的 TOTP');

    const tooManyLines = parseV2TotpInput(
      Array.from({ length: V2_TOTP_INPUT_LIMITS.lines + 1 }, () => RFC_SECRET).join('\n')
    );
    expect(tooManyLines.accounts).toEqual([]);
    expect(tooManyLines.errors[0]?.message).toContain(`最多处理 ${V2_TOTP_INPUT_LIMITS.lines} 行`);
  });
});
