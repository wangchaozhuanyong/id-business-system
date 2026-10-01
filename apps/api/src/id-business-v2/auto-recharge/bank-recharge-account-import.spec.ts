import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';

function setup() {
  const tx = {};
  const repository = {
    createAccount: vi
      .fn()
      .mockResolvedValue({ id: 'created-id', emailMasked: 'ab***@example.com' }),
    hasAccountEmailHashes: vi.fn().mockResolvedValue(false),
    findAccount: vi.fn().mockResolvedValue(null),
    accountHasReferences: vi.fn().mockResolvedValue(false),
    deleteAccount: vi.fn().mockResolvedValue({ id: 'deleted-id' })
  };
  const transactions = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const encryption = {
    encrypt: vi.fn((value: string | null) => (value ? `encrypted:${value}` : null)),
    hash: vi.fn((value: string) => `hash:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, ''))
  };
  const mailboxes = { ensureAccountAliases: vi.fn().mockResolvedValue(undefined) };
  const service = new BankRechargeAccountService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never,
    mailboxes as never
  );
  const operator = { id: 'operator-id' } as never;
  return { service, repository, transactions, audit, operator, mailboxes };
}

describe('ChatGPT 账号批量导入和删除', () => {
  it('选定主邮箱时先确保隐藏邮箱关联，再加密保存无密码账号', async () => {
    const { service, repository, mailboxes, operator } = setup();
    await service.importAccounts(
      {
        primaryAccountId: 'primary-1',
        accounts: [{ email: 'FIRST@example.com', totpSecret: 'JBSWY3DPEHPK3PXP' }]
      },
      operator
    );
    expect(mailboxes.ensureAccountAliases).toHaveBeenCalledWith(
      'primary-1',
      ['first@example.com'],
      operator
    );
    expect(mailboxes.ensureAccountAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.createAccount.mock.invocationCallOrder[0]!
    );
    expect(repository.createAccount.mock.calls[0]?.[1].data.passwordEncrypted).toBeNull();
  });

  it('本地账号重复或资料错误时不触碰邮箱服务', async () => {
    const { service, repository, mailboxes, transactions, operator } = setup();
    repository.hasAccountEmailHashes.mockResolvedValue(true);
    await expect(
      service.importAccounts(
        { primaryAccountId: 'primary-1', accounts: [{ email: 'first@example.com' }] },
        operator
      )
    ).rejects.toThrow('已保存');
    await expect(
      service.importAccounts(
        { primaryAccountId: 'primary-1', accounts: [{ email: 'bad' }] },
        operator
      )
    ).rejects.toThrow('第 1 行');
    expect(mailboxes.ensureAccountAliases).not.toHaveBeenCalled();
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('邮箱关联失败时不入库，重试成功后才创建账号', async () => {
    const { service, repository, mailboxes, operator } = setup();
    mailboxes.ensureAccountAliases.mockRejectedValueOnce(new Error('部分隐藏邮箱未添加'));
    const input = { primaryAccountId: 'primary-1', accounts: [{ email: 'first@example.com' }] };
    await expect(service.importAccounts(input, operator)).rejects.toThrow('部分隐藏邮箱');
    expect(repository.createAccount).not.toHaveBeenCalled();
    await expect(service.importAccounts(input, operator)).resolves.toEqual({ imported: 1 });
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
  });

  it('先验证整批资料和重复邮箱，错误时不开始写事务', async () => {
    const { service, transactions } = setup();
    await expect(
      service.importAccounts(
        {
          accounts: [
            { email: 'first@example.com', password: 'pass1' },
            { email: 'invalid', password: 'pass2' }
          ]
        },
        { id: 'operator-id' } as never
      )
    ).rejects.toThrow('第 2 行');
    await expect(
      service.importAccounts(
        {
          accounts: [
            { email: 'FIRST@example.com', password: 'pass1' },
            { email: 'first@example.com', password: 'pass2' }
          ]
        },
        { id: 'operator-id' } as never
      )
    ).rejects.toThrow('重复邮箱');
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('在一个事务里逐条加密创建并写不含明文的审计', async () => {
    const { service, repository, transactions, audit, operator } = setup();
    const result = await service.importAccounts(
      {
        accounts: [
          { email: 'first@example.com', password: 'pass1', remark: '第一条' },
          { email: 'second@example.com', password: 'pass2', totpSecret: 'JBSWY3DPEHPK3PXP' }
        ]
      },
      operator
    );
    expect(result).toEqual({ imported: 2 });
    expect(transactions.execute).toHaveBeenCalledTimes(1);
    expect(repository.createAccount).toHaveBeenCalledTimes(2);
    expect(repository.createAccount.mock.calls[0]?.[1].data.passwordEncrypted).toBe(
      'encrypted:pass1'
    );
    expect(audit.append).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('pass1');
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('允许省略或留空密码，邮箱和 2FA 正常加密保存', async () => {
    const { service, repository, audit, operator } = setup();
    await expect(
      service.importAccounts(
        {
          accounts: [
            { email: 'first@example.com', totpSecret: 'JBSWY3DPEHPK3PXP' },
            { email: 'second@example.com', password: '', totpSecret: 'JBSWY3DPEHPK3PXP' },
            { email: 'third@example.com' }
          ]
        },
        operator
      )
    ).resolves.toEqual({ imported: 3 });
    for (const call of repository.createAccount.mock.calls) {
      expect(call[1].data.passwordEncrypted).toBeNull();
    }
    expect(repository.createAccount.mock.calls[0]?.[1].data.totpSecretEncrypted).toBe(
      'encrypted:JBSWY3DPEHPK3PXP'
    );
    expect(repository.createAccount.mock.calls[2]?.[1].data.totpSecretEncrypted).toBeNull();
    expect(audit.append.mock.calls[0]?.[1].afterData).toMatchObject({
      hasPassword: false,
      hasTotp: true
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('单条新增同样允许没有密码的账号', async () => {
    const { service, repository, operator } = setup();
    await expect(
      service.createAccount(
        { email: 'first@example.com', totpSecret: 'JBSWY3DPEHPK3PXP' },
        operator
      )
    ).resolves.toMatchObject({ id: 'created-id' });
    expect(repository.createAccount.mock.calls[0]?.[1].data.passwordEncrypted).toBeNull();
  });

  it('无密码账号仍可生成 2FA 验证码，密码登录保留缺失提示', async () => {
    const { service, repository, audit, operator } = setup();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    repository.findAccount.mockResolvedValue({
      id,
      status: 'active',
      passwordEncrypted: null,
      totpSecretEncrypted: 'encrypted:JBSWY3DPEHPK3PXP',
      totpAlgorithm: 'sha1',
      totpDigits: 6,
      totpPeriod: 30
    });
    const code = await service.totpCode(id, operator);
    expect(code.token).toMatch(/^\d{6}$/);
    expect(code.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(code.token);
    await expect(service.launchCredential(id, operator)).rejects.toThrow('尚未保存登录密码');
  });

  it.each([null, 123, 'bad\npassword', 'x'.repeat(1025)])(
    '仍拒绝已提供但无效的密码（%#）',
    async (password) => {
      const { service, transactions, operator } = setup();
      await expect(
        service.importAccounts({ accounts: [{ email: 'first@example.com', password }] }, operator)
      ).rejects.toThrow('第 1 行');
      expect(transactions.execute).not.toHaveBeenCalled();
    }
  );

  it('没有密码也不会跳过 2FA 校验，整批错误不写入', async () => {
    const { service, transactions, operator } = setup();
    await expect(
      service.importAccounts(
        { accounts: [{ email: 'first@example.com', totpSecret: 'invalid-secret!' }] },
        operator
      )
    ).rejects.toThrow('第 1 行');
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('拒绝删除有关联的账号，并审计删除未关联账号', async () => {
    const { service, repository, audit, operator } = setup();
    const id = '123e4567-e89b-42d3-a456-426614174000';
    repository.findAccount.mockResolvedValue({
      id,
      emailMasked: 'ab***@example.com',
      status: 'active'
    });
    repository.accountHasReferences.mockResolvedValueOnce(true);
    await expect(service.deleteAccount(id, operator)).rejects.toThrow('请改为停用');
    expect(repository.deleteAccount).not.toHaveBeenCalled();
    await expect(service.deleteAccount(id, operator)).resolves.toEqual({ id });
    expect(repository.deleteAccount).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.chatgpt_account.delete',
        objectId: id
      })
    );
  });
});
