import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';

function setup() {
  const tx = {};
  const repository = {
    createAccount: vi
      .fn()
      .mockResolvedValue({ id: 'created-id', emailMasked: 'ab***@example.com' }),
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
    hash: vi.fn((value: string) => `hash:${value}`)
  };
  const service = new BankRechargeAccountService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  const operator = { id: 'operator-id' } as never;
  return { service, repository, transactions, audit, operator };
}

describe('ChatGPT 账号批量导入和删除', () => {
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
