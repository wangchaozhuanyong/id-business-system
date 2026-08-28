import { describe, expect, it } from 'vitest';
import { generateIdBusinessV2TotpCode, parseIdBusinessV2TotpSecret } from './id-business-v2-totp';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('server-side saved TOTP', () => {
  it('matches the RFC 6238 SHA1 vector', () => {
    const configuration = parseIdBusinessV2TotpSecret(
      `otpauth://totp/RFC:test?secret=${RFC_SECRET}&algorithm=SHA1&digits=8&period=30`
    );

    expect(configuration).toEqual({
      algorithm: 'sha1',
      digits: 8,
      issuer: 'RFC',
      period: 30,
      secret: RFC_SECRET
    });
    expect(generateIdBusinessV2TotpCode(configuration, 59_000)).toEqual({
      expiresAt: new Date(60_000),
      token: '94287082'
    });
  });

  it('normalizes raw secrets without accepting weak or unsupported input', () => {
    expect(parseIdBusinessV2TotpSecret('jbsw-y3dp ehpk-3pxp')).toEqual({
      algorithm: 'sha1',
      digits: 6,
      issuer: null,
      period: 30,
      secret: 'JBSWY3DPEHPK3PXP'
    });
    expect(() => parseIdBusinessV2TotpSecret('AAAAAAAAAAAAAAAA')).toThrow('2FA 密钥内容过于简单');
    expect(() =>
      parseIdBusinessV2TotpSecret(`otpauth://hotp/Test?secret=${RFC_SECRET}&counter=0`)
    ).toThrow('仅支持基于时间的 TOTP');
    expect(() =>
      parseIdBusinessV2TotpSecret(
        `otpauth://totp/Test?secret=${RFC_SECRET}&algorithm=MD5&digits=6&period=30`
      )
    ).toThrow('仅支持 SHA1、SHA256 或 SHA512 算法');
  });
});
