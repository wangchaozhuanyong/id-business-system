import type { IdBusinessV2RegistrationJob } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegistrationJobsService } from './registration-jobs.service';

const worker = vi.hoisted(() => ({ command: vi.fn(), ready: vi.fn(), windowLost: vi.fn() }));
vi.mock('./registration-worker', () => ({
  registrationWorkerCommand: worker.command,
  requireRegistrationWorker: worker.ready,
  registrationWindowLost: worker.windowLost,
  registeredProfileRecoveryPendingReason: 'registered_profile_recovery_pending'
}));
beforeEach(() => {
  worker.command.mockReset().mockResolvedValue({ delivery: 'accepted' });
  worker.ready.mockReset().mockResolvedValue(undefined);
  worker.windowLost.mockReset().mockResolvedValue(false);
});

function fixture() {
  const job = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ownerId: 'operator-1',
    mailboxAliasId: 'alias-1',
    emailHash: 'hash:fixture@example.invalid',
    emailEncrypted: 'encrypted:fixture@example.invalid',
    emailMasked: 'fi***@example.invalid',
    proxyId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    displayName: '合成资料',
    registrationAge: null,
    state: 'partial',
    step: 'profile',
    registered: false,
    passwordVerified: false,
    mfaVerified: false,
    attempt: 1,
    reason: null,
    accountId: null,
    nonceHash: null,
    leaseUntil: new Date(Date.now() - 1000),
    browserProfileId: null,
    createdAt: new Date('2026-10-03T00:00:00Z'),
    updatedAt: new Date('2026-10-03T00:00:00Z')
  } as IdBusinessV2RegistrationJob;
  const repository = {
    lock: vi.fn().mockResolvedValue(undefined),
    find: vi.fn(async () => ({ ...job })),
    findInTransaction: vi.fn(async () => ({ ...job })),
    active: vi.fn().mockResolvedValue(null),
    account: vi.fn().mockResolvedValue(null),
    pendingEmail: vi.fn().mockResolvedValue(null),
    update: vi.fn(async (_tx: object, _id: string, data: Record<string, unknown>) => {
      const patch = { ...data };
      if (typeof patch.attempt === 'object') patch.attempt = job.attempt + 1;
      Object.assign(job, patch);
      return { ...job };
    }),
    jobs: vi.fn().mockResolvedValue([]),
    accountsByEmailHashes: vi.fn().mockResolvedValue([]),
    unfinishedJobsByEmailHashes: vi.fn().mockResolvedValue([]),
    names: vi.fn().mockResolvedValue([{ id: 'name-1', displayName: '张明' }]),
    countNames: vi.fn().mockResolvedValue(201),
    create: vi.fn(),
    name: vi.fn().mockResolvedValue({ id: 'name-1', displayName: '张明' }),
    useName: vi.fn().mockResolvedValue(undefined)
  };
  const tx = {};
  const transactions = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const mailboxes = {
    registrationMailbox: vi.fn().mockResolvedValue({ email: 'fixture@example.invalid' }),
    aliasAddress: vi.fn().mockResolvedValue({ email: 'FIXTURE@example.invalid' }),
    registrationCode: vi.fn().mockResolvedValue({ code: '123456', mailId: 'fixture-mail' }),
    registrationMailboxSummaries: vi.fn().mockResolvedValue([])
  };
  const proxies = {
    forCharge: vi.fn().mockResolvedValue({ countryCode: 'US' }),
    list: vi.fn().mockResolvedValue({
      items: [{ id: 'proxy-1', countryCode: 'US', kind: 'mobile', linkMask: '已保存' }],
      total: 102
    })
  };
  const settings = {
    getServerProxySettings: vi
      .fn()
      .mockResolvedValue({ proxyId: 'proxy-1', proxy: { status: 'active' } })
  };
  const encryption = {
    hash: vi.fn((value: string) => `hash:${value}`),
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value?: string) => value?.replace(/^encrypted:/, '') ?? 'synthetic-value')
  };
  const operator = { id: job.ownerId, roles: ['admin'] } as never;
  const service = new RegistrationJobsService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never,
    mailboxes as never,
    settings as never,
    proxies as never
  );
  return { service, repository, transactions, mailboxes, proxies, operator, tx, job, audit };
}

