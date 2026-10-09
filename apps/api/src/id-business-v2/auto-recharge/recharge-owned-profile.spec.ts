import { describe, expect, it, vi } from 'vitest';
import {
  findOwnedRechargeBrowserProfile,
  findOriginalRechargeCheckout,
  findRetainedRechargeBrowserProfile
} from './recharge-job-helpers';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash } from './recharge-validation';
import { RechargeRepository } from './persistence/recharge.repository';

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

const retained = () => ({
  ...success(),
  result: {
    status: 'blocked',
    reason: 'json_session_not_restored',
    browser_profile_id: profileId,
    account_matched: false,
    payment_attempted: false,
    payment_requests_sent: 0
  }
});

function restoreFixture(history = [retained()]) {
  const agentToken = 'synthetic-local-task-token';
  const job = {
    id: currentId,
    ownerId,
    accountKey: null as string | null,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    nonceHash: hash(agentToken),
    result: { mode: 'open_browser', transport: 'web_direct', payment_requests_sent: 0 } as Record<
      string,
      unknown
    >
  };
  const repository = {
    lock: vi.fn(),
    active: vi.fn().mockResolvedValue(job),
    byId: vi.fn().mockResolvedValue(job),
    records: vi.fn().mockResolvedValue([]),
    finishedJobsForAccount: vi.fn().mockResolvedValue(history),
    retainedProfileForAccount: vi.fn(async () =>
      findRetainedRechargeBrowserProfile(history, ownerId, accountKey)
    ),
    originalCheckoutForAccount: vi.fn(async () =>
      findOriginalRechargeCheckout(history, ownerId, accountKey, job.plan)
    ),
    restoreCheckoutIdentifier: new RechargeRepository({} as never).restoreCheckoutIdentifier,
    updateJob: vi.fn(async (_tx, _id, change) => Object.assign(job, change))
  };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const service = new RechargeService(
    repository as never,
    {} as never,
    transactions as never,
    { append: vi.fn() } as never
  );
  const local = new RechargeLocalService(
    repository as never,
    {} as never,
    {} as never,
    service,
    transactions as never,
    {} as never
  );
  return { job, repository, service, local, agentToken };
}

