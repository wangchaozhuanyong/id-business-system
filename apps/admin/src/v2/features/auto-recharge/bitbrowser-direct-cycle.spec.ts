import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeBrowserRestore, V2RechargeNextCycleContext } from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch } from './contracts';
import type { DirectPaymentHooks } from './bitbrowser-direct-payment';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import {
  boundDirectCyclePeriod,
  directCycleMarker,
  prepareDirectNextCycle
} from './bitbrowser-direct-cycle';
const fake = vi.hoisted(() => ({ evaluate: vi.fn(), close: vi.fn() }));
vi.mock('./bitbrowser-payment-session', () => ({
  createDirectPaymentSession: async (browser: VerifiedPaymentBrowser) => ({
    session: { signal: browser.signal, evaluate: fake.evaluate },
    close: fake.close
  }),
  waitDirectPayment: vi.fn(async () => undefined)
}));
const key = 'd'.repeat(64),
  digest = 'e'.repeat(64),
  id = '11111111-1111-4111-8111-111111111111';
const period = () => ({
  source: 'official_subscription_response' as const,
  start: new Date(Date.now() - 40 * 86400000).toISOString(),
  end: new Date(Date.now() - 10 * 86400000).toISOString(),
  account_key: key,
  target_plan: 'plus' as const
});
const context = (): V2RechargeNextCycleContext => ({
  protocol: 1,
  jobId: id,
  accountKey: key,
  targetPlan: 'plus',
  sources: [
    {
      fileKey: `payments/${key}.json`,
      revision: 2,
      operationIdentifier: 'oaics_old',
      documentDigest: 'f'.repeat(64),
      targetPlan: 'plus',
      subscriptionPeriod: period()
    }
  ]
});
const grant = () => ({
  protocol: 1,
  jobId: id,
  accountKey: key,
  targetPlan: 'plus',
  reviewDigest: digest,
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  status: 'granted',
  checkoutFileKey: `${key}.json`,
  checkoutRevision: 4
});
describe('网页次周期资格来源', () => {
  it('只接受同账户同套餐的官方月度原账期', () =>
    expect(boundDirectCyclePeriod(period(), key, 'plus')?.target_plan).toBe('plus'));
  it.each([
    { source: 'local_clock' },
    { account_key: 'other' },
    { target_plan: 'go' },
    { start: 'invalid' },
    { start: '2026-01-01' },
    { end: '2026-02-01T00:00:00' },
    { end: new Date(Date.now() + 86400000 * 90).toISOString() },
    { end: new Date(Date.now() - 86400000 * 90).toISOString() }
  ])('拒绝非官方或无效账期 %j', (change) => {
    expect(boundDirectCyclePeriod({ ...period(), ...change }, key, 'plus')).toBeUndefined();
  });
  it('输出供服务器原子消费的精确五字段标记', () => {
    expect(directCycleMarker(grant(), context(), id)).toEqual({
      revision: 4,
      marker: { protocol: 1, jobId: id, accountKey: key, targetPlan: 'plus', reviewDigest: digest }
    });
  });
  it.each([
    { protocol: 2 },
    { jobId: 'other' },
    { accountKey: 'other' },
    { targetPlan: 'go' },
    { status: 'consumed' },
    { reviewDigest: 'bad' },
    { expiresAt: new Date(Date.now() - 1).toISOString() },
    { checkoutFileKey: `payments/${key}.json` },
    { checkoutRevision: -1 },
    { checkoutRevision: 1.2 }
  ])('不能扩大或重复消费次周期资格 %j', (change) => {
    expect(() => directCycleMarker({ ...grant(), ...change }, context(), id)).toThrow();
  });
});
describe('网页次周期后台检查与人工旧账期确认', () => {
  let browser: VerifiedPaymentBrowser,
    launch: V2RechargeBitBrowserLaunch,
    restored: V2RechargeBrowserRestore,
    hooks: DirectPaymentHooks;
  let active: unknown,
    future: boolean,
    waiting: boolean,
    changedAfterInspect: boolean,
    reads: number;
  beforeEach(() => {
    vi.clearAllMocks();
    active = false;
    future = false;
    waiting = false;
    changedAfterInspect = false;
    reads = 0;
    browser = {
      identity: {
        accountId: 'account',
        userId: 'user',
        email: 'synthetic@example.invalid',
        plan: 'free'
      },
      signal: new AbortController().signal
    } as VerifiedPaymentBrowser;
    launch = { id, subscriptionCycleProtocol: 1 } as V2RechargeBitBrowserLaunch;
    restored = { nextCycleContext: context() } as V2RechargeBrowserRestore;
    fake.evaluate.mockImplementation(async (expression: string) => {
      if (expression.includes('accounts/check')) {
        reads++;
        return {
          ok: true,
          data: {
            accounts: {
              account: {
                account: {
                  account_id: 'account',
                  plan_type: changedAfterInspect && reads > 2 ? 'plus' : 'free'
                },
                entitlement: { has_active_subscription: active }
              }
            }
          }
        };
      }
      return {
        ok: true,
        data: {
          account_id: 'account',
          plan_type: 'plus',
          active_start: period().start,
          active_until: future ? new Date(Date.now() + 86400000).toISOString() : period().end
        }
      };
    });
    hooks = {
      attempted: () => false,
      unexpected: vi.fn(async () => undefined),
      confirm: vi.fn(),
      progress: vi.fn(async () => undefined),
      callback: vi.fn(async (input: object) => {
        const phase = (input as { phase: string }).phase;
        return {
          cycleReview: {
            protocol: 1,
            status:
              phase === 'inspect' && waiting ? 'awaiting_previous_cycle_confirmation' : 'ready',
            reviewDigest: digest,
            expiresAt: grant().expiresAt
          },
          ...(phase === 'commit' ? { nextCycleContext: { ...context(), grant: grant() } } : {})
        };
      })
    };
  });
  it('检查和提交前各回读两次官网账号，不发送付款', async () => {
    const result = await prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks);
    expect(result?.revision).toBe(4);
    expect(reads).toBe(4);
    expect(hooks.confirm).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(hooks.callback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: 'inspect',
        subscription_inspection: expect.objectContaining({ has_active_subscription: false })
      })
    );
    expect(hooks.callback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'commit', reviewDigest: digest })
    );
  });
  it('缺少已核实周期时等待服务器收取人工旧周期确认，随后重新检查', async () => {
    waiting = true;
    await prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks);
    expect(hooks.progress).toHaveBeenCalledWith(
      'next_subscription_cycle_review',
      expect.objectContaining({
        account_matched: true,
        current_plan: 'free',
        user_action_required: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        checkout_requests_sent: 0
      })
    );
    expect(hooks.callback).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'status', reviewDigest: digest })
    );
    expect(reads).toBe(4);
  });
  it.each([true, undefined, 0, 'false'])('官网无明确无订阅布尔值%s不能授权', async (value) => {
    active = value;
    await expect(
      prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks)
    ).rejects.toThrow();
    expect(hooks.callback).not.toHaveBeenCalled();
  });
  it('原订阅尚未结束时不得授权新周期', async () => {
    future = true;
    await expect(
      prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks)
    ).rejects.toThrow();
    expect(hooks.callback).not.toHaveBeenCalled();
  });
  it('人工确认后订阅变化不能commit', async () => {
    changedAfterInspect = true;
    await expect(
      prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks)
    ).rejects.toThrow();
    expect(hooks.callback).toHaveBeenCalledTimes(1);
  });
  it('无周期上下文或已经消费时交回原单恢复逻辑', async () => {
    expect(
      await prepareDirectNextCycle(browser, launch, 'plus', undefined, key, hooks)
    ).toBeUndefined();
    restored.nextCycleContext!.grant = {
      ...grant(),
      status: 'consumed'
    } as V2RechargeNextCycleContext['grant'];
    expect(
      await prepareDirectNextCycle(browser, launch, 'plus', restored, key, hooks)
    ).toBeUndefined();
    expect(fake.evaluate).not.toHaveBeenCalled();
  });
});
