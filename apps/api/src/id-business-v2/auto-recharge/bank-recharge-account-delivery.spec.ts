import { describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { BankRechargeAccountDeliveryService } from './bank-recharge-account-delivery.service';
import { storedBrowserOptions } from './recharge-browser-options';

const operator = {
  id: 'fixture-admin',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const email = 'hidden@example.invalid';
const password = 'synthetic-password';
const secret = 'JBSWY3DPEHPK3PXP';
const code = 'BUY-TEST-CODE';
function fixture() {
  const account = {
    emailEncrypted: `cipher:${email}`,
    passwordEncrypted: `cipher:${password}`,
    totpSecretEncrypted: `cipher:${secret}`
  };
  const accounts = {
    accountIdentity: vi.fn().mockResolvedValue({ email }),
    requireActive: vi.fn().mockResolvedValue(account)
  };
  const mailboxes = {
    accountBuyerCode: vi.fn().mockResolvedValue({ aliasId: 'alias-1', buyerQueryCode: code })
  };
  let row: { browserOptions: Record<string, unknown> } | null = {
    browserOptions: {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      serverDefaultProxyId: 'proxy-1',
      accountCopySuffix: '查询入口\n说明'
    }
  };
  const settings = {
    find: vi.fn(async () => row),
    findInTransaction: vi.fn(async () => row),
    upsert: vi.fn(async (_tx, _id, data) => {
      row = data;
    })
  };
  const encryption = { decrypt: vi.fn((value: string | null) => value?.slice(7) ?? null) };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const service = new BankRechargeAccountDeliveryService(
    accounts as never,
    mailboxes as never,
    settings as never,
    encryption as never,
    transactions as never,
    audit as never
  );
  return {
    service,
    accounts,
    account,
    mailboxes,
    settings,
    audit,
    encryption,
    clearSettings: () => {
      row = null;
    }
  };
}

describe('ChatGPT 账号资料交付复制', () => {
  it('按完整邮箱、密码、2FA 密钥、当前查询码和多行后缀输出，审计不含明文', async () => {
    const { service, mailboxes, audit } = fixture();
    await expect(service.copyAccount('account-1', operator)).resolves.toEqual({
      text: `${email}-${password}-${secret}-${code}\n查询入口\n说明`
    });
    expect(mailboxes.accountBuyerCode).toHaveBeenCalledWith(email, operator);
    const log = JSON.stringify(audit.append.mock.calls);
    for (const value of [email, password, secret, code, '查询入口'])
      expect(log).not.toContain(value);
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.chatgpt_account.copy',
        afterData: { aliasId: 'alias-1', hasPassword: true, hasTotp: true }
      })
    );
  });

  it('未设置密码及 2FA 时保留空字段，空后缀不追加换行', async () => {
    const { service, account } = fixture();
    account.passwordEncrypted = null as never;
    account.totpSecretEncrypted = null as never;
    await service.updateCopySettings({ suffix: '' }, operator);
    await expect(service.copyAccount('account-1', operator)).resolves.toEqual({
      text: `${email}---${code}`
    });
  });

  it('查询码失效、账号停用、邮箱变化或审计失败时不交付明文', async () => {
    const { service, account, accounts, mailboxes, audit, encryption } = fixture();
    mailboxes.accountBuyerCode.mockRejectedValueOnce(new Error('查询码已失效'));
    await expect(service.copyAccount('account-1', operator)).rejects.toThrow('已失效');
    expect(encryption.decrypt).not.toHaveBeenCalled();
    accounts.requireActive.mockRejectedValueOnce(new Error('账号已停用'));
    await expect(service.copyAccount('account-1', operator)).rejects.toThrow('已停用');
    account.emailEncrypted = 'cipher:changed@example.invalid';
    await expect(service.copyAccount('account-1', operator)).rejects.toThrow('邮箱已变更');
    account.emailEncrypted = `cipher:${email}`;
    audit.append.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.copyAccount('account-1', operator)).rejects.toThrow('audit unavailable');
    expect(encryption.decrypt).not.toHaveBeenCalledWith(account.passwordEncrypted);
    expect(encryption.decrypt).not.toHaveBeenCalledWith(account.totpSecretEncrypted);
  });

  it('非管理员不能复制或设置，拒绝前不读取账号及邮箱服务', async () => {
    const { service, accounts, mailboxes, settings } = fixture();
    const staff = { ...operator, roles: ['staff'] };
    await expect(service.copyAccount('account-1', staff)).rejects.toThrow('仅管理员');
    await expect(service.copySettings(staff)).rejects.toThrow('仅管理员');
    await expect(service.updateCopySettings({ suffix: 'x' }, staff)).rejects.toThrow('仅管理员');
    expect(accounts.accountIdentity).not.toHaveBeenCalled();
    expect(mailboxes.accountBuyerCode).not.toHaveBeenCalled();
    expect(settings.find).not.toHaveBeenCalled();
    expect(settings.upsert).not.toHaveBeenCalled();
  });

  it('后缀按当前管理员保存，保留窗口及代理配置，不进入执行器参数', async () => {
    const { service, settings, audit } = fixture();
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '查询入口\n说明' });
    await service.updateCopySettings({ suffix: '自定义\n两行' }, operator);
    expect(settings.upsert).toHaveBeenCalledWith(expect.anything(), operator.id, {
      browserOptions: {
        ...V2_RECHARGE_BROWSER_DEFAULTS,
        serverDefaultProxyId: 'proxy-1',
        accountCopySuffix: '自定义\n两行'
      }
    });
    const saved = settings.upsert.mock.calls[0]![2].browserOptions;
    expect(storedBrowserOptions(saved)).toEqual(V2_RECHARGE_BROWSER_DEFAULTS);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('自定义');
  });

  it('无既有配置时同时补齐原窗口默认值，后缀可清空', async () => {
    const { service, clearSettings, settings } = fixture();
    clearSettings();
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '' });
    await service.updateCopySettings({ suffix: 'new' }, operator);
    expect(storedBrowserOptions(settings.upsert.mock.calls[0]![2].browserOptions)).toEqual(
      V2_RECHARGE_BROWSER_DEFAULTS
    );
    await service.updateCopySettings({ suffix: '' }, operator);
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '' });
  });

  it.each([
    { suffix: 'x'.repeat(5001) },
    { suffix: 123 },
    { suffix: 'bad\u0000suffix' },
    { suffix: 'x', unknown: true },
    {}
  ])('无效后缀不保存（%#）', async (input) => {
    const { service, settings } = fixture();
    await expect(service.updateCopySettings(input, operator)).rejects.toThrow('复制后缀格式无效');
    expect(settings.upsert).not.toHaveBeenCalled();
  });
});
