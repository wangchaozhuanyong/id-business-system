import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  BankRechargeRegistrationMirrorService,
  type RegistrationMirrorInput
} from './bank-recharge-registration-mirror.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const sourceTaskUuid = '123e4567-e89b-42d3-a456-426614174001';
const otherId = '123e4567-e89b-42d3-a456-426614174002';
const email = 'new@example.test';
const fingerprint = 'a'.repeat(64);
const operator = {
  id: 'admin-1',
  roles: ['admin'],
  permissions: []
} as unknown as AuthenticatedUser;
const input: RegistrationMirrorInput = {
  accountId,
  sourceTaskUuid,
  upstreamAccountId: 12,
  email,
  password: 'synthetic-password',
  registrationCountryCode: 'MY',
  source: 'register',
  fingerprint
};

function setup() {
  let accounts: { id: string; emailHash: string; deletedAt: Date | null }[] = [];
  let receipts: { afterData: Record<string, unknown> }[] = [];
  const tx = {};
  const repository = {
    accountEmailHashes: vi.fn().mockResolvedValue([{ emailHash: `hash:${email}` }]),
    registrationMirrorAccounts: vi.fn(async (_tx, id: string, hash: string) =>
      accounts.filter((row) => row.id === id || row.emailHash === hash)
    ),
    registrationMirrorAudit: vi.fn(async (tx: object, request: { accountId: string }) => {
      void tx;
      void request;
      return receipts;
    }),
    createAccount: vi.fn(async (_tx, args) => {
      accounts.push({ id: args.data.id, emailHash: args.data.emailHash, deletedAt: null });
      return args.data;
    })
  };
  const audit = {
    append: vi.fn(async (_tx, value) => {
      receipts.push({ afterData: value.afterData });
    })
  };
  const transactions = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>, options: unknown) => {
      void options;
      const previousAccounts = [...accounts];
      const previousReceipts = [...receipts];
      try {
        return await work(tx);
      } catch (error) {
        accounts = previousAccounts;
        receipts = previousReceipts;
        throw error;
      }
    })
  };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    hash: vi.fn((value: string) => `hash:${value}`)
  };
  const service = new BankRechargeRegistrationMirrorService(
    repository as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  return {
    service,
    repository,
    audit,
    transactions,
    encryption,
    tx,
    accounts: () => accounts,
    receipts: () => receipts,
    setAccounts: (value: typeof accounts) => (accounts = value),
    setReceipts: (value: typeof receipts) => (receipts = value)
  };
}