describe('注册年龄任务快照', () => {
  it('创建时保存手动年龄，推导兼容生日并写可展示的审计字段', async () => {
    const { service, repository, operator, tx, job, audit } = fixture();
    repository.create.mockImplementation(async (_tx, data) => ({ ...job, ...data }));
    const result = await service.create(
      {
        mailboxAliasId: 'alias-1',
        proxyId: job.proxyId,
        age: 25,
        confirmIdentity: true
      },
      operator
    );
    expect(result.registrationAge).toBe(25);
    expect(repository.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        registrationAge: 25,
        birthDateEncrypted: expect.stringMatching(/^encrypted:\d{4}-01-01$/)
      })
    );
    expect(repository.lock.mock.invocationCallOrder[0]).toBeLessThan(
      repository.create.mock.invocationCallOrder[0]!
    );
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        afterData: expect.objectContaining({ registrationAge: 25 })
      })
    );
  });

  it('年龄留空时随机生成整数并持久化，启动和重试沿用原值', async () => {
    const { service, repository, operator, job } = fixture();
    repository.create.mockImplementation(async (_tx, data) => {
      Object.assign(job, data);
      return { ...job };
    });
    const result = await service.create(
      { mailboxAliasId: 'alias-1', proxyId: job.proxyId, confirmIdentity: true },
      operator
    );
    expect(Number.isInteger(result.registrationAge)).toBe(true);
    expect(result.registrationAge).toBeGreaterThanOrEqual(20);
    expect(result.registrationAge).toBeLessThanOrEqual(45);
    await service.launch(job.id, operator);
    expect(worker.command.mock.calls[0]![3].registrationAge).toBe(result.registrationAge);
    job.state = 'partial';
    await service.launch(job.id, operator);
    expect(worker.command.mock.calls[1]![3].registrationAge).toBe(result.registrationAge);
    expect(repository.create).toHaveBeenCalledOnce();
  });

  it('新尝试派发原年龄与原生日，继续和取消不重新分配', async () => {
    const { service, operator, job } = fixture();
    job.registrationAge = 45;
    job.birthDateEncrypted = 'encrypted:1996-01-01';
    await service.launch(job.id, operator);
    expect(worker.command).toHaveBeenLastCalledWith(
      job.id,
      2,
      'launch',
      expect.objectContaining({
        registrationAge: 45,
        birthDate: '1996-01-01'
      })
    );
    job.state = 'partial';
    await service.launch(job.id, operator);
    expect(worker.command).toHaveBeenLastCalledWith(
      job.id,
      3,
      'launch',
      expect.objectContaining({ registrationAge: 45 })
    );
    job.state = 'awaiting_user';
    await service.resume(job.id, operator);
    expect(worker.command).toHaveBeenLastCalledWith(
      job.id,
      3,
      'resume',
      expect.objectContaining({ attempt: 3 })
    );
    await service.cancel(job.id, operator);
    expect(job.registrationAge).toBe(45);
  });

  it('历史任务不回填年龄，客户端不能直接写内部快照字段', async () => {
    const { service, operator, job } = fixture();
    await service.launch(job.id, operator);
    expect(worker.command.mock.calls[0]![3]).not.toHaveProperty('registrationAge');
    await expect(
      service.create(
        {
          mailboxAliasId: 'alias-1',
          proxyId: job.proxyId,
          birthDate: '1996-01-01',
          confirmIdentity: true,
          registrationAge: 32
        },
        operator
      )
    ).rejects.toThrow('未知字段');
  });
});

