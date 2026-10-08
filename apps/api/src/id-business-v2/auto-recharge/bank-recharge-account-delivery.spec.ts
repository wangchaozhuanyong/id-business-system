import { describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { BankRechargeAccountDeliveryService } from './bank-recharge-account-delivery.service';
import { ACCOUNT_COPY_SETTINGS_OWNER_ID } from './account-copy-settings';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
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
  type SettingsRow = {
    ownerId: string;
    browserOptions: Record<string, unknown>;
    updatedAt: Date;
  };
  const rows = new Map<string, SettingsRow>([
    [
      operator.id,
      {
        ownerId: operator.id,
        browserOptions: {
          ...V2_RECHARGE_BROWSER_DEFAULTS,
          serverDefaultProxyId: 'proxy-1',
          accountCopySuffix: '查询入口\n说明'
        },
        updatedAt: new Date('2026-10-01T00:00:00Z')
      }
    ]
  ]);
  const persisted = {
    findUnique: vi.fn(
      async ({ where }: { where: { ownerId: string } }) => rows.get(where.ownerId) ?? null
    ),
    findMany: vi.fn(async () =>
      [...rows.values()].sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          left.ownerId.localeCompare(right.ownerId)
      )
    ),
    upsert: vi.fn(async ({ where, create, update }) => {
      const before = rows.get(where.ownerId);
      const row: SettingsRow = {
        ...(before ? { ...before, ...update } : create),
        updatedAt: new Date('2026-10-08T00:00:00Z')
      };
      rows.set(where.ownerId, row);
      return row;
    })
  };
  const prisma = { idBusinessV2RechargeBrowserSetting: persisted };
  const repository = new RechargeSettingsRepository(prisma as never);
  const settings = {
    findAccountCopySuffix: vi.spyOn(repository, 'findAccountCopySuffix'),
    upsert: vi.spyOn(repository, 'upsert')
  };
  const encryption = { decrypt: vi.fn((value: string | null) => value?.slice(7) ?? null) };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const transactions = { execute: vi.fn(async (work) => work(prisma)) };
  const createService = (repository = new RechargeSettingsRepository(prisma as never)) =>
    new BankRechargeAccountDeliveryService(
      accounts as never,
      mailboxes as never,
      repository,
      encryption as never,
      transactions as never,
      audit as never
    );
  const service = createService(repository);
  return {
    service,
    accounts,
    account,
    mailboxes,
    settings,
    rows,
    persisted,
    createService,
    audit,
    encryption,
    clearSettings: () => {
      rows.clear();
    }
  };
}

