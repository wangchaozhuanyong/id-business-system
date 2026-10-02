import { describe, expect, it, vi } from 'vitest';
import { RegistrationMailboxesService } from './registration-mailboxes.service';

function fixture() {
  const repository = {
    accountsByEmailHashes: vi.fn().mockResolvedValue([]),
    lock: vi.fn().mockResolvedValue(undefined),
    account: vi.fn().mockResolvedValue(null),
    activeEmail: vi.fn().mockResolvedValue(null),
    createManualAccount: vi
      .fn()
      .mockResolvedValue({ id: 'account-1', emailMasked: 'hi***@example.invalid' })
  };
  const mailboxes = {
    listAliases: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    aliasAddress: vi
      .fn()
      .mockResolvedValue({ email: 'hidden@example.invalid', updatedAt: '2026-10-02T12:00:00Z' })
  };
  const tx = {};
  const transactions = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const encryption = {
    hash: vi.fn((value: string) => `hash:${value}`),
    encrypt: vi.fn((value: string) => `encrypted:${value}`)
  };
  const operator = { id: 'operator-1', roles: ['admin'] } as never;
  const service = new RegistrationMailboxesService(
    repository as never,
    mailboxes as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  return { repository, mailboxes, transactions, audit, operator, service, tx };
}

const version = { expectedUpdatedAt: '2026-10-02T12:00:00Z' };

describe('隐藏邮箱注册资料', () => {
  it('过期邮箱版本、缺失版本或客户端另指定邮箱时不写入', async () => {
    const { service, mailboxes, transactions, operator } = fixture();
    await expect(
      service.markRegistered('alias-1', { expectedUpdatedAt: '2026-10-01T12:00:00Z' }, operator)
    ).rejects.toThrow('资料已变化');
    await expect(service.markRegistered('alias-1', {}, operator)).rejects.toThrow('资料版本');
    await expect(
      service.markRegistered('alias-1', { ...version, email: 'other@example.invalid' }, operator)
    ).rejects.toThrow('未知字段');
    expect(transactions.execute).not.toHaveBeenCalled();
    expect(mailboxes.aliasAddress).toHaveBeenCalledTimes(1);
  });
  it('按邮箱来源分页，启用与停用均显示，已有账号回显已注册且不泄露查询码', async () => {
    const { service, mailboxes, repository, operator } = fixture();
    const row = {
      id: 'alias-1',
      aliasEmail: 'HIDDEN@example.invalid',
      primaryAccountEmail: 'primary@example.invalid',
      status: 'DISABLED',
      note: '普通备注',
      updatedAt: '2026-10-02T12:00:00Z',
      buyerQueryCode: 'synthetic-private-code'
    };
    mailboxes.listAliases.mockResolvedValue({ items: [row], total: 21 });
    repository.accountsByEmailHashes.mockResolvedValue([
      { emailHash: 'hash:hidden@example.invalid', id: 'existing-account' }
    ]);
    const result = await service.list({ page: '2', pageSize: '20', keyword: 'hidden' }, operator);
    expect(mailboxes.listAliases).toHaveBeenCalledWith(
      { page: 2, pageSize: 20, q: 'hidden' },
      operator
    );
    expect(result).toEqual({
      items: [
        {
          id: 'alias-1',
          email: row.aliasEmail,
          primaryEmail: row.primaryAccountEmail,
          status: 'DISABLED',
          registered: true,
          accountId: 'existing-account',
          note: '普通备注',
          updatedAt: row.updatedAt
        }
      ],
      total: 21,
      page: 2,
      pageSize: 20
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-private-code');
  });

  it('空列表不伪造邮箱，读取失败保留错误', async () => {
    const { service, mailboxes, repository, operator } = fixture();
    await expect(service.list({}, operator)).resolves.toMatchObject({ items: [], total: 0 });
    expect(repository.accountsByEmailHashes).not.toHaveBeenCalled();
    mailboxes.listAliases.mockRejectedValueOnce(new Error('邮箱服务不可用'));
    await expect(service.list({}, operator)).rejects.toThrow('邮箱服务不可用');
  });

  it('标记时从源邮箱获取地址，事务内加密建账号与脱敏审计，不虚构密码或双重验证', async () => {
    const { service, repository, mailboxes, transactions, audit, operator, tx } = fixture();
    await expect(service.markRegistered('alias-1', version, operator)).resolves.toEqual({
      accountId: 'account-1',
      created: true
    });
    expect(mailboxes.aliasAddress).toHaveBeenCalledWith('alias-1', operator);
    expect(repository.createManualAccount).toHaveBeenCalledWith(tx, {
      emailHash: 'hash:hidden@example.invalid',
      emailEncrypted: 'encrypted:hidden@example.invalid',
      emailMasked: 'hi***@example.invalid',
      createdByUserId: 'operator-1',
      updatedByUserId: 'operator-1'
    });
    expect(repository.lock.mock.invocationCallOrder[0]).toBeLessThan(
      repository.account.mock.invocationCallOrder[0]!
    );
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        objectId: 'account-1',
        action: 'id_business_v2.auto_registration.mark_registered'
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('hidden@example.invalid');
    expect(transactions.execute).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ changedScopes: ['auto-recharge'], retryMode: 'none' })
    );
  });

  it('重复标记复用已有账号，不覆盖其停用状态、密码、安全资料或备注', async () => {
    const { service, repository, operator } = fixture();
    const existing = {
      id: 'existing-account',
      emailMasked: 'hi***@example.invalid',
      status: 'disabled',
      passwordEncrypted: 'existing-encrypted',
      remark: '原备注'
    };
    repository.account.mockResolvedValue(existing);
    await expect(service.markRegistered('alias-1', version, operator)).resolves.toEqual({
      accountId: 'existing-account',
      created: false
    });
    expect(repository.createManualAccount).not.toHaveBeenCalled();
    expect(existing).toMatchObject({
      status: 'disabled',
      passwordEncrypted: 'existing-encrypted',
      remark: '原备注'
    });
  });

  it('未结束的执行任务阻止人工建账号，取消或授权过期后可重试', async () => {
    const { service, repository, audit, operator } = fixture();
    repository.activeEmail.mockResolvedValueOnce({ id: 'active-job' });
    await expect(service.markRegistered('alias-1', version, operator)).rejects.toThrow(
      '注册任务正在执行'
    );
    expect(repository.createManualAccount).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
    await expect(service.markRegistered('alias-1', version, operator)).resolves.toMatchObject({
      created: true
    });
  });

  it('邮箱已移除或管理员权限不足时不开始写入', async () => {
    const { service, mailboxes, repository, transactions, operator } = fixture();
    mailboxes.aliasAddress
      .mockRejectedValueOnce(new Error('隐藏邮箱已移除'))
      .mockRejectedValueOnce(new Error('仅管理员可管理邮箱'));
    await expect(service.markRegistered('removed', version, operator)).rejects.toThrow(
      '隐藏邮箱已移除'
    );
    await expect(
      service.markRegistered('alias-1', version, { id: 'employee' } as never)
    ).rejects.toThrow('仅管理员');
    expect(transactions.execute).not.toHaveBeenCalled();
    expect(repository.createManualAccount).not.toHaveBeenCalled();
  });

  it('账号保存失败不声称已注册，失败可重试', async () => {
    const { service, repository, audit, operator } = fixture();
    repository.createManualAccount.mockRejectedValueOnce(new Error('保存失败'));
    await expect(service.markRegistered('alias-1', version, operator)).rejects.toThrow('保存失败');
    expect(audit.append).not.toHaveBeenCalled();
    await expect(service.markRegistered('alias-1', version, operator)).resolves.toMatchObject({
      created: true
    });
  });
});