describe('已注册任务的丢窗安全续接', () => {
  function registeredFixture() {
    const f = fixture();
    Object.assign(f.job, {
      registered: true,
      step: 'password',
      accountId: 'account-1',
      browserProfileId: 'reg_' + 'a'.repeat(64),
      registrationCountryCode: 'US',
      passwordEncrypted: 'encrypted:synthetic-staged-password',
      pendingTotpEncrypted: 'encrypted:synthetic-staged-totp'
    });
    f.repository.account.mockResolvedValue({
      id: f.job.accountId,
      emailHash: f.job.emailHash,
      registered: true,
      deletedAt: null
    });
    worker.windowLost.mockResolvedValue(true);
    return f;
  }
  it('确认丢窗后原子撤销旧绑定并保留账号、安全资料和注册证据', async () => {
    const f = registeredFixture();
    const oldProfile = f.job.browserProfileId;
    expect(await f.service.launch(f.job.id, f.operator)).toMatchObject({
      attempt: 2,
      delivery: 'accepted'
    });
    expect(worker.windowLost).toHaveBeenCalledWith(f.job.id, 1);
    expect(f.job).toMatchObject({
      accountId: 'account-1',
      registered: true,
      passwordVerified: false,
      mfaVerified: false,
      step: 'password',
      registrationCountryCode: 'US',
      browserProfileId: null,
      passwordEncrypted: 'encrypted:synthetic-staged-password',
      pendingTotpEncrypted: 'encrypted:synthetic-staged-totp',
      reason: 'registered_profile_recovery_pending',
      nonceHash: expect.any(String)
    });
    expect(worker.command).toHaveBeenCalledTimes(1);
    expect(worker.command).toHaveBeenCalledWith(
      f.job.id,
      2,
      'launch',
      expect.objectContaining({
        registered: true,
        passwordVerified: false,
        mfaVerified: false,
        step: 'password',
        browserProfileId: null
      })
    );
    expect(f.audit.append).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        action: 'id_business_v2.auto_registration.profile_lost_recovery',
        objectId: f.job.id,
        beforeData: { attempt: 1, browserProfileId: oldProfile },
        afterData: expect.objectContaining({
          attempt: 2,
          accountId: 'account-1',
          browserProfileId: null,
          registered: true
        })
      })
    );
  });
  it.each(['registered', 'password', 'password_verified', 'mfa'] as const)(
    '安全步骤%s使用原进度恢复',
    async (step) => {
      const f = registeredFixture();
      f.job.step = step;
      f.job.passwordVerified = ['password_verified', 'mfa'].includes(step);
      await f.service.launch(f.job.id, f.operator);
      expect(worker.command).toHaveBeenCalledWith(
        f.job.id,
        2,
        'launch',
        expect.objectContaining({
          step,
          passwordVerified: f.job.passwordVerified,
          browserProfileId: null
        })
      );
    }
  );
  it('窗口仍保留或结果不明时继续携带原绑定，不生成冷窗口', async () => {
    const f = registeredFixture();
    worker.windowLost.mockResolvedValue(false);
    const original = f.job.browserProfileId;
    await f.service.launch(f.job.id, f.operator);
    expect(f.job.browserProfileId).toBe(original);
    expect(worker.command).toHaveBeenCalledWith(
      f.job.id,
      2,
      'launch',
      expect.objectContaining({ browserProfileId: original })
    );
    expect(
      f.audit.append.mock.calls.some(([, entry]) => entry.action.endsWith('profile_lost_recovery'))
    ).toBe(false);
  });
  it('已撤销的冷准备失败只在再次确认空窗口后重试', async () => {
    const f = registeredFixture();
    f.job.browserProfileId = null;
    worker.windowLost.mockResolvedValue(false);
    await expect(f.service.launch(f.job.id, f.operator)).rejects.toThrow('丢失尚未确认');
    expect(worker.command).not.toHaveBeenCalled();
    worker.windowLost.mockResolvedValue(true);
    await f.service.launch(f.job.id, f.operator);
    expect(f.job.browserProfileId).toBeNull();
  });
  it('原nonce仍有效及等待本人处理的任务禁止冷恢复', async () => {
    const f = registeredFixture();
    f.job.nonceHash = 'a'.repeat(64);
    f.job.leaseUntil = new Date(Date.now() + 60_000);
    await expect(f.service.launch(f.job.id, f.operator)).rejects.toThrow('原任务仍有效');
    f.job.state = 'awaiting_user';
    await expect(f.service.launch(f.job.id, f.operator)).rejects.toThrow('原任务仍有效');
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(worker.command).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'other-account' },
    { emailHash: 'hash:other@example.invalid' },
    { registered: false },
    { deletedAt: new Date('2026-10-01T00:00:00Z') }
  ])('账号错绑或失效阻止清除窗口 %j', async (patch) => {
    const f = registeredFixture();
    f.repository.account.mockResolvedValue({
      id: f.job.accountId,
      emailHash: f.job.emailHash,
      registered: true,
      deletedAt: null,
      ...patch
    });
    await expect(f.service.launch(f.job.id, f.operator)).rejects.toThrow();
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(worker.command).not.toHaveBeenCalled();
  });
  it.each([
    { attempt: 2 },
    { browserProfileId: 'reg_' + 'b'.repeat(64) },
    { updatedAt: new Date('2026-10-03T00:00:00.001Z') },
    { nonceHash: 'b'.repeat(64), leaseUntil: new Date(Date.now() + 60_000) },
    { state: 'awaiting_user' },
    { step: 'registered' },
    { step: 'mfa', passwordVerified: true },
    { mfaVerified: true }
  ] satisfies Partial<IdBusinessV2RegistrationJob>[])(
    '窗口探测与事务之间的竞态拒绝续接 %j',
    async (patch) => {
      const f = registeredFixture();
      f.repository.findInTransaction.mockResolvedValueOnce({ ...f.job, ...patch });
      await expect(f.service.launch(f.job.id, f.operator)).rejects.toThrow();
      expect(f.repository.update).not.toHaveBeenCalled();
      expect(worker.command).not.toHaveBeenCalled();
    }
  );
  it('未注册丢窗和安全验证已完成的任务保持原规则', async () => {
    const f = fixture();
    f.job.browserProfileId = 'reg_' + 'a'.repeat(64);
    worker.windowLost.mockResolvedValue(true);
    await f.service.launch(f.job.id, f.operator);
    expect(worker.windowLost).not.toHaveBeenCalled();
    expect(f.job.browserProfileId).toBe('reg_' + 'a'.repeat(64));
    const complete = registeredFixture();
    complete.job.passwordVerified = true;
    complete.job.mfaVerified = true;
    complete.job.step = 'mfa_verified';
    worker.windowLost.mockClear();
    await complete.service.launch(complete.job.id, complete.operator);
    expect(worker.windowLost).not.toHaveBeenCalled();
    expect(complete.job.browserProfileId).toBe('reg_' + 'a'.repeat(64));
  });
});

