import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startServerRecheck } from './recharge-server-recheck';
import { sendRechargeWorkerRequest } from './recharge-worker-client';
import { hash } from './recharge-validation';

vi.mock('./recharge-worker-client', () => ({
  isRechargeWorkerConfigured: () => true,
  sendRechargeWorkerRequest: vi.fn().mockResolvedValue('accepted')
}));

const id = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const quote = {
  plan: 'plus',
  today: { currency: 'USD', amount: '20.00', amount_minor: 2000 },
  tax: { currency: 'USD', amount: '0.00', amount_minor: 0 },
  renewal: { currency: 'USD', amount: '20.00', amount_minor: 2000 },
  renewal_interval: 'monthly'
};

beforeEach(() => vi.clearAllMocks());

function dependencies() {
  const source = {
    id: sourceId,
    ownerId: operator.id,
    state: 'finished',
    action: 'server',
    plan: 'plus',
    leaseUntil: new Date(0),
    createdAt: new Date('2026-10-01T00:00:00Z'),
    accountKey: 'a'.repeat(64),
    expectedEmailEncrypted: 'encrypted',
    proxyId: '33333333-3333-4333-8333-333333333333',
    chatgptAccountId: null,
    cardId: null,
    billingNameEncrypted: null,
    result: {
      payment_requests_sent: 1,
      quote_authority: 'official_checkout_response',
      checkout_identifier: 'checkout-1',
      addressId: 'address-1',
      quote
    } as Record<string, unknown>
  };
  const repository = {
    owned: vi.fn().mockResolvedValue(source),
    lock: vi.fn(),
    findJob: vi.fn(async (_tx: unknown, lookup: string) => (lookup === sourceId ? source : null)),
    findRunningJob: vi.fn().mockResolvedValue(null),
    records: vi.fn().mockResolvedValue([]),
    updateJob: vi.fn(),
    createJob: vi.fn(async (_tx: unknown, data: Record<string, unknown>) => data)
  };
  const deps = {
    repository,
    transactions: {
      execute: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({}))
    },
    audit: { append: vi.fn() },
    accounts: {
      decryptExpectedEmail: vi.fn().mockReturnValue('test@example.invalid'),
      loginNetworkGuard: vi.fn().mockResolvedValue(null)
    },
    proxies: {
      forCharge: vi.fn().mockResolvedValue({
        mode: 'static',
        countryCode: 'US',
        type: 'http',
        host: 'proxy.example.invalid',
        port: 8080,
        username: '',
        password: ''
      })
    },
    finishUnreceivedJob: vi.fn()
  };
  return { source, repository, deps };
}

