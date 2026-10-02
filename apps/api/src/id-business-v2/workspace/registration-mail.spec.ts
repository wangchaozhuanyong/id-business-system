import { describe, expect, it } from 'vitest';
import type { V2VendureMailboxPublicMail } from '@apple-business/shared';
import { registrationMail } from './registration-mail';
const since = new Date(Date.now() - 60_000);
const mail = {
  id: 'mail-new',
  fromAddress: 'noreply@tm.openai.com',
  targetEmail: 'owner@example.test',
  subject: 'Your verification code',
  receivedAt: new Date().toISOString(),
  extractedCode: '123456',
  bodyText: ''
} as V2VendureMailboxPublicMail;
describe('注册邮件不串码', () => {
  it('只取当前邮箱的新官方邮件', () => {
    expect(registrationMail([mail], 'owner@example.test', since, null)).toEqual({
      mailId: mail.id,
      code: '123456'
    });
  });
  it.each([
    { targetEmail: 'other@example.test' },
    { fromAddress: 'x@openai.com.evil.test' },
    { fromAddress: 'x@fakeopenai.com' },
    { receivedAt: '2020-01-01T00:00:00Z' },
    { receivedAt: new Date(Date.now() + 120_000).toISOString() },
    { subject: 'Sale discount' },
    { extractedCode: 'unexpected' }
  ])('拒绝不匹配邮件 %j', (patch) => {
    expect(registrationMail([{ ...mail, ...patch }], mail.targetEmail!, since, null)).toBeNull();
  });
  it('不重复使用已确认接收的邮件', () => {
    expect(registrationMail([mail], mail.targetEmail!, since, mail.id)).toBeNull();
  });
  it('仅允许官方 HTTPS 验证链接，不接受跳转目标、凭据或非标准端口', () => {
    for (const link of [
      'https://evil.test/verify',
      'http://auth.openai.com/verify',
      'https://a@auth.openai.com/verify',
      'https://auth.openai.com:444/verify'
    ]) {
      expect(
        registrationMail(
          [{ ...mail, extractedCode: null, bodyText: link }],
          mail.targetEmail!,
          since,
          null
        )
      ).toBeNull();
    }
    expect(
      registrationMail(
        [
          {
            ...mail,
            extractedCode: null,
            bodyText: 'https://auth.openai.com/verify?code=synthetic'
          }
        ],
        mail.targetEmail!,
        since,
        null
      )?.mailId
    ).toBe(mail.id);
  });
});