describe('注册列表候选与原任务查询', () => {
  it('代理和名字搜索分页独立，返回各自总量并兼容旧搜索', async () => {
    const { service, repository, proxies, operator } = fixture();
    proxies.list.mockResolvedValue({
      items: [
        { id: 'proxy-1', countryCode: 'PH', kind: 'mobile', linkMask: '已保存 ···384888' },
        {
          id: 'proxy-2',
          countryCode: 'PH',
          kind: 'dynamic_residential',
          linkMask: '已保存 ···361f55'
        },
        {
          id: 'proxy-3',
          countryCode: 'US',
          kind: 'static_residential',
          linkMask: '已保存 ···123456'
        }
      ],
      total: 102
    });
    const result = await service.options(
      { proxySearch: 'US', proxyPage: '2', nameSearch: '张', namePage: '3' },
      operator
    );
    expect(proxies.list).toHaveBeenCalledWith({
      page: '2',
      pageSize: '100',
      keyword: 'US',
      status: 'active'
    });
    expect(repository.names).toHaveBeenCalledWith(
      { active: true, displayName: { contains: '张' } },
      200,
      100
    );
    expect(result).toMatchObject({ proxyTotal: 102, nameTotal: 201 });
    expect(result.proxies).toEqual([
      { id: 'proxy-1', countryCode: 'PH', label: 'PH · 移动代理 · 已保存 ···384888' },
      { id: 'proxy-2', countryCode: 'PH', label: 'PH · 动态住宅 · 已保存 ···361f55' },
      { id: 'proxy-3', countryCode: 'US', label: 'US · 静态住宅 · 已保存 ···123456' }
    ]);
    await service.options({ proxySearch: 'PH', proxyPage: '1' }, operator);
    expect(repository.names).toHaveBeenLastCalledWith({ active: true }, 0, 100);
    await service.options({ q: '旧搜索', page: '2' }, operator);
    expect(proxies.list).toHaveBeenLastCalledWith({
      page: '2',
      pageSize: '100',
      keyword: '旧搜索',
      status: 'active'
    });
    expect(repository.names).toHaveBeenLastCalledWith(
      { active: true, displayName: { contains: '旧搜索' } },
      100,
      100
    );
  });

  it('在分页之前剔除已注册、停用、授权失效、主邮箱无效和未结束任务邮箱', async () => {
    const { service, repository, mailboxes, operator } = fixture();
    const eligible = (id: string) => ({
      id,
      email: `${id}@example.invalid`,
      status: 'ACTIVE',
      authorizationValid: true,
      primaryAvailable: true
    });
    mailboxes.registrationMailboxSummaries.mockResolvedValue([
      { ...eligible('disabled'), status: 'DISABLED' },
      { ...eligible('expired'), authorizationValid: false },
      { ...eligible('unavailable'), primaryAvailable: false },
      eligible('registered'),
      eligible('pending'),
      ...Array.from({ length: 101 }, (_value, index) => eligible(`available-${index}`))
    ]);
    repository.accountsByEmailHashes.mockResolvedValue([
      { emailHash: 'hash:registered@example.invalid', registered: true }
    ]);
    repository.unfinishedJobsByEmailHashes.mockResolvedValue([
      { emailHash: 'hash:pending@example.invalid' }
    ]);
    const result = await service.options({ page: '2' }, operator);
    expect(result.mailboxTotal).toBe(101);
    expect(result.mailboxes).toEqual([
      { id: 'available-100', email: 'available-100@example.invalid' }
    ]);
  });

  it('创建响应丢失后只查回本人同邮箱未结束任务，结束及他人任务不返回', async () => {
    const { service, repository, mailboxes, operator, job } = fixture();
    repository.jobs.mockImplementation(async (where) =>
      [job, { ...job, ownerId: 'other-operator' }, { ...job, state: 'cancelled' }]
        .filter(
          (row) =>
            row.ownerId === where.ownerId &&
            row.emailHash === where.emailHash &&
            !where.state.notIn.includes(row.state)
        )
        .slice(0, 1)
    );
    expect(await service.pending('alias-1', operator)).toMatchObject({
      id: job.id,
      emailMasked: job.emailMasked
    });
    expect(mailboxes.aliasAddress).toHaveBeenCalledWith('alias-1', operator);
    expect(repository.jobs).toHaveBeenCalledWith(
      {
        ownerId: 'operator-1',
        emailHash: job.emailHash,
        state: { notIn: ['completed', 'cancelled'] }
      },
      0,
      1
    );
    job.ownerId = 'other-operator';
    expect(await service.pending('alias-1', operator)).toBeNull();
    mailboxes.aliasAddress.mockRejectedValueOnce(new Error('邮箱不存在'));
    await expect(service.pending('unavailable-alias', operator)).rejects.toThrow('邮箱不存在');
    expect(repository.jobs).toHaveBeenCalledTimes(2);
  });
});