describe('ChatGPT 账号资料交付复制', () => {
  it('按完整邮箱、密码、2FA 密钥、当前查询码和多行后缀输出，审计不含明文', async () => {
    const { service, mailboxes, audit } = fixture();
    await expect(service.copyAccount('account-1', operator)).resolves.toEqual({
      text: `${email}----${password}----${secret}----${code}\n查询入口\n说明`
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
      text: `${email}------------${code}`
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
    expect(settings.findAccountCopySuffix).not.toHaveBeenCalled();
    expect(settings.upsert).not.toHaveBeenCalled();
  });

  it('后缀单独保存为共享配置，不修改个人窗口或代理配置，不进入执行器参数', async () => {
    const { service, settings, rows, audit } = fixture();
    const personalBefore = structuredClone(rows.get(operator.id));
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '查询入口\n说明' });
    await service.updateCopySettings({ suffix: '自定义\n两行' }, operator);
    expect(settings.upsert).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_COPY_SETTINGS_OWNER_ID,
      {
        browserOptions: { accountCopySuffix: '自定义\n两行' }
      }
    );
    expect(rows.get(operator.id)).toEqual(personalBefore);
    expect(rows.get(ACCOUNT_COPY_SETTINGS_OWNER_ID)?.browserOptions).toEqual({
      accountCopySuffix: '自定义\n两行'
    });
    expect(storedBrowserOptions(rows.get(operator.id)?.browserOptions)).toEqual(
      V2_RECHARGE_BROWSER_DEFAULTS
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('自定义');
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: operator.id, objectId: ACCOUNT_COPY_SETTINGS_OWNER_ID })
    );
  });

  it('无既有配置时保存共享后缀，后缀可清空', async () => {
    const { service, clearSettings, settings } = fixture();
    clearSettings();
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '' });
    await service.updateCopySettings({ suffix: 'new' }, operator);
    expect(settings.upsert.mock.calls[0]![2].browserOptions).toEqual({ accountCopySuffix: 'new' });
    await service.updateCopySettings({ suffix: '' }, operator);
    await expect(service.copySettings(operator)).resolves.toEqual({ suffix: '' });
  });

  it('管理员 A 保存后，另一电脑的新服务实例与管理员 B 读取和单行复制使用同一后缀', async () => {
    const { service, createService } = fixture();
    const otherAdmin = { ...operator, id: 'fixture-other-admin' };
    await service.updateCopySettings({ suffix: '所有管理员共用\n查询说明' }, operator);
    const otherComputer = createService();
    await expect(otherComputer.copySettings(operator)).resolves.toEqual({
      suffix: '所有管理员共用\n查询说明'
    });
    await expect(otherComputer.copySettings(otherAdmin)).resolves.toEqual({
      suffix: '所有管理员共用\n查询说明'
    });
    await expect(otherComputer.copyAccount('account-1', otherAdmin)).resolves.toEqual({
      text: `${email}----${password}----${secret}----${code}\n所有管理员共用\n查询说明`
    });
  });

  it('共享后缀清空后，不恢复个人历史后缀，其他管理员复制时也不追加', async () => {
    const { service, createService, rows, persisted } = fixture();
    await service.updateCopySettings({ suffix: '' }, operator);
    persisted.findMany.mockClear();
    const otherComputer = createService();
    const otherAdmin = { ...operator, id: 'fixture-other-admin' };
    await expect(otherComputer.copySettings(otherAdmin)).resolves.toEqual({ suffix: '' });
    await expect(otherComputer.copyAccount('account-1', otherAdmin)).resolves.toEqual({
      text: `${email}----${password}----${secret}----${code}`
    });
    expect(persisted.findMany).not.toHaveBeenCalled();
    expect(rows.get(operator.id)?.browserOptions.accountCopySuffix).toBe('查询入口\n说明');
  });

  it('尚无共享配置时，所有管理员兼容同一最新非空历史后缀，读取不迁移或改写个人记录', async () => {
    const { service, createService, rows, settings, persisted } = fixture();
    rows.set('fixture-other-admin', {
      ownerId: 'fixture-other-admin',
      browserOptions: { accountCopySuffix: '较新的已保存后缀' },
      updatedAt: new Date('2026-10-02T00:00:00Z')
    });
    rows.set('fixture-empty-admin', {
      ownerId: 'fixture-empty-admin',
      browserOptions: { accountCopySuffix: '' },
      updatedAt: new Date('2026-10-03T00:00:00Z')
    });
    const personalBefore = structuredClone([...rows.entries()]);
    await expect(service.copySettings(operator)).resolves.toEqual({
      suffix: '较新的已保存后缀'
    });
    await expect(
      createService().copySettings({ ...operator, id: 'fixture-new-admin' })
    ).resolves.toEqual({ suffix: '较新的已保存后缀' });
    await expect(service.copyAccount('account-1', operator)).resolves.toEqual({
      text: `${email}----${password}----${secret}----${code}\n较新的已保存后缀`
    });
    expect([...rows.entries()]).toEqual(personalBefore);
    expect(settings.upsert).not.toHaveBeenCalled();
    expect(persisted.upsert).not.toHaveBeenCalled();
  });

  it('每次单行复制读取数据库最新共享后缀，不沿用此前读取的值', async () => {
    const { service, createService } = fixture();
    await service.updateCopySettings({ suffix: '原后缀' }, operator);
    const otherComputer = createService();
    await expect(otherComputer.copySettings(operator)).resolves.toEqual({ suffix: '原后缀' });
    await service.updateCopySettings({ suffix: '更新后的后缀' }, operator);
    await expect(otherComputer.copyAccount('account-1', operator)).resolves.toEqual({
      text: `${email}----${password}----${secret}----${code}\n更新后的后缀`
    });
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
