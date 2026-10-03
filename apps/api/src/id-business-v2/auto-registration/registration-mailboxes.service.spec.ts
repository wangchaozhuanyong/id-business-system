import { describe, expect, it, vi } from 'vitest';
import { RegistrationMailboxesService } from './registration-mailboxes.service';

function fixture() {
  const repository = {
    accountsByEmailHashes: vi.fn().mockResolvedValue([]),
    unfinishedJobsByEmailHashes: vi.fn().mockResolvedValue([]),
    lock: vi.fn().mockResolvedValue(undefined),
    account: vi.fn().mockResolvedValue(null),
    pendingEmail: vi.fn().mockResolvedValue(null),
    setAccountRegistered: vi.fn().mockResolvedValue({
      id: 'account-1',
      emailMasked: 'hi***@example.invalid',
      registered: false,
      updatedAt: new Date('2026-10-03T08:00:00Z')
    }),
    createManualAccount: vi.fn().mockResolvedValue({
      id: 'account-1',
      emailMasked: 'hi***@example.invalid',
      registered: true,
      updatedAt: new Date('2026-10-02T12:00:00Z')
    })
  };
  const mailboxes = {
    registrationMailboxSummaries: vi.fn().mockResolvedValue([]),
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
  it('启用与停用邮箱均显示，已有账号回显已注册且不泄露查询码', async () => {
    const { service, mailboxes, repository, operator } = fixture();
    const row = {
      id: 'alias-1',
      email: 'HIDDEN@example.invalid',
      primaryEmail: 'primary@example.invalid',
      status: 'DISABLED',
      note: '普通备注',
      updatedAt: '2026-10-02T12:00:00Z',
      authorizationValid: false,
      primaryAvailable: true
    };
    mailboxes.registrationMailboxSummaries.mockResolvedValue([row]);
    repository.accountsByEmailHashes.mockResolvedValue([
      {
        emailHash: 'hash:hidden@example.invalid',
        id: 'existing-account',
        registered: true,
        updatedAt: new Date(row.updatedAt)
      }
    ]);
    const result = await service.list({ page: '1', pageSize: '20', keyword: 'hidden' }, operator);
    expect(mailboxes.registrationMailboxSummaries).toHaveBeenCalledWith(operator);
    expect(result).toEqual({
      items: [
        {
          id: 'alias-1',
          email: row.email,
          primaryEmail: row.primaryEmail,
          status: 'DISABLED',
          registered: true,
          accountId: 'existing-account',
          accountUpdatedAt: row.updatedAt.replace('Z', '.000Z'),
          canStart: false,
          startBlockedReason: 'registered',
          pendingJobId: null,
          note: '普通备注',
          updatedAt: row.updatedAt
        }
      ],
      total: 1,
      page: 1,
      pageSize: 20
    });
    expect(JSON.stringify(result)).not.toContain('authorizationValid');
  });

  it('空列表不伪造邮箱，读取失败保留错误', async () => {
    const { service, mailboxes, repository, operator } = fixture();
    await expect(service.list({}, operator)).resolves.toMatchObject({ items: [], total: 0 });
    expect(repository.accountsByEmailHashes).not.toHaveBeenCalled();
    mailboxes.registrationMailboxSummaries.mockRejectedValueOnce(new Error('邮箱服务不可用'));
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
      remark: '原备注',
      registered: true,
      updatedAt: new Date('2026-10-02T12:00:00Z')
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

  it('未结束的注册任务阻止人工建账号，确认结束后可重试', async () => {
    const { service, repository, audit, operator } = fixture();
    repository.pendingEmail.mockResolvedValueOnce({ id: 'active-job' });
    await expect(service.markRegistered('alias-1', version, operator)).rejects.toThrow(
      '未结束注册任务'
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

  it.each([false, true])(
    '独立状态可切换为 %s，已有账号不重建、不修改登录资料',
    async (registered) => {
      const { service, repository, audit, operator, tx } = fixture();
      const before = {
        id: 'account-1',
        emailMasked: 'hi***@example.invalid',
        registered: !registered,
        updatedAt: new Date(version.expectedUpdatedAt),
        passwordEncrypted: 'original-encrypted',
        totpSecretEncrypted: 'original-totp',
        remark: '保留资料',
        status: 'disabled'
      };
      repository.account.mockResolvedValue(before);
      repository.setAccountRegistered.mockResolvedValue({
        ...before,
        registered,
        updatedAt: new Date('2026-10-03T08:00:00Z')
      });
      await expect(
        service.markRegistered(
          'alias-1',
          { ...version, registered, expectedAccountUpdatedAt: version.expectedUpdatedAt },
          operator
        )
      ).resolves.toMatchObject({ accountId: before.id, created: false, registered });
      expect(repository.setAccountRegistered).toHaveBeenCalledWith(
        tx,
        before.id,
        before.updatedAt,
        registered,
        'operator-1'
      );
      expect(repository.createManualAccount).not.toHaveBeenCalled();
      expect(before).toMatchObject({
        passwordEncrypted: 'original-encrypted',
        totpSecretEncrypted: 'original-totp',
        remark: '保留资料',
        status: 'disabled'
      });
      expect(audit.append).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          beforeData: { registered: !registered },
          afterData: expect.objectContaining({ registered, created: false }),
          action: `id_business_v2.auto_registration.${registered ? 'mark_registered' : 'mark_unregistered'}`
        })
      );
    }
  );

  it('读取保留账号的独立未注册状态，账号存在不会再强制已注册', async () => {
    const { service, repository, mailboxes, operator } = fixture();
    mailboxes.registrationMailboxSummaries.mockResolvedValue([
      {
        id: 'alias-1',
        email: 'hidden@example.invalid',
        primaryEmail: null,
        status: 'ACTIVE',
        note: null,
        updatedAt: version.expectedUpdatedAt,
        authorizationValid: true,
        primaryAvailable: true
      }
    ]);
    repository.accountsByEmailHashes.mockResolvedValue([
      {
        id: 'account-1',
        emailHash: 'hash:hidden@example.invalid',
        registered: false,
        updatedAt: new Date(version.expectedUpdatedAt)
      }
    ]);
    expect((await service.list({}, operator)).items[0]).toMatchObject({
      registered: false,
      accountId: 'account-1',
      accountUpdatedAt: '2026-10-02T12:00:00.000Z'
    });
  });

  it('注册状态必须明确为布尔值并携带有效账号版本', async () => {
    const { service, transactions, operator } = fixture();
    for (const extra of [
      { registered: 'false', expectedAccountUpdatedAt: null },
      { registered: false },
      { registered: false, expectedAccountUpdatedAt: 'bad-date' },
      { registered: false, expectedAccountUpdatedAt: 42 }
    ])
      await expect(
        service.markRegistered('alias-1', { ...version, ...extra }, operator)
      ).rejects.toThrow();
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('旧账号版本、账号刚创建以及旧客户端都不能覆盖人工修正', async () => {
    const { service, repository, audit, operator } = fixture();
    repository.account.mockResolvedValue({
      id: 'account-1',
      registered: false,
      updatedAt: new Date('2026-10-03T08:00:00Z')
    });
    for (const expectedAccountUpdatedAt of [version.expectedUpdatedAt, null])
      await expect(
        service.markRegistered(
          'alias-1',
          { ...version, registered: true, expectedAccountUpdatedAt },
          operator
        )
      ).rejects.toThrow('资料已变化');
    await expect(service.markRegistered('alias-1', version, operator)).rejects.toThrow(
      '状态已修改'
    );
    expect(repository.setAccountRegistered).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('同邮箱任务执行中不能改回未注册，原资料和审计均不写入', async () => {
    const { service, repository, audit, operator } = fixture();
    repository.account.mockResolvedValue({
      id: 'account-1',
      registered: true,
      updatedAt: new Date(version.expectedUpdatedAt)
    });
    repository.pendingEmail.mockResolvedValue({ id: 'active-job' });
    await expect(
      service.markRegistered(
        'alias-1',
        { ...version, registered: false, expectedAccountUpdatedAt: version.expectedUpdatedAt },
        operator
      )
    ).rejects.toThrow('结束或取消');
    expect(repository.setAccountRegistered).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'awaiting_email', 'awaiting_user', 'partial'])(
    '同邮箱 %s 任务授权过期仍阻止人工修正，须先确认结束或取消',
    async (state) => {
      const { service, repository, audit, operator, tx } = fixture();
      repository.account.mockResolvedValue({
        id: 'account-1',
        registered: true,
        updatedAt: new Date(version.expectedUpdatedAt)
      });
      repository.pendingEmail.mockResolvedValue({
        id: 'expired-job',
        state,
        leaseUntil: new Date(0)
      });
      await expect(
        service.markRegistered(
          'alias-1',
          {
            ...version,
            registered: false,
            expectedAccountUpdatedAt: version.expectedUpdatedAt
          },
          operator
        )
      ).rejects.toThrow('先结束或取消');
      expect(repository.pendingEmail).toHaveBeenCalledWith(tx, 'hash:hidden@example.invalid');
      expect(repository.setAccountRegistered).not.toHaveBeenCalled();
      expect(audit.append).not.toHaveBeenCalled();
    }
  );

  it('已是目标状态时幂等处理；未注册且无账号时不创建空账号', async () => {
    const { service, repository, operator } = fixture();
    await expect(
      service.markRegistered(
        'alias-1',
        { ...version, registered: false, expectedAccountUpdatedAt: null },
        operator
      )
    ).resolves.toMatchObject({ registered: false, created: false, accountId: null });
    repository.account.mockResolvedValue({
      id: 'account-1',
      emailMasked: 'hi***@example.invalid',
      registered: true,
      updatedAt: new Date(version.expectedUpdatedAt)
    });
    await expect(
      service.markRegistered(
        'alias-1',
        { ...version, registered: true, expectedAccountUpdatedAt: version.expectedUpdatedAt },
        operator
      )
    ).resolves.toMatchObject({ registered: true, created: false, accountId: 'account-1' });
    expect(repository.createManualAccount).not.toHaveBeenCalled();
    expect(repository.setAccountRegistered).not.toHaveBeenCalled();
  });
});
