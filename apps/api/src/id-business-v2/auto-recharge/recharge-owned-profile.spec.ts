import { describe, expect, it, vi } from 'vitest';
import { findOwnedRechargeBrowserProfile } from './recharge-job-helpers';
import { RechargeService } from './recharge.service';

const currentId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const profileId = 'b'.repeat(32);
const accountKey = 'a'.repeat(64);
const ownerId = 'synthetic-owner';
const success = () => ({
  id: sourceId,
  ownerId,
  accountKey,
  action: 'bitbrowser',
  state: 'finished',
  plan: 'go',
  result: {
    browser_profile_id: profileId,
    account_matched: true,
    payment_requests_sent: 1,
    confirmation_requests_sent: 1,
    payment_status: 'paid',
    status: 'subscription_activated',
    payment_outcome: 'subscription_activated',
    quote_authority: 'official_checkout_response',
    checkout_identifier: 'cs_ownedprofile',
    payment_evidence: {
      kind: 'checkout_session',
      identifier: 'cs_ownedprofile',
      amount_minor: 10000,
      currency: 'PHP'
    },
    quote: { plan: 'go', today: { amount: '100.00', amount_minor: 10000, currency: 'PHP' } }
  }
});
const owned = { sourceJobId: sourceId, profileId, accountKey };
describe('同账号成功比特窗口归属', () => {
  it('只使用真实成功源任务记录，不按窗口名字猜测，旧 Go 可以供后续 Plus 核对', () => {
    expect(
      findOwnedRechargeBrowserProfile(
        [
          {
            ...success(),
            result: {
              ...success().result,
              current_plan: 'go',
              target_plan: 'go',
              window_name: '任意名字'
            }
          }
        ],
        ownerId,
        accountKey
      )
    ).toEqual(owned);
  });
  it('完整 Go→Plus 官网升级证明允许复用窗口，下一次仍重新核对实际套餐', () => {
    const source = success();
    const result = {
      ...source.result,
      operation: 'subscription_upgrade',
      upgrade_identifier: `upg_${'c'.repeat(32)}`,
      current_plan_before: 'go',
      target_plan: 'plus',
      quote_authority: 'official_upgrade_preview',
      quote: { ...source.result.quote, plan: 'plus' },
      upgrade_invoice_identifier: 'in_ownedprofile',
      payment_evidence: {
        ...source.result.payment_evidence,
        kind: 'invoice',
        identifier: 'in_ownedprofile'
      }
    };
    expect(
      findOwnedRechargeBrowserProfile([{ ...source, plan: 'plus', result }], ownerId, accountKey)
    ).toEqual(owned);
    expect(
      findOwnedRechargeBrowserProfile(
        [
          { ...source, plan: 'plus', result: { ...result, upgrade_invoice_identifier: 'in_other' } }
        ],
        ownerId,
        accountKey
      )
    ).toBeUndefined();
  });
  it.each([
    { ownerId: 'other-owner' },
    { accountKey: 'c'.repeat(64) },
    { action: 'registration' },
    { action: 'server' },
    { state: 'running' },
    { state: 'unknown' },
    { id: 'invalid' },
    { result: null }
  ])('其他归属、角色、未完成或未知记录不提供窗口 %j', (patch) => {
    expect(
      findOwnedRechargeBrowserProfile([{ ...success(), ...patch }], ownerId, accountKey)
    ).toBeUndefined();
  });
  it.each([
    { payment_status: 'unknown' },
    { status: 'blocked' },
    { payment_outcome: 'pending' },
    { payment_requests_sent: 0 },
    { confirmation_requests_sent: 0 },
    { account_matched: false },
    { quote_authority: 'page_text' },
    { payment_evidence: null },
    { payment_evidence: { ...success().result.payment_evidence, amount_minor: 9999 } },
    { payment_evidence: { ...success().result.payment_evidence, currency: 'USD' } },
    { payment_evidence: { ...success().result.payment_evidence, identifier: 'cs_other' } },
    { browser_profile_id: 'invalid' },
    { mode: 'open_browser' },
    { recheck_only: true },
    { browser_cleanup_status: 'completed' }
  ])('付款闭合或所属窗口证明不完整时不复用 %j', (patch) => {
    expect(
      findOwnedRechargeBrowserProfile(
        [{ ...success(), result: { ...success().result, ...patch } }],
        ownerId,
        accountKey
      )
    ).toBeUndefined();
  });
  it('restore回调只能向当前已核实账号返回归属证明，失败窗口仍独立处理', async () => {
    const job = {
      id: currentId,
      ownerId,
      accountKey,
      action: 'bitbrowser',
      state: 'running',
      plan: 'plus',
      result: {}
    };
    const repository = {
      lock: vi.fn(),
      active: vi.fn().mockResolvedValue(job),
      records: vi.fn().mockResolvedValue([]),
      finishedJobsForAccount: vi.fn().mockResolvedValue([success()]),
      updateJob: vi.fn()
    };
    const service = new RechargeService(
      repository as never,
      {} as never,
      { execute: vi.fn(async (work) => work({})) } as never,
      { append: vi.fn() } as never
    );
    expect(await service.callback(currentId, { type: 'restore', accountKey })).toEqual({
      records: [],
      staleProfiles: [],
      ownedProfile: owned
    });
    expect(repository.finishedJobsForAccount).toHaveBeenCalledWith(
      {},
      ownerId,
      accountKey,
      currentId
    );
    await expect(
      service.callback(currentId, { type: 'restore', accountKey: 'd'.repeat(64) })
    ).rejects.toThrow('账户标识不一致');
    job.action = 'server';
    expect(await service.callback(currentId, { type: 'restore', accountKey })).not.toHaveProperty(
      'ownedProfile'
    );
  });
});
