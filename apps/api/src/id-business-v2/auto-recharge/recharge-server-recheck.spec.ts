import { describe, expect, it, vi } from 'vitest';
import { startServerRecheck } from './recharge-server-recheck';
import { sendRechargeWorkerRequest } from './recharge-worker-client';

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

function dependencies() {
  const source = {
    id: sourceId,
    ownerId: operator.id,
    state: 'finished',
    action: 'server',
    plan: 'plus',
    leaseUntil: new Date(0),
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
      addressId: 'address-1'
    }
  };
  const repository = {
    owned: vi.fn().mockResolvedValue(source),
    lock: vi.fn(),
    findJob: vi.fn(async (_tx: unknown, lookup: string) => (lookup === sourceId ? source : null)),
    findRunningJob: vi.fn().mockResolvedValue(null),
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
});