describe('同账号原比特窗口保留', () => {
  it.each([
    {},
    { mode: 'open_browser', status: 'session_ready', account_matched: true },
    { reason: 'operation_cancelled' },
    { reason: 'owned_recharge_window_unavailable', user_action_required: true }
  ])('未付款或未登录的目标归属可复用，但不伪造登录成功 %j', (patch) => {
    const source = retained();
    expect(
      findRetainedRechargeBrowserProfile(
        [{ ...source, result: { ...source.result, ...patch } }],
        ownerId,
        accountKey
      )
    ).toEqual(owned);
    expect(source.result.account_matched).toBe(false);
    expect(source.result.payment_requests_sent).toBe(0);
  });
  it('最新失败绑定优先于更旧成功窗口，不能回退到旧账号会话', () => {
    const latest = { ...retained(), id: currentId, result: { ...retained().result } };
    latest.result.browser_profile_id = 'c'.repeat(32);
    expect(findRetainedRechargeBrowserProfile([latest, success()], ownerId, accountKey)).toEqual({
      sourceJobId: currentId,
      profileId: 'c'.repeat(32),
      accountKey
    });
  });
  it.each([profileId, ''])('已删除原资料明确报错，不返回旧窗口或允许新建（%s）', (id) => {
    expect(() =>
      findRetainedRechargeBrowserProfile(
        [
          {
            ...retained(),
            id: currentId,
            result: {
              ...retained().result,
              browser_profile_id: id,
              browser_cleanup_status: 'completed'
            }
          },
          success()
        ],
        ownerId,
        accountKey
      )
    ).toThrow('原比特浏览器资料已被删除');
  });
  it.each([
    { ownerId: 'other-owner' },
    { accountKey: 'c'.repeat(64) },
    { action: 'server' },
    { state: 'running' },
    { id: 'invalid' },
    { result: { ...retained().result, recheck_only: true } }
  ])('其他目标、操作人或复查记录不能提供归属 %j', (patch) => {
    expect(
      findRetainedRechargeBrowserProfile([{ ...retained(), ...patch }], ownerId, accountKey)
    ).toBeUndefined();
  });
  it('网页直连使用既有本任务回调，写目标和原窗口绑定而不写已登录状态', async () => {
    const f = restoreFixture();
    await expect(
      f.local.callback(currentId, 'other-task-token', { type: 'restore', accountKey })
    ).rejects.toThrow('本机连接凭据无效');
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    expect(
      await f.local.callback(currentId, f.agentToken, { type: 'restore', accountKey })
    ).toEqual({
      records: [],
      staleProfiles: [],
      ownedProfile: owned
    });
    expect(f.job).toMatchObject({ accountKey, result: { browser_profile_id: profileId } });
    expect(f.job.result).not.toHaveProperty('account_matched');
    expect(f.job.result.payment_requests_sent).toBe(0);
    await expect(
      f.local.callback(currentId, f.agentToken, { type: 'restore', accountKey: 'c'.repeat(64) })
    ).rejects.toThrow('账户标识不一致');
  });
  it.each([undefined, ''])('失败回执缺失或清空窗口字段仍保留原绑定（%s）', async (value) => {
    const f = restoreFixture();
    await f.service.callback(currentId, { type: 'restore', accountKey });
    await f.service.callback(currentId, {
      type: 'finished',
      result: {
        status: 'blocked',
        reason: 'owned_recharge_window_unavailable',
        browser_profile_id: value,
        payment_requests_sent: 0
      }
    });
    expect(f.job).toMatchObject({
      state: 'finished',
      nonceHash: null,
      accountKey,
      result: { browser_profile_id: profileId, payment_requests_sent: 0 }
    });
  });
  it('已绑定当前窗口不能被历史结果或后续新窗口回执覆盖', async () => {
    const f = restoreFixture();
    f.job.result.browser_profile_id = 'c'.repeat(32);
    await expect(f.service.callback(currentId, { type: 'restore', accountKey })).rejects.toThrow(
      '不能覆盖原窗口'
    );
    expect(f.repository.updateJob).not.toHaveBeenCalled();
    await expect(
      f.service.callback(currentId, {
        type: 'progress',
        result: { browser_profile_id: profileId }
      })
    ).rejects.toThrow('不能更换窗口');
    expect(f.job.result.browser_profile_id).toBe('c'.repeat(32));
  });
  it('已建单后停止任务，再执行仍返回原窗口和原单，旧任务凭据失效', async () => {
    const f = restoreFixture();
    const original = {
      ownerId,
      accountKey,
      fileKey: `${accountKey}.json`,
      revision: 7,
      document: {
        checkout_identifier: 'cs_original',
        checkout_outcome: 'created',
        target_plan: 'plus',
        payment_status: 'not_attempted',
        payment_attempted: false,
        confirmation_requests_sent: 0
      }
    };
    const before = structuredClone(original);
    const records = {
      findUnique: vi.fn().mockResolvedValue(original),
      findMany: vi.fn().mockResolvedValue([original]),
      update: vi.fn(),
      upsert: vi.fn()
    };
    const realRepository = new RechargeRepository({} as never);
    const inspect = vi.fn((_tx, key, plan, operator) =>
      realRepository.inspectStoppedCheckout(
        { idBusinessV2RechargeRecord: records } as never,
        key,
        plan,
        operator
      )
    );
    Object.assign(f.repository, { inspectStoppedCheckout: inspect });
    f.repository.records.mockResolvedValue([original]);
    f.job.result.mode = 'payment';
    await f.local.callback(currentId, f.agentToken, { type: 'restore', accountKey });
    await f.local.callback(currentId, f.agentToken, {
      type: 'finished',
      result: {
        status: 'cancelled',
        reason: 'operation_cancelled',
        cancellation_confirmed: true,
        browser_cleanup_status: 'not_needed',
        confirmation_requests_sent: 0,
        payment_requests_sent: 0,
        payment_attempted: false
      }
    });
    expect(f.job).toMatchObject({
      state: 'finished',
      nonceHash: null,
      result: { status: 'cancelled', browser_profile_id: profileId }
    });
    expect(await inspect.mock.results[0].value).toBe(true);
    expect(original).toEqual(before);
    expect(records.update).not.toHaveBeenCalled();
    expect(records.upsert).not.toHaveBeenCalled();
    await expect(
      f.local.callback(currentId, f.agentToken, { type: 'progress', result: {} })
    ).rejects.toThrow('本机连接凭据无效');
    const nextId = '77777777-7777-4777-8777-777777777777';
    const nextToken = 'synthetic-next-task-token';
    const next = {
      ...f.job,
      id: nextId,
      state: 'running',
      nonceHash: hash(nextToken),
      result: { mode: 'payment', payment_requests_sent: 0 }
    };
    f.repository.active.mockResolvedValue(next);
    f.repository.byId.mockResolvedValue(next);
    f.repository.finishedJobsForAccount.mockResolvedValue([f.job] as never);
    f.repository.retainedProfileForAccount.mockResolvedValue({
      sourceJobId: currentId,
      profileId,
      accountKey
    });
    f.repository.updateJob.mockImplementation(async (_tx, _id, change) =>
      Object.assign(next, change)
    );
    await expect(
      f.local.callback(nextId, f.agentToken, { type: 'restore', accountKey })
    ).rejects.toThrow('本机连接凭据无效');
    expect(await f.local.callback(nextId, nextToken, { type: 'restore', accountKey })).toEqual({
      records: [before],
      staleProfiles: [],
      ownedProfile: { sourceJobId: currentId, profileId, accountKey },
      originalCheckoutIdentifier: 'cs_original'
    });
    expect(original).toEqual(before);
  });
  it('选定已核实账号的手动充值启动复用失败窗口，并仅传已保存代理国家', async () => {
    const f = restoreFixture();
    const accountId = '44444444-4444-4444-8444-444444444444';
    const proxyId = '55555555-5555-4555-8555-555555555555';
    const addressId = '66666666-6666-4666-8666-666666666666';
    const repository = {
      ...f.repository,
      findJob: vi.fn().mockResolvedValue(null),
      findRunningJob: vi.fn().mockResolvedValue(null),
      createJob: vi.fn(async (_tx, data) => data)
    };
    const runtime = {
      connectorUrl: 'http://127.0.0.1:55322',
      connectorToken: '',
      localApiUrl: 'http://127.0.0.1:54345',
      localApiToken: '',
      groupName: 'synthetic-group',
      tagName: 'synthetic-tag',
      proxyType: 'http',
      dynamicProxyUrl: ''
    };
    const service = new RechargeLocalService(
      repository as never,
      {
        requireAvailable: vi.fn().mockResolvedValue({
          id: addressId,
          line1: 'Synthetic address',
          country: 'US',
          city: 'Portland',
          state: 'OR',
          postalCode: '97204'
        })
      } as never,
      { runtime: vi.fn().mockResolvedValue(runtime) } as never,
      f.service,
      { execute: vi.fn(async (work) => work({})) } as never,
      { append: vi.fn() } as never,
      {
        requireCurrency: vi.fn(),
        requireRechargeInspection: vi.fn().mockResolvedValue({
          id: accountId,
          officialAccountKey: accountKey
        })
      } as never,
      undefined,
      {
        forCharge: vi.fn().mockResolvedValue({
          id: proxyId,
          countryCode: 'PH',
          mode: 'dynamic',
          type: 'http',
          extractionUrl: 'https://proxy.example.invalid/synthetic'
        })
      } as never
    );
    const input = {
      id: currentId,
      plan: 'plus',
      chatgptAccountId: accountId,
      addressId,
      proxyId,
      proxyCountryCode: 'PH',
      windowName: 'Synthetic task',
      lockedCurrency: 'PHP',
      authorizeSinglePayment: true
    };
    const launch = await service.start(input, {
      id: ownerId,
      username: 'synthetic',
      roles: [],
      permissions: [],
      displayName: '测试'
    });
    expect(launch.ownedProfile).toEqual(owned);
    expect(launch.bitBrowser.expectedCountryCode).toBe('PH');
    expect(repository.createJob.mock.calls[0][1]).toMatchObject({
      accountKey,
      result: { browser_profile_id: profileId, payment_requests_sent: 0 }
    });
    repository.createJob.mockClear();
    repository.retainedProfileForAccount.mockImplementation(async () =>
      findRetainedRechargeBrowserProfile(
        [
          {
            ...retained(),
            result: { ...retained().result, browser_cleanup_status: 'completed' }
          }
        ],
        ownerId,
        accountKey
      )
    );
    await expect(
      service.start(input, {
        id: ownerId,
        username: 'synthetic',
        roles: [],
        permissions: [],
        displayName: '测试'
      })
    ).rejects.toThrow('原比特浏览器资料已被删除');
    expect(repository.createJob).not.toHaveBeenCalled();
  });
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
      retainedProfileForAccount: vi.fn().mockResolvedValue(owned),
      originalCheckoutForAccount: vi.fn().mockResolvedValue(undefined),
      restoreCheckoutIdentifier: new RechargeRepository({} as never).restoreCheckoutIdentifier,
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
    expect(repository.retainedProfileForAccount).toHaveBeenCalledWith(
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
