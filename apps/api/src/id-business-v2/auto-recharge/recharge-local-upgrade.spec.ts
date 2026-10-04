import { describe, expect, it, vi } from 'vitest';
import { RechargeLocalService } from './recharge-local.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { hash } from './recharge-validation';

const id = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const upgradeId = `upg_${'b'.repeat(32)}`;
const operator = { id: 'synthetic-owner', roles: ['admin'], permissions: [] };
const quote = {
  plan: 'pro-20x',
  today: { amount: '180.00', amount_minor: 18000, currency: 'USD' },
  tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
  renewal: { amount: '200.00', amount_minor: 20000, currency: 'USD' },
  renewal_interval: 'monthly'
};

function fixture() {
  const source = {
    id: sourceId,
    ownerId: operator.id,
    accountKey: 'a'.repeat(64),
    plan: 'pro-20x',
    action: 'bitbrowser',
    state: 'unknown',
    createdAt: new Date('2026-10-03T00:00:00Z'),
    leaseUntil: new Date('2026-10-03T01:00:00Z'),
    result: {
      operation: 'subscription_upgrade',
      upgrade_identifier: upgradeId,
      target_plan: 'pro-20x',
      current_plan_before: 'plus',
      quote_authority: 'official_upgrade_preview',
      quote,
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1
    } as Record<string, unknown>
  };
  const repository = {
    lock: vi.fn(),
    findRunningJob: vi.fn().mockResolvedValue(null),
    findJob: vi.fn(async (_tx, requested) => (requested === sourceId ? source : null)),
    records: vi.fn().mockResolvedValue([]),
    updateJob: vi.fn(async (_tx, _id, data) => {
      source.result = data.result;
      return source;
    }),
    createJob: vi.fn(async (_tx, data) => data)
  };
  const settings = {
    runtime: vi
      .fn()
      .mockResolvedValue({ connectorUrl: 'http://localhost:55321', connectorToken: 'c'.repeat(64) })
  };
  const service = new RechargeLocalService(
    repository as never,
    {} as never,
    settings as never,
    {} as never,
    { execute: vi.fn(async (callback) => callback({})) } as never,
    { append: vi.fn() } as never
  );
  return { service, repository, source };
}

describe('本机升级原单复查派发', () => {
  it('复查绑定API保存的原upg ID，不接收付款资料或新授权', async () => {
    const { service, repository } = fixture();
    const launch = await service.recheck(
      { id, sourceJobId: sourceId, plan: 'pro-20x', windowName: '升级复查' },
      operator as never
    );
    expect(launch).toMatchObject({ mode: 'recheck', upgradeIdentifier: upgradeId });
    expect(repository.createJob).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        result: expect.objectContaining({
          operation: 'subscription_upgrade',
          upgrade_identifier: upgradeId,
          quote_authority: 'official_upgrade_preview',
          recheck_only: true,
          payment_requests_sent: 0
        })
      })
    );
    for (const key of ['details', 'safety', 'authorizeSinglePayment'])
      expect(launch).not.toHaveProperty(key);
  });

  it('硬中断零次数摘要由同原升级持久标记恢复，其他操作不被误取', async () => {
    const { service, repository, source } = fixture();
    source.result.payment_requests_sent = 0;
    source.result.payment_attempted = false;
    repository.records.mockResolvedValue([
      {
        ownerId: operator.id,
        accountKey: source.accountKey,
        fileKey: `payments/${hash(upgradeId)}.json`,
        updatedAt: new Date(),
        document: {
          ...source.result,
          account_key: source.accountKey,
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_status: 'unknown'
        }
      }
    ] as never);
    await expect(
      service.recheck(
        { id, sourceJobId: sourceId, plan: 'pro-20x', windowName: '升级复查' },
        operator as never
      )
    ).resolves.toMatchObject({ upgradeIdentifier: upgradeId });
    expect(source.result.payment_requests_sent).toBe(1);
    expect(source.result.confirmation_requests_sent).toBe(1);
    expect(repository.updateJob).toHaveBeenCalledTimes(1);
    expect(repository.updateJob.mock.invocationCallOrder[0]).toBeLessThan(
      repository.createJob.mock.invocationCallOrder[0]!
    );
    expect(repository.createJob.mock.calls[0]![1].result.payment_requests_sent).toBe(0);
    const bankRepository = {
      findRechargeJob: vi.fn().mockResolvedValue(source),
      findOrderByPaymentEvidence: vi.fn().mockResolvedValue(null),
      findCardsByTail: vi.fn().mockResolvedValue([]),
      createOrder: vi.fn(async (_tx, input) => ({ id: 'backfilled', ...input.data }))
    };
    const bankOrders = new BankRechargeOrderService(
      {} as never,
      { append: vi.fn() } as never,
      {
        ensureVerifiedCurrency: vi.fn().mockResolvedValue({ code: 'USD', minorUnits: 2 }),
        ensureAccountForVerifiedPayment: vi.fn().mockResolvedValue(null)
      } as never,
      bankRepository as never,
      {} as never,
      { decrypt: () => null } as never
    );
    const recheck = repository.createJob.mock.calls[0]![1];
    await expect(
      bankOrders.recordVerifiedSuccess({} as never, recheck as never, {
        ...source.result,
        recheck_only: true,
        payment_requests_sent: 0,
        payment_status: 'paid',
        status: 'subscription_activated',
        payment_outcome: 'subscription_activated',
        account_matched: true,
        upgrade_invoice_identifier: 'in_recoveredupgrade',
        payment_evidence: {
          kind: 'invoice',
          identifier: 'in_recoveredupgrade',
          amount_minor: 18000,
          currency: 'USD'
        }
      })
    ).resolves.toMatchObject({ rechargeJobId: source.id, openedAt: null, dueAt: null });
    expect(bankRepository.createOrder).toHaveBeenCalledTimes(1);
  });

  it('原事实恢复写入失败时不派发复查任务', async () => {
    const { service, repository, source } = fixture();
    source.result.payment_requests_sent = 0;
    repository.records.mockResolvedValue([
      {
        ownerId: operator.id,
        accountKey: source.accountKey,
        fileKey: `payments/${hash(upgradeId)}.json`,
        updatedAt: new Date(),
        document: {
          ...source.result,
          account_key: source.accountKey,
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_status: 'unknown'
        }
      }
    ] as never);
    repository.updateJob.mockRejectedValueOnce(new Error('恢复写入失败'));
    await expect(
      service.recheck(
        { id, sourceJobId: sourceId, plan: 'pro-20x', windowName: '复查' },
        operator as never
      )
    ).rejects.toThrow('恢复写入失败');
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('没有明确Plus升级绑定的记录拒绝复查', async () => {
    const { service, repository, source } = fixture();
    source.result.current_plan_before = 'free';
    await expect(
      service.recheck(
        { id, sourceJobId: sourceId, plan: 'pro-20x', windowName: '升级复查' },
        operator as never
      )
    ).rejects.toThrow('原升级操作绑定不完整');
    expect(repository.createJob).not.toHaveBeenCalled();
  });
});
