import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';
import { IdBusinessV2RechargeMailboxService } from './recharge-mail-code.service';

const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
function fixture() {
  const alias = {
    id: 'alias-fixture',
    aliasEmail: 'owner@example.invalid',
    primaryAccountId: 'primary-fixture',
    status: 'ACTIVE',
    buyerQueryCode: 'synthetic-private-query',
    codeExpiresAt: null
  };
  const mail = {
    id: 'mail-fixture',
    targetEmail: alias.aliasEmail,
    fromAddress: 'noreply@tm.openai.com',
    subject: 'Your verification code',
    extractedCode: '123456',
    receivedAt: new Date().toISOString(),
    bodyText: ''
  };
  const client = {
    virtualEmails: vi.fn(async () => [alias]),
    primaryAccounts: vi.fn(async () => [{ id: 'primary-fixture', status: 'ACTIVE' }]),
    publicQuery: vi.fn(async () => ({ success: true, items: [mail] })),
    createAlias: vi.fn(),
    batchCreateAliases: vi.fn(),
    createPrimary: vi.fn()
  };
  const existing = new IdBusinessV2VendureMailboxService(client as never, {} as never, {} as never);
  const service = new IdBusinessV2RechargeMailboxService(client as never, existing);
  return { service, alias, mail, client };
}

describe('充值复用现有邮箱授权', () => {
  it('只精确匹配已有唯一授权邮箱，不创建任何邮箱或别名，也不返回查询码', async () => {
    const f = fixture();
    expect(await f.service.rechargeMailbox('OWNER@example.invalid', operator)).toEqual({
      aliasId: 'alias-fixture',
      email: 'owner@example.invalid'
    });
    f.client.virtualEmails.mockResolvedValueOnce([]);
    await expect(f.service.rechargeMailbox('owner@example.invalid', operator)).rejects.toThrow(
      '关联缺失'
    );
    f.client.virtualEmails.mockResolvedValueOnce([f.alias, { ...f.alias, id: 'duplicate' }]);
    await expect(f.service.rechargeMailbox('owner@example.invalid', operator)).rejects.toThrow(
      '不唯一'
    );
    expect(f.client.createAlias).not.toHaveBeenCalled();
    expect(f.client.batchCreateAliases).not.toHaveBeenCalled();
    expect(f.client.createPrimary).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'DISABLED' },
    { buyerQueryCode: '' },
    { codeExpiresAt: 'invalid' },
    { codeExpiresAt: '2000-01-01T00:00:00Z' }
  ])('邮箱授权不可用拒绝 %j', async (patch) => {
    const f = fixture();
    Object.assign(f.alias, patch);
    await expect(f.service.rechargeMailbox('owner@example.invalid', operator)).rejects.toThrow(
      '已失效'
    );
    expect(f.client.publicQuery).not.toHaveBeenCalled();
  });

  it('主邮箱不可用、非管理员和目标邮箱换绑时不读邮件', async () => {
    const f = fixture();
    f.client.primaryAccounts.mockResolvedValueOnce([{ id: 'primary-fixture', status: 'DISABLED' }]);
    await expect(f.service.rechargeMailbox('owner@example.invalid', operator)).rejects.toThrow(
      '主邮箱'
    );
    await expect(
      f.service.rechargeMailbox('owner@example.invalid', { ...operator, roles: ['staff'] })
    ).rejects.toThrow();
    f.alias.aliasEmail = 'changed@example.invalid';
    await expect(
      f.service.rechargeCode('alias-fixture', 'owner@example.invalid', new Date(0), null, operator)
    ).rejects.toThrow('地址已变化');
    expect(f.client.publicQuery).not.toHaveBeenCalled();
  });

  it.each([
    { targetEmail: 'other@example.invalid' },
    { fromAddress: 'x@fakeopenai.com' },
    { fromAddress: 'x@openai.com.evil.invalid' },
    { receivedAt: '2000-01-01T00:00:00Z' },
    { receivedAt: new Date(Date.now() + 120_000).toISOString() },
    { subject: 'Discount sale' },
    { extractedCode: null, bodyText: 'https://auth.openai.com/email-verification?token=synthetic' }
  ])('只接受指定邮箱请求后官方数字验证码 %j', async (patch) => {
    const f = fixture();
    Object.assign(f.mail, patch);
    expect(
      await f.service.rechargeCode(
        'alias-fixture',
        'owner@example.invalid',
        new Date(Date.now() - 1000),
        null,
        operator
      )
    ).toBeNull();
  });

  it('排除已确认邮件，同时保留注册邮件过滤规则', async () => {
    const f = fixture();
    expect(
      await f.service.rechargeCode(
        'alias-fixture',
        'owner@example.invalid',
        new Date(Date.now() - 1000),
        null,
        operator
      )
    ).toEqual({
      mailId: 'mail-fixture',
      code: '123456'
    });
    expect(
      await f.service.rechargeCode(
        'alias-fixture',
        'owner@example.invalid',
        new Date(0),
        'mail-fixture',
        operator
      )
    ).toBeNull();
  });
});
