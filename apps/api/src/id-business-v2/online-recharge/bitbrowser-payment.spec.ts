import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  OnlineBitbrowserPaymentRepository,
  bitbrowserAccountKey
} from './persistence/bitbrowser-payment.repository';
import { requireTaskLease } from './persistence/worker.repository';
import { validateBitbrowserQuote } from './bitbrowser-policy';
const quoteFixture = {
  plan: 'plus',
  today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
  renewal_interval: 'monthly'
};

const taskId = '11111111-1111-4111-8111-111111111111',
  deviceId = '22222222-2222-4222-8222-222222222222';
const accountId = 'official-fixture-account';
const session = JSON.stringify({
  accessToken: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.x`
});
const accountKey = bitbrowserAccountKey(accountId);
const user = { id: '33333333-3333-4333-8333-333333333333' } as AuthenticatedUser;
const policy = {
  mode: 'manual' as 'manual' | 'automatic',
  currency: 'USD',
  maxAmount: '20.00',
  proxyCountryCode: 'US',
  deviceId
};
const clone = <T>(value: T): T => structuredClone(value);
function fixture(mode: 'manual' | 'automatic' = 'manual') {
  const device = { id: deviceId, enabled: true, tokenHash: 'fixture-hash' };
  const row = {
    id: taskId,
    provider: 'bitbrowser',
    operation: 'recharge',
    plan: 'plus',
    status: 'running',
    paymentStarted: false,
    cardId: '44444444-4444-4444-8444-444444444444',
    sessionEncrypted: `enc:${session}`,
    leaseOwner: `bitbrowser:${deviceId}`,
    leaseId: '55555555-5555-4555-8555-555555555555',
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 90000),
    payload: { bitBrowserPolicy: { ...policy, mode } },
    result: {}
  };
  const state = {
    taskId,
    deviceId,
    leaseVersion: 1,
    accountKey: null as string | null,
    quote: null as unknown,
    quoteDigest: null as string | null,
    quoteExpiresAt: null as Date | null,
    authorizedDigest: null as string | null,
    paymentConsumed: false,
    ledgerEncrypted: null as string | null,
    version: 0
  };
  function update(target: object, data: Record<string, unknown>) {
    for (const [key, value] of Object.entries(data))
      Object.assign(target, {
        [key]:
          value && typeof value === 'object' && 'increment' in value
            ? Number((target as Record<string, unknown>)[key]) + Number(value.increment)
            : clone(value)
      });
    return clone(target);
  }
  const tx = {
    onlineRechargeTask: {
      findUnique: vi.fn(async () => clone(row)),
      update: vi.fn(async ({ data }) => update(row, data))
    },
    onlineRechargeBitbrowserDevice: { findUnique: vi.fn(async () => clone(device)) },
    onlineRechargeBitbrowserState: {
      upsert: vi.fn(async () => clone(state)),
      findUnique: vi.fn(async () => clone(state)),
      update: vi.fn(async ({ data }) => update(state, data))
    },
    onlineRechargeCard: {
      findFirst: vi.fn(async () => ({
        id: row.cardId,
        status: 'active',
        leaseExpiresAt: row.leaseExpiresAt,
        allowedPlans: ['plus']
      }))
    }
  };
  const workers = {
    withLease: async (rpc: never, work: (client: typeof tx, task: never) => unknown) =>
      work(tx, requireTaskLease(clone(row) as never, rpc) as never)
  };
  const repository = {
    transaction: async (_key: string, work: (client: typeof tx) => unknown) => work(tx),
    log: vi.fn()
  };
  const encryption = {
    encrypt: (value: string) => 'enc:' + value,
    decrypt: (value: string) => value.slice(4)
  };
  const service = new OnlineBitbrowserPaymentRepository(
    repository as never,
    workers as never,
    encryption as never
  );
  const rpc = (args = {}) => ({
    method: 'fixture',
    taskId,
    workerId: row.leaseOwner,
    leaseId: row.leaseId,
    leaseVersion: row.leaseVersion,
    args
  });
  const quote = () =>
    service.quote(
      rpc({
        accountKey,
        quote: quoteFixture,
        quoteDigest: validateBitbrowserQuote(quoteFixture, 'plus', policy).digest
      }),
      device as never
    );
  return { service, row, state, device, tx, rpc, quote, repository };
}
describe('比特付款许可与持久化记录', () => {
  it('兼容原核心按 Checkout 编号派生的真实付款文件路径', async () => {
    const f = fixture('automatic');
    f.state.accountKey = accountKey;
    const quote = await f.quote(),
      checkoutId = 'cs_synthetic_original';
    const fileKey = `payments/${createHash('sha256').update(checkoutId).digest('hex')}.json`;
    const document = {
      account_key: accountKey,
      target_plan: 'plus',
      checkout_identifier: checkoutId,
      quote_digest: quote.digest,
      confirmation_requests_sent: 1
    };
    await expect(
      f.service.ledger(
        f.rpc({
          accountKey,
          fileKey,
          revision: 0,
          document: { ...document, checkout_identifier: 'cs_other' }
        }),
        f.device as never
      )
    ).rejects.toThrow('不匹配');
    await expect(
      f.service.ledger(f.rpc({ accountKey, fileKey, revision: 0, document }), f.device as never)
    ).resolves.toMatchObject({ revision: 1 });
  });
  it('恢复账号时绑定原 Session 账号，错误账号不返回记录', async () => {
    const f = fixture();
    await expect(
      f.service.restore(f.rpc({ accountKey: 'wrong' }), f.device as never)
    ).rejects.toThrow('账号');
    await expect(
      f.service.restore(f.rpc({ accountKey }), f.device as never)
    ).resolves.toMatchObject({ records: [] });
    expect(f.state.accountKey).toBe(accountKey);
  });
  it('人工模式须确认正确版本与摘要，重复确认幂等', async () => {
    const f = fixture();
    f.state.accountKey = accountKey;
    const registered = await f.quote();
    expect(registered.approved).toBe(false);
    await expect(
      f.service.confirm(taskId, { quoteDigest: 'old', version: registered.version }, user)
    ).rejects.toThrow();
    await f.service.confirm(
      taskId,
      { quoteDigest: registered.digest, version: registered.version },
      user
    );
    await expect(
      f.service.confirm(
        taskId,
        { quoteDigest: registered.digest, version: registered.version },
        user
      )
    ).resolves.toMatchObject({ duplicate: true });
  });
  it('过期报价和旧租约确认不能提交付款', async () => {
    const f = fixture();
    f.state.accountKey = accountKey;
    const registered = await f.quote();
    f.state.quoteExpiresAt = new Date(0);
    await expect(
      f.service.confirm(
        taskId,
        { quoteDigest: registered.digest, version: registered.version },
        user
      )
    ).rejects.toThrow();
    f.row.leaseVersion = 2;
    await f.service.restore(f.rpc({ accountKey }), f.device as never);
    expect(f.state.authorizedDigest).toBeNull();
    expect(f.state.quoteDigest).toBeNull();
  });
  it('自动模式仅在上限内授权，超限保持未授权', async () => {
    const f = fixture('automatic');
    f.state.accountKey = accountKey;
    expect((await f.quote()).approved).toBe(true);
    const blocked = fixture('automatic');
    blocked.state.accountKey = accountKey;
    blocked.row.payload.bitBrowserPolicy.maxAmount = '19.99';
    expect((await blocked.quote()).approved).toBe(false);
  });
  it('首次付款标记必须先持久化有效许可，重复提交不能再付款', async () => {
    const f = fixture();
    f.state.accountKey = accountKey;
    const quote = await f.quote();
    const document = {
      account_key: accountKey,
      target_plan: 'plus',
      quote_digest: quote.digest,
      confirmation_requests_sent: 1
    };
    const args = { accountKey, fileKey: `payments/${accountKey}.json`, revision: 0, document };
    await expect(f.service.ledger(f.rpc(args), f.device as never)).rejects.toThrow('许可');
    await f.service.confirm(taskId, { quoteDigest: quote.digest, version: quote.version }, user);
    await f.service.ledger(f.rpc(args), f.device as never);
    expect(f.row.paymentStarted).toBe(true);
    expect(f.state.paymentConsumed).toBe(true);
    await expect(f.service.ledger(f.rpc(args), f.device as never)).resolves.toMatchObject({
      replayed: true
    });
    await expect(
      f.service.ledger(f.rpc({ ...args, fileKey: `${accountKey}.json` }), f.device as never)
    ).rejects.toThrow();
    expect(f.state.ledgerEncrypted?.startsWith('enc:')).toBe(true);
  });
  it('停用电脑、修改银行卡状态或过期租约均不能执行付款', async () => {
    const f = fixture('automatic');
    f.state.accountKey = accountKey;
    const quote = await f.quote();
    f.device.enabled = false;
    await expect(
      f.service.status(f.rpc({ quoteDigest: quote.digest }), f.device as never)
    ).rejects.toThrow('停用');
    f.device.enabled = true;
    f.tx.onlineRechargeCard.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      f.service.ledger(
        f.rpc({
          accountKey,
          fileKey: `${accountKey}.json`,
          revision: 0,
          document: {
            account_key: accountKey,
            target_plan: 'plus',
            quote_digest: quote.digest,
            confirmation_requests_sent: 1
          }
        }),
        f.device as never
      )
    ).rejects.toThrow('银行卡');
    expect(f.row.paymentStarted).toBe(false);
    f.row.leaseExpiresAt = new Date(0);
    await expect(
      f.service.status(f.rpc({ quoteDigest: quote.digest }), f.device as never)
    ).rejects.toThrow('租约');
  });
  it('报价变化使先前人工授权失效，旧版本不能再次确认', async () => {
    const f = fixture();
    f.state.accountKey = accountKey;
    const first = await f.quote();
    await f.service.confirm(taskId, { quoteDigest: first.digest, version: first.version }, user);
    const quote = {
      ...quoteFixture,
      today: { amount: '21.00', amount_minor: 2100, currency: 'USD' }
    };
    const current = await f.service.quote(
      f.rpc({
        accountKey,
        quote,
        quoteDigest: validateBitbrowserQuote(quote, 'plus', policy).digest
      }),
      f.device as never
    );
    expect(current.approved).toBe(false);
    await expect(
      f.service.confirm(taskId, { quoteDigest: first.digest, version: first.version }, user)
    ).rejects.toThrow();
  });
  it('升级记录使用升级编号派生路径，账号与套餐仍须匹配', async () => {
    const f = fixture('automatic');
    f.state.accountKey = accountKey;
    const quote = await f.quote(),
      upgradeId = 'upg_' + 'a'.repeat(32);
    const args = {
      accountKey,
      fileKey: `payments/${createHash('sha256').update(upgradeId).digest('hex')}.json`,
      revision: 0,
      document: {
        account_key: accountKey,
        target_plan: 'plus',
        operation: 'subscription_upgrade',
        upgrade_identifier: upgradeId,
        quote_digest: quote.digest,
        confirmation_requests_sent: 1
      }
    };
    await expect(
      f.service.ledger(
        f.rpc({ ...args, document: { ...args.document, account_key: 'wrong' } }),
        f.device as never
      )
    ).rejects.toThrow();
    await expect(f.service.ledger(f.rpc(args), f.device as never)).resolves.toMatchObject({
      revision: 1
    });
  });
  it('重启后的原单核对保留付款事实，不能创建新付款记录或更换订单', async () => {
    const f = fixture('automatic');
    f.state.accountKey = accountKey;
    const quote = await f.quote();
    const document = {
      account_key: accountKey,
      target_plan: 'plus',
      quote_digest: quote.digest,
      confirmation_requests_sent: 1,
      checkout_identifier: 'cs_original'
    };
    const fileKey = `payments/${accountKey}.json`;
    await f.service.ledger(
      f.rpc({ accountKey, fileKey, revision: 0, document }),
      f.device as never
    );
    Object.assign(f.row.payload, { bitBrowserCheckOnly: true });
    f.row.leaseVersion = 2;
    await f.service.restore(f.rpc({ accountKey }), f.device as never);
    expect(f.state.paymentConsumed).toBe(true);
    expect(f.state.quoteDigest).toBe(quote.digest);
    await expect(
      f.service.ledger(
        f.rpc({
          accountKey,
          fileKey,
          revision: 1,
          document: { ...document, checkout_identifier: 'cs_new' }
        }),
        f.device as never
      )
    ).rejects.toThrow('原付款');
    await expect(
      f.service.ledger(
        f.rpc({
          accountKey,
          fileKey,
          revision: 1,
          document: { ...document, payment_status: 'unknown' }
        }),
        f.device as never
      )
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      f.service.quote(f.rpc({ accountKey, quote: quoteFixture }), f.device as never)
    ).rejects.toThrow('核价');
  });
});
