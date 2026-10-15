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
  let accounts: {
    id: string;
    emailHash: string;
    deletedAt: Date | null;
    passwordEncrypted?: string | null;
    registrationCountryCode?: string | null;
    registrationIpEncrypted?: string | null;
    registeredAt?: Date | null;
    updatedAt?: Date;
  }[] = [];
  let receipts: { afterData: Record<string, unknown> }[] = [];
  const tx = {};
  const repository = {
    accountEmailHashes: vi.fn().mockResolvedValue([{ emailHash: `hash:${email}` }]),
    registrationMirrorAccounts: vi.fn(async (_tx, id: string, hash: string) =>
      accounts.filter((row) => row.id === id || row.emailHash === hash)
    ),
    registrationMirrorPreview: vi.fn(async (id: string, hash: string) =>
      accounts.filter((row) => row.id === id || row.emailHash === hash)
    ),
    registrationCountryEdits: vi.fn().mockResolvedValue([]),
    updateAccount: vi.fn(async (_tx, args) => {
      const row = accounts.find((row) => row.id === args.where.id)!;
      Object.assign(row, args.data);
      return row;
    }),
    registrationMirrorAudit: vi.fn(async (tx: object, request: { accountId: string }) => {
      void tx;
      void request;
      return receipts;
    }),
    createAccount: vi.fn(async (_tx, args) => {
      accounts.push({ ...args.data, deletedAt: null });
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
    encrypt: vi.fn((value: string | null) => (value == null ? null : `encrypted:${value}`)),
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
      select: {
        id: true,
        emailHash: true,
        deletedAt: true,
        passwordEncrypted: true,
        registrationCountryCode: true,
        registrationIpEncrypted: true,
        registeredAt: true,
        updatedAt: true
      }
    });
  });
});

describe('注册事实与人工补建', () => {
  const manual = { email, aliasId: 'real-alias', revision: 3 };
  const facts = {
    ...input,
    schemaVersion: 2 as const,
    identityStatus: 'creation_confirmed' as const,
    creationConfirmed: true,
    registrationIp: '203.0.113.8',
    registeredAt: '2026-01-01T01:02:03Z',
    provider: 'apple_hidden'
  };

  it('加密真实注册出口，独立记录注册时间，审计不包含出口明文或密码', async () => {
    const { service, repository, audit } = setup();
    await service.mirrorRegistration(facts, operator);
    expect(repository.createAccount.mock.calls[0]?.[1].data).toMatchObject({
      registrationIpEncrypted: 'encrypted:203.0.113.8',
      registeredAt: new Date(facts.registeredAt)
    });
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('203.0.113.8');
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('synthetic-password');
  });

  it.each([
    { schemaVersion: undefined },
    { creationConfirmed: false },
    { registrationIp: 'http://invalid.test' },
    { registeredAt: 'tomorrow' },
    { registeredAt: '2026-02-30T00:00:00Z' },
    { registeredAt: '2026-01-01T24:00:00Z' },
    { source: 'login' as const },
    { registeredAt: '2999-01-01T00:00:00Z' }
  ])('拒绝没有创建依据或无效注册事实 %#', async (patch) => {
    const { service, transactions } = setup();
    await expect(service.mirrorRegistration({ ...facts, ...patch }, operator)).rejects.toThrow();
    expect(transactions.execute).not.toHaveBeenCalled();
  });

  it('创建后失败的原任务可以补齐缺失事实，保留已有人工改过的密码及国家', async () => {
    const { service, accounts, repository } = setup();
    await service.mirrorRegistration(
      { ...facts, registrationIp: null, registeredAt: null },
      operator
    );
    Object.assign(accounts()[0]!, {
      passwordEncrypted: 'manual-password',
      registrationCountryCode: 'PH'
    });
    await service.mirrorRegistration({ ...facts, fingerprint: 'b'.repeat(64) }, operator);
    expect(accounts()[0]).toMatchObject({
      passwordEncrypted: 'manual-password',
      registrationCountryCode: 'PH',
      registrationIpEncrypted: 'encrypted:203.0.113.8',
      registeredAt: new Date(facts.registeredAt)
    });
    expect(repository.updateAccount).toHaveBeenCalledTimes(1);
    await service.mirrorRegistration({ ...facts, fingerprint: 'b'.repeat(64) }, operator);
    expect(repository.updateAccount).toHaveBeenCalledTimes(1);
  });

  it('原创建任务授权完成后登记新的来源回执，不重复建号或改写凭据', async () => {
    const { service, repository, receipts } = setup();
    await service.mirrorRegistration(facts, operator);
    const completed = {
      ...facts,
      identityStatus: 'verified' as const,
      fingerprint: 'c'.repeat(64)
    };
    await service.mirrorRegistration(completed, operator);
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
    expect(repository.updateAccount).not.toHaveBeenCalled();
    expect(receipts().at(-1)?.afterData.identityStatus).toBe('verified');
    await service.mirrorRegistration(completed, operator);
    expect(receipts()).toHaveLength(2);
  });

  it('人工明确清空过注册国家时，迟到补齐也不能重新填回', async () => {
    const { service, accounts, repository } = setup();
    await service.mirrorRegistration(facts, operator);
    accounts()[0]!.registrationCountryCode = null;
    repository.registrationCountryEdits.mockResolvedValue([
      {
        beforeData: { registrationCountryCode: 'MY' },
        afterData: { registrationCountryCode: null }
      }
    ]);
    await service.mirrorRegistration(
      { ...facts, identityStatus: 'verified', fingerprint: 'c'.repeat(64) },
      operator
    );
    expect(accounts()[0]!.registrationCountryCode).toBeNull();
    expect(repository.updateAccount).not.toHaveBeenCalled();
  });

  it('人工已注册补建只保存已知事实，稳定去重且不伪造创建时间和凭据', async () => {
    const { service, repository, audit } = setup();
    expect((await service.previewManualRegistered(manual, operator)).status).toBe('create');
    const first = await service.mirrorManualRegistered(manual, operator);
    expect((await service.previewManualRegistered(manual, operator)).status).toBe('exists');
    expect(await service.mirrorManualRegistered({ ...manual, revision: 4 }, operator)).toEqual({
      ...first,
      replayed: true
    });
    expect(repository.createAccount).toHaveBeenCalledTimes(1);
    expect(repository.createAccount.mock.calls[0]?.[1].data).toMatchObject({
      registeredAt: null,
      registrationIpEncrypted: null
    });
    expect(repository.createAccount.mock.calls[0]?.[1].data).not.toHaveProperty(
      'passwordEncrypted'
    );
    expect(audit.append.mock.calls[0]?.[1].afterData).toEqual({
      aliasId: manual.aliasId,
      revision: 3,
      emailHash: `hash:${email}`,
      source: 'manual',
      hasRegistrationIp: false
    });
  });

  it('现有活动账号保留原资料，回收站账号不恢复', async () => {
    const { service, setAccounts, repository } = setup();
    setAccounts([
      { id: otherId, emailHash: `hash:${email}`, deletedAt: null, passwordEncrypted: 'saved' }
    ]);
    expect(await service.mirrorManualRegistered(manual, operator)).toEqual({
      accountId: otherId,
      replayed: true
    });
    expect(repository.updateAccount).not.toHaveBeenCalled();
    setAccounts([{ id: otherId, emailHash: `hash:${email}`, deletedAt: new Date() }]);
    expect((await service.previewManualRegistered(manual, operator)).status).toBe('deleted');
    await expect(service.mirrorManualRegistered(manual, operator)).rejects.toThrow('回收站');
  });
});