describe('注册启动与恢复保护', () => {
  it('邮件查询返回时授权已过期，不向执行器返回迟到验证码', async () => {
    const { service, mailboxes, operator, job } = fixture();
    job.state = 'awaiting_email';
    job.codeRequestedAt = new Date();
    job.leaseUntil = new Date(Date.now() + 60_000);
    mailboxes.registrationCode.mockImplementation(async () => {
      job.leaseUntil = new Date(Date.now() - 1000);
      return { code: '123456', mailId: 'fixture-mail' };
    });
    await expect(service.code(job.id, operator)).rejects.toThrow('验证码步骤已变化');
    expect(worker.command).not.toHaveBeenCalled();
  });

  it('源邮箱地址变化后拒绝原任务启动、继续及读码，不读取新邮箱或提交验证码', async () => {
    const { service, mailboxes, operator, job } = fixture();
    mailboxes.registrationMailbox.mockResolvedValue({ email: 'changed@example.invalid' });
    await expect(service.launch(job.id, operator)).rejects.toThrow('原邮箱地址已变化');
    await expect(service.resume(job.id, operator)).rejects.toThrow('原邮箱地址已变化');
    job.state = 'awaiting_email';
    job.codeRequestedAt = new Date();
    job.leaseUntil = new Date(Date.now() + 60_000);
    await expect(service.code(job.id, operator)).rejects.toThrow('原邮箱地址已变化');
    await expect(
      service.submitCode(job.id, { code: '123456', attempt: job.attempt, step: job.step }, operator)
    ).rejects.toThrow('原邮箱地址已变化');
    expect(mailboxes.registrationCode).not.toHaveBeenCalled();
    expect(worker.command).not.toHaveBeenCalled();
  });

  it('过期旧任务遇到人工新建账号时停止，不启动官网流程', async () => {
    const { service, repository, operator, job } = fixture();
    repository.account.mockResolvedValue({ id: 'manual-account', registered: true });
    await expect(service.launch(job.id, operator)).rejects.toThrow('注册状态或关联账号已变化');
    await expect(service.resume(job.id, operator)).rejects.toThrow('注册状态或关联账号已变化');
    expect(worker.command).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, false]
  ])('同账号注册状态由%s改为%s时禁止重放原任务', async (original, current) => {
    const { service, repository, operator, job } = fixture();
    job.accountId = 'account-1';
    job.registered = original;
    job.browserProfileId = `reg_${'a'.repeat(64)}`;
    repository.account.mockResolvedValue({ id: 'account-1', registered: current });
    await expect(service.launch(job.id, operator)).rejects.toThrow('注册状态');
    expect(worker.command).not.toHaveBeenCalled();
  });

  it('官网回执已同步账号与任务为已注册后允许原窗口恢复', async () => {
    const { service, repository, operator, job } = fixture();
    job.accountId = 'account-1';
    job.registered = true;
    job.step = 'registered';
    job.browserProfileId = 'reg_' + 'a'.repeat(64);
    repository.account.mockResolvedValue({ id: 'account-1', registered: true });
    expect(await service.launch(job.id, operator)).toMatchObject({
      id: job.id,
      attempt: 2,
      delivery: 'accepted'
    });
    expect(worker.command).toHaveBeenCalledWith(
      job.id,
      2,
      'launch',
      expect.objectContaining({ registered: true, browserProfileId: job.browserProfileId })
    );
  });

  it('事务内迟到取消关闭未知或已结束任务仍阻止启动与恢复', async () => {
    const { service, repository, operator, job } = fixture();
    repository.findInTransaction.mockResolvedValueOnce({
      ...job,
      reason: 'builtin_cancel_unconfirmed'
    });
    await expect(service.launch(job.id, operator)).rejects.toThrow('重试关闭');
    job.state = 'cancelled';
    await expect(service.resume(job.id, operator)).rejects.toThrow('不能补录');
    expect(worker.command).not.toHaveBeenCalled();
  });

  it('其他过期或暂停任务继续占用，创建前使用只读执行器预检', async () => {
    const { service, repository, operator, job } = fixture();
    repository.active.mockResolvedValue({ ...job, state: 'partial' });
    await expect(
      service.create(
        {
          mailboxAliasId: 'alias-1',
          proxyId: job.proxyId,
          birthDate: '1996-01-01',
          confirmIdentity: true
        },
        operator
      )
    ).rejects.toThrow('已有注册任务');
    expect(worker.ready).toHaveBeenCalledWith(true);
    expect(repository.create).not.toHaveBeenCalled();
    await expect(service.launch(job.id, operator)).rejects.toThrow('已有其他注册任务');
    expect(worker.command).not.toHaveBeenCalled();
  });

  it('明确拒绝保留原因并撤销本次授权，结果未知保留原编号授权', async () => {
    for (const dispatch of [
      { delivery: 'rejected', reason: 'worker_busy' },
      { delivery: 'unknown' }
    ]) {
      const { service, operator, job } = fixture();
      worker.command.mockResolvedValueOnce(dispatch);
      expect(await service.launch(job.id, operator)).toMatchObject({ id: job.id, ...dispatch });
      if (dispatch.delivery === 'rejected')
        expect(job).toMatchObject({
          state: 'partial',
          reason: 'worker_busy',
          nonceHash: null,
          leaseUntil: null
        });
      else
        expect(job).toMatchObject({
          state: 'running',
          attempt: 2,
          nonceHash: expect.any(String),
          leaseUntil: expect.any(Date)
        });
    }
  });

  it('取消指令明确拒绝不释放未确认原窗口', async () => {
    const { service, operator, job } = fixture();
    job.browserProfileId = 'reg_' + 'a'.repeat(64);
    worker.command.mockResolvedValueOnce({
      delivery: 'rejected',
      reason: 'fingerprint_cleanup_failed'
    });
    expect(await service.cancel(job.id, operator)).toMatchObject({
      delivery: 'rejected',
      reason: 'fingerprint_cleanup_failed'
    });
    expect(job).toMatchObject({ state: 'partial', reason: 'builtin_cancel_unconfirmed' });
  });
});
