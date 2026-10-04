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
  it.each([
    { subject: 'Your ChatGPT code', bodyText: 'Your ChatGPT code is 012345' },
    { subject: '你的临时 ChatGPT 登录代码', bodyText: '登录代码是 012345' },
    { subject: 'Your verification code', bodyText: 'Your verification code is 012345.' },
    { subject: '验证码 012345', bodyText: '' }
  ])('自动取码从明确文案恢复旧的文字提取值 %j', (content) => {
    expect(
      registrationMail(
        [{ ...mail, ...content, extractedCode: 'ChatGPT' }],
        mail.targetEmail!,
        since,
        null
      )
    ).toEqual({ mailId: mail.id, code: '012345' });
  });
  it('使用对应邮箱的完整 iCloud 官方转发编码', () => {
    expect(
      registrationMail(
        [{ ...mail, fromAddress: 'noreply_at_tm1_openai_com_abc123@icloud.com' }],
        mail.targetEmail!,
        since,
        null
      )
    ).toEqual({ mailId: mail.id, code: '123456' });
  });
  it.each([
    'noreply_at_fakeopenai_com_abc123@icloud.com',
    'noreply_at_openai_com_abc123@evil.test',
    'openai@icloud.com',
    'a@openai.com@evil.test'
  ])('拒绝不完整或伪造的转发来源 %s', (fromAddress) => {
    expect(registrationMail([{ ...mail, fromAddress }], mail.targetEmail!, since, null)).toBeNull();
  });
  it.each([
    '123456789',
    '123456AB',
    '123456@example.test',
    '123456-789',
    '123456 789',
    '123456\n789',
    '123456 - 789',
    '1234 5678'
  ])('自动读码不会截取不完整值 %s', (code) => {
    expect(
      registrationMail(
        [{ ...mail, extractedCode: 'ChatGPT', bodyText: `Your verification code is ${code}` }],
        mail.targetEmail!,
        since,
        null
      )
    ).toBeNull();
  });
  it('同封邮件多个不同验证码时不猜测', () => {
    expect(
      registrationMail(
        [
          {
            ...mail,
            extractedCode: 'ChatGPT',
            bodyText: 'Your verification code is 123456. Your security code is 654321.'
          }
        ],
        mail.targetEmail!,
        since,
        null
      )
    ).toBeNull();
  });
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
  it('恢复同一验证码步骤时不会退回已接收邮件之前的旧码', () => {
    const older = {
      ...mail,
      id: 'mail-old',
      receivedAt: new Date(Date.now() - 30_000).toISOString()
    };
    expect(registrationMail([older, mail], mail.targetEmail!, since, mail.id)).toBeNull();
    const newer = {
      ...mail,
      id: 'mail-next',
      receivedAt: new Date(Date.now() + 1000).toISOString(),
      extractedCode: '654321'
    };
    expect(registrationMail([older, mail, newer], mail.targetEmail!, since, mail.id)).toEqual({
      mailId: newer.id,
      code: '654321'
    });
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