describe('server original payment recheck', () => {
  it('升级未知结果只恢复同原升级ID，不重新传入银行卡或付款授权', async () => {
    const { source, repository, deps } = dependencies();
    const upgradeId = `upg_${'b'.repeat(32)}`;
    source.plan = 'pro-5x';
    source.result = {
      operation: 'subscription_upgrade',
      upgrade_identifier: upgradeId,
      current_plan_before: 'plus',
      target_plan: 'pro-5x',
      quote_authority: 'official_upgrade_preview',
      payment_requests_sent: 1,
      payment_attempted: true,
      payment_status: 'unknown',
      quote: { ...quote, plan: 'pro-5x' }
    };
    await startServerRecheck(
      { id, sourceJobId: sourceId, sessionJson: '{}' },
      operator,
      deps as never
    );
    const payload = vi.mocked(sendRechargeWorkerRequest).mock.calls[0]![1];
    expect(payload).toMatchObject({
      recheckOnly: true,
      upgradeIdentifier: upgradeId,
      plan: 'pro-5x'
    });
    expect(payload).not.toHaveProperty('details');
    expect(payload).not.toHaveProperty('safety');
    expect(repository.createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        result: expect.objectContaining({
          upgrade_identifier: upgradeId,
          recheck_only: true,
          payment_requests_sent: 0
        })
      })
    );
  });
  it('原单复查使用当前用户已保存的 2FA，不传付款资料或重新付款授权', async () => {
    const { repository, deps } = dependencies();
    const totpAccountId = '88888888-8888-4888-8888-888888888888';
    const totp = {
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'sha1',
      digits: 6,
      period: 30
    };
    const totpAccounts = { forExecution: vi.fn().mockResolvedValue(totp) };
    let dispatched: Record<string, unknown> = {};
    vi.mocked(sendRechargeWorkerRequest).mockImplementationOnce(async (_path, body) => {
      dispatched = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      return 'accepted';
    });
    await startServerRecheck(
      {
        id,
        sourceJobId: sourceId,
        login: { email: 'test@example.invalid', password: 'synthetic-password', totpAccountId }
      },
      operator,
      { ...deps, totpAccounts } as never
    );
    expect(totpAccounts.forExecution).toHaveBeenCalledWith({}, totpAccountId, operator);
    expect(dispatched.login).toEqual({
      email: 'test@example.invalid',
      password: 'synthetic-password',
      totp
    });
    expect(dispatched.recheckOnly).toBe(true);
    expect(dispatched).not.toHaveProperty('details');
    expect(dispatched).not.toHaveProperty('safety');
    expect(dispatched.login).not.toHaveProperty('totpAccountId');
    expect(JSON.stringify(repository.createJob.mock.calls)).not.toContain(totp.secret);
    expect(JSON.stringify(deps.audit.append.mock.calls)).not.toContain(totp.secret);
  });

  it.each([
    { totpAccountId: 'invalid' },
    { totpAccountId: id, totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }
  ])('复查拒绝无效或多种 2FA 来源', async (selection) => {
    const { repository, deps } = dependencies();
    await expect(
      startServerRecheck(
        {
          id,
          sourceJobId: sourceId,
          login: { email: 'test@example.invalid', password: 'synthetic-password', ...selection }
        },
        operator,
        deps as never
      )
    ).rejects.toThrow('登录资料格式无效');
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('creates a read-only task using the original account and never sends card details', async () => {
    const { repository, deps } = dependencies();
    await expect(
      startServerRecheck(
        { id, sourceJobId: sourceId, sessionJson: '{"sessionToken":"synthetic"}' },
        operator,
        deps as never
      )
    ).resolves.toEqual({ id });
    expect(repository.createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'server',
        accountKey: 'a'.repeat(64),
        result: expect.objectContaining({ recheck_only: true, source_job_id: sourceId })
      })
    );
    const body = vi.mocked(sendRechargeWorkerRequest).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.recheckOnly).toBe(true);
    expect(body.sourceAccountKey).toBe('a'.repeat(64));
    expect(body).not.toHaveProperty('details');
    expect(body).not.toHaveProperty('safety');
  });

  it('rejects a source with no confirmed original payment request', async () => {
    const { source, deps } = dependencies();
    source.result.payment_requests_sent = 0;
    await expect(
      startServerRecheck({ id, sourceJobId: sourceId, sessionJson: '{}' }, operator, deps as never)
    ).rejects.toThrow('不能只读复查');
  });

  it.each(['running', 'confirming'])(
    '过期 %s 原任务允许只读复查，绝不带付款授权',
    async (state) => {
      const { source, deps } = dependencies();
      source.state = state;
      await expect(
        startServerRecheck(
          { id, sourceJobId: sourceId, sessionJson: '{}' },
          operator,
          deps as never
        )
      ).resolves.toEqual({ id });
      expect(vi.mocked(sendRechargeWorkerRequest).mock.calls[0]?.[1]).toMatchObject({
        recheckOnly: true
      });
      expect(vi.mocked(sendRechargeWorkerRequest).mock.calls[0]?.[1]).not.toHaveProperty('safety');
    }
  );

  it('未过期 confirming 仍然禁止并行复查', async () => {
    const { source, repository, deps } = dependencies();
    source.state = 'confirming';
    source.leaseUntil = new Date(Date.now() + 60000);
    await expect(
      startServerRecheck({ id, sourceJobId: sourceId, sessionJson: '{}' }, operator, deps as never)
    ).rejects.toThrow('不能只读复查');
    expect(repository.createJob).not.toHaveBeenCalled();
    expect(sendRechargeWorkerRequest).not.toHaveBeenCalled();
  });

  it('旧硬中断从租约内唯一原单记录恢复摘要，并留审计供幂等补记使用', async () => {
    const { source, repository, deps } = dependencies();
    source.state = 'confirming';
    source.leaseUntil = new Date('2026-10-01T00:16:00Z');
    delete source.result.payment_requests_sent;
    delete source.result.checkout_identifier;
    const checkoutIdentifier = 'cs_historical_synthetic';
    repository.records.mockResolvedValue([
      {
        ownerId: operator.id,
        accountKey: source.accountKey,
        fileKey: `payments/${hash(checkoutIdentifier)}.json`,
        updatedAt: new Date('2026-10-01T00:01:00Z'),
        document: {
          account_key: source.accountKey,
          target_plan: source.plan,
          checkout_identifier: checkoutIdentifier,
          quote,
          payment_attempted: true,
          payment_status: 'unknown',
          confirmation_requests_sent: 1,
          created_at: Date.parse('2026-10-01T00:00:59Z') / 1000
        }
      }
    ]);
    await expect(
      startServerRecheck({ id, sourceJobId: sourceId, sessionJson: '{}' }, operator, deps as never)
    ).resolves.toEqual({ id });
    expect(repository.updateJob).toHaveBeenCalledWith({}, sourceId, {
      result: expect.objectContaining({
        checkout_identifier: checkoutIdentifier,
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      })
    });
    expect(deps.audit.append).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'id_business_v2.auto_recharge.server.restore_payment_facts',
        objectId: sourceId
      })
    );
    expect(repository.createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        result: expect.objectContaining({ recheck_only: true, payment_requests_sent: 0 })
      })
    );
  });

  it('锁内再次核对付款事实，原任务已变为拒付时不创建复查', async () => {
    const { source, repository, deps } = dependencies();
    repository.findJob.mockImplementation(async (_tx, lookup) =>
      lookup === sourceId
        ? { ...source, result: { ...source.result, payment_status: 'declined' } }
        : null
    );
    await expect(
      startServerRecheck({ id, sourceJobId: sourceId, sessionJson: '{}' }, operator, deps as never)
    ).rejects.toThrow('不能只读复查');
    expect(repository.createJob).not.toHaveBeenCalled();
    expect(sendRechargeWorkerRequest).not.toHaveBeenCalled();
  });

  it('已绑定原单的迟到付款证据覆盖旧拒付摘要，仍只读核对订阅而不再付款', async () => {
    const { source, repository, deps } = dependencies();
    const checkoutIdentifier = 'cs_late_paid';
    Object.assign(source.result, {
      checkout_identifier: checkoutIdentifier,
      payment_status: 'declined',
      status: 'payment_result_unknown'
    });
    repository.records.mockResolvedValue([
      {
        ownerId: operator.id,
        accountKey: source.accountKey,
        fileKey: `payments/${hash(checkoutIdentifier)}.json`,
        updatedAt: new Date(),
        document: {
          account_key: source.accountKey,
          target_plan: source.plan,
          checkout_identifier: checkoutIdentifier,
          quote,
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_status: 'paid',
          payment_evidence: {
            kind: 'checkout_session',
            identifier: checkoutIdentifier,
            amount_minor: 2000,
            currency: 'USD'
          }
        }
      }
    ]);
    await expect(
      startServerRecheck({ id, sourceJobId: sourceId, sessionJson: '{}' }, operator, deps as never)
    ).resolves.toEqual({ id });
    expect(repository.updateJob).toHaveBeenCalledWith({}, sourceId, {
      result: expect.objectContaining({ payment_status: 'paid', payment_requests_sent: 1 })
    });
    expect(vi.mocked(sendRechargeWorkerRequest).mock.calls[0]?.[1]).not.toHaveProperty('safety');
  });
});