describe('隐藏邮箱注册的 ChatGPT 主账号保存', () => {
  it('仅管理员且有效身份可读取候选或保存，拒绝时不接触存储', async () => {
    const { service, repository, transactions } = setup();
    for (const user of [
      { ...operator, roles: ['staff'] },
      { ...operator, mustResetPassword: true },
      { ...operator, id: '' }
    ]) {
      await expect(service.registeredEmailHashes([email], user)).rejects.toThrow('授权已失效');
      await expect(service.mirrorRegistration(input, user)).rejects.toThrow('授权已失效');
    }
    expect(repository.accountEmailHashes).not.toHaveBeenCalled();
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('候选核对统一邮箱和哈希并去重，空批次不读取数据库', async () => {
    const { service, repository, encryption } = setup();
    await expect(
      service.registeredEmailHashes([' NEW@example.test ', email], operator)
    ).resolves.toEqual(new Set([`hash:${email}`]));
    expect(encryption.hash).toHaveBeenCalledWith(email);
    expect(repository.accountEmailHashes).toHaveBeenCalledWith([`hash:${email}`]);
    await expect(service.registeredEmailHashes([], operator)).resolves.toEqual(new Set());
    expect(repository.accountEmailHashes).toHaveBeenCalledTimes(1);
    await expect(service.registeredEmailHashes(Array(501).fill(email), operator)).rejects.toThrow(
      '最多 500'
    );
  });

  it('稳定账号编号和来源审计在同一事务，加密密码且保留未知订阅默认值', async () => {
    const { service, repository, audit, transactions, tx } = setup();
    await expect(service.mirrorRegistration(input, operator)).resolves.toEqual({
      accountId,
      replayed: false
    });
    expect(repository.createAccount).toHaveBeenCalledWith(tx, {
      data: {
        id: accountId,
        emailEncrypted: `encrypted:${email}`,
        emailHash: `hash:${email}`,
        emailMasked: 'ne***@example.test',
        registered: true,
        registrationCountryCode: 'MY',
        passwordEncrypted: 'encrypted:synthetic-password',
        createdByUserId: operator.id,
        updatedByUserId: operator.id
      }
    });
    expect(audit.append.mock.calls[0]?.[0]).toBe(tx);
    expect(audit.append.mock.calls[0]?.[1]).toMatchObject({
      objectId: accountId,
      afterData: {
        sourceTaskUuid,
        upstreamAccountId: '12',
        fingerprint,
        source: 'register',
        emailHash: `hash:${email}`
      }
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('synthetic-password');
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(`"${email}"`);
    expect(transactions.execute.mock.calls[0]?.[1]).toMatchObject({
      changedScopes: ['auto-recharge'],
      retryMode: 'stableIdempotency',
      idempotencyKey: accountId,
      requestId: sourceTaskUuid
    });
  });

  it('已有账号登录来源允许没有密码，省略国家保持未知', async () => {
    const { service, repository } = setup();
    await service.mirrorRegistration(
      { ...input, source: 'login', password: undefined, registrationCountryCode: undefined },
      operator
    );
    const saved = repository.createAccount.mock.calls[0]?.[1].data;
    expect(saved).not.toHaveProperty('passwordEncrypted');
    expect(saved.registrationCountryCode).toBeNull();
    expect(saved).not.toHaveProperty('offerStatus');
    expect(saved).not.toHaveProperty('subscription');
  });

  it('提交后回执丢失可按原任务回放，仅创建一次且不再改密码或国家', async () => {
    const { service, repository, audit } = setup();
    await service.mirrorRegistration(input, operator);
    await expect(
      service.mirrorRegistration({ ...input, upstreamAccountId: '12' }, operator)
    ).resolves.toEqual({ accountId, replayed: true });
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(repository.registrationMirrorAudit).toHaveBeenCalledWith(expect.anything(), {
      accountId,
      action: 'id_business_v2.auto_registration.chatgpt_account.mirror'
    });
  });

  it.each([
    { sourceTaskUuid: otherId },
    { upstreamAccountId: 13 },
    { fingerprint: 'b'.repeat(64) },
    { source: 'login' as const },
    { registrationCountryCode: 'PH' }
  ])('同邮箱但原任务来源不匹配时拒绝回放（%#）', async (patch) => {
    const { service, repository, audit } = setup();
    await service.mirrorRegistration(input, operator);
    await expect(service.mirrorRegistration({ ...input, ...patch }, operator)).rejects.toThrow(
      '未覆盖任何资料'
    );
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });

  it('另一有效管理员可恢复相同来源的同步，原创建审计及账号不改写', async () => {
    const { service, repository, audit } = setup();
    await service.mirrorRegistration(input, operator);
    await expect(
      service.mirrorRegistration(input, { ...operator, id: 'another-admin' })
    ).resolves.toEqual({ accountId, replayed: true });
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(audit.append.mock.calls[0]?.[1].userId).toBe(operator.id);
  });

  it.each([
    [{ id: accountId, emailHash: `hash:${email}`, deletedAt: null }],
    [{ id: otherId, emailHash: `hash:${email}`, deletedAt: null }],
    [{ id: accountId, emailHash: 'hash:other@example.test', deletedAt: null }],
    [
      { id: accountId, emailHash: 'hash:other@example.test', deletedAt: null },
      { id: otherId, emailHash: `hash:${email}`, deletedAt: null }
    ]
  ])('手工账号、编号冲突和双行冲突均不覆盖资料（%#）', async (...accounts) => {
    const { service, repository, audit, setAccounts } = setup();
    setAccounts(accounts);
    await expect(service.mirrorRegistration(input, operator)).rejects.toThrow('未覆盖任何资料');
    expect(repository.createAccount).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('即使来源完整，已删除资料也不恢复或创建替代账号', async () => {
    const { service, repository, setAccounts } = setup();
    await service.mirrorRegistration(input, operator);
    setAccounts([{ id: accountId, emailHash: `hash:${email}`, deletedAt: new Date() }]);
    await expect(service.mirrorRegistration(input, operator)).rejects.toThrow('未覆盖任何资料');
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
  });

  it('审计写入失败时事务撤销账号，允许从同一检查点安全重试', async () => {
    const state = setup();
    state.audit.append.mockRejectedValueOnce(new Error('synthetic audit unavailable'));
    await expect(state.service.mirrorRegistration(input, operator)).rejects.toThrow(
      'synthetic audit unavailable'
    );
    expect(state.accounts()).toEqual([]);
    expect(state.receipts()).toEqual([]);
    await expect(state.service.mirrorRegistration(input, operator)).resolves.toEqual({
      accountId,
      replayed: false
    });
  });

  it('并发唯一键冲突使用相同严格来源核验，不退回普通新增', async () => {
    const { service, transactions, repository, tx } = setup();
    await service.mirrorRegistration(input, operator);
    const options = transactions.execute.mock.calls[0]?.[1] as unknown as {
      replay: (tx: object) => Promise<unknown>;
    };
    await expect(options.replay(tx)).resolves.toEqual({ accountId, replayed: true });
    repository.registrationMirrorAudit.mockResolvedValue([]);
    await expect(options.replay(tx)).rejects.toThrow('未覆盖任何资料');
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
  });

  it.each([
    { accountId: 'browser-arbitrary-id' },
    { sourceTaskUuid: 'bad' },
    { upstreamAccountId: 0 },
    { upstreamAccountId: -1 },
    { upstreamAccountId: 1.5 },
    { upstreamAccountId: '1\nprivate' },
    { upstreamAccountId: '0' },
    { fingerprint: 'bad' },
    { password: '' },
    { password: undefined },
    { password: 'bad\nvalue' },
    { email: 'bad' },
    { source: 'unknown' },
    { registrationCountryCode: 'ZZ' }
  ])('无效资料或新注册密码缺失在写事务前拒绝（%#）', async (patch) => {
    const { service, transactions } = setup();
    await expect(
      service.mirrorRegistration({ ...input, ...patch } as RegistrationMirrorInput, operator)
    ).rejects.toThrow();
    expect(transactions.execute).not.toHaveBeenCalled();
  });
});

describe('注册镜像查询的持久化范围', () => {
  it('候选查询包含软删除账号，回放查询同时覆盖编号与邮箱而不筛掉删除状态', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new BankRechargeRepository({
      idBusinessV2ChatgptAccount: { findMany }
    } as never);
    await repository.accountEmailHashes(['hash:one']);
    expect(findMany.mock.calls[0]?.[0]).toEqual({
      where: { emailHash: { in: ['hash:one'] } },
      select: { emailHash: true }
    });
    await repository.registrationMirrorAccounts(
      { idBusinessV2ChatgptAccount: { findMany } } as never,
      accountId,
      `hash:${email}`
    );
    expect(findMany.mock.calls[1]?.[0]).toEqual({
      where: { OR: [{ id: accountId }, { emailHash: `hash:${email}` }] },
      select: { id: true, emailHash: true, deletedAt: true }
    });
  });
});
