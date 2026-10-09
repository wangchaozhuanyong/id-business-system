import { describe, expect, it, vi } from 'vitest';
import { RechargeService } from './recharge.service';
import { RechargeRepository } from './persistence/recharge.repository';

const ownerId = 'synthetic-owner';
const accountKey = 'a'.repeat(64);
const profileId = 'b'.repeat(32);
const id = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const loginId = '33333333-3333-4333-8333-333333333333';
const source = () => ({
  id: sourceId,
  ownerId,
  accountKey,
  action: 'bitbrowser',
  state: 'finished',
  plan: 'plus',
  result: {
    browser_profile_id: profileId,
    checkout_identifier: 'cs_original',
    checkout_requests_sent: 1,
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0
  } as Record<string, unknown>
});
const originalRecord = () => ({
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
  } as Record<string, unknown>
});

function fixture(history = [source()], records = [originalRecord()]) {
  const latestLogin = {
    ...source(),
    id: loginId,
    result: { mode: 'open_browser', browser_profile_id: profileId }
  };
  const job = {
    id,
    ownerId,
    accountKey: null,
    action: 'bitbrowser',
    state: 'running',
    plan: 'plus',
    result: { mode: 'payment', payment_requests_sent: 0 } as Record<string, unknown>
  };
  const table = {
    findMany: vi.fn(async (query) => (query.where.plan ? history : [latestLogin, ...history])),
    update: vi.fn(async ({ data }) => Object.assign(job, data))
  };
  const ledger = {
    findMany: vi.fn().mockResolvedValue(records),
    findUnique: vi.fn().mockResolvedValue(records[0]),
    update: vi.fn(),
    upsert: vi.fn()
  };
  const repository = new RechargeRepository({} as never);
  vi.spyOn(repository, 'lock').mockResolvedValue();
  vi.spyOn(repository, 'active').mockResolvedValue(job as never);
  const service = new RechargeService(
    repository,
    {} as never,
    {
      execute: vi.fn(async (work) =>
        work({ idBusinessV2RechargeJob: table, idBusinessV2RechargeRecord: ledger })
      )
    } as never,
    { append: vi.fn() } as never
  );
  return { service, job, table, ledger, records };
}

describe('手动重试的原结算恢复合同', () => {
  it('较新的仅登录绑定保留原窗口，同套餐可信源与原账本共同返回原结算编号', async () => {
    const f = fixture();
    const before = structuredClone(f.records);
    expect(await f.service.callback(id, { type: 'restore', accountKey })).toEqual({
      records: before,
      staleProfiles: [],
      ownedProfile: { sourceJobId: loginId, profileId, accountKey },
      originalCheckoutIdentifier: 'cs_original'
    });
    expect(f.job.result).toMatchObject({
      browser_profile_id: profileId,
      checkout_identifier: 'cs_original',
      payment_requests_sent: 0
    });
    expect(f.records).toEqual(before);
    expect(f.ledger.update).not.toHaveBeenCalled();
    expect(f.ledger.upsert).not.toHaveBeenCalled();
  });

  it('可信源任务有原编号而账本缺失时拒绝恢复，不能变成建新单', async () => {
    const f = fixture([source()], []);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单持久化记录缺失'
    );
    expect(f.table.update).not.toHaveBeenCalled();
    expect(f.ledger.upsert).not.toHaveBeenCalled();
  });

  it('来源编号与原账本不一致时拒绝恢复', async () => {
    const record = originalRecord();
    record.document.checkout_identifier = 'oaics_other';
    const f = fixture([source()], [record]);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号不一致'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it('当前任务已绑定原编号时即使历史为空也不能绕过缺失账本', async () => {
    const f = fixture([], []);
    f.job.result.checkout_identifier = 'cs_original';
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单持久化记录缺失'
    );
  });

  it('有建单请求但尚无可核实编号的历史停止，不允许新建', async () => {
    const history = source();
    delete history.result.checkout_identifier;
    const f = fixture([history], []);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号未核实'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it('即使来源任务没有编号，原账本仍能绑定原单且不重写付款事实', async () => {
    const record = originalRecord();
    record.document.payment_status = 'unknown';
    record.document.payment_attempted = true;
    record.document.confirmation_requests_sent = 1;
    const f = fixture([], [record]);
    const before = structuredClone(record);
    const restored = await f.service.callback(id, { type: 'restore', accountKey });
    expect(restored).toMatchObject({
      originalCheckoutIdentifier: 'cs_original',
      records: [before]
    });
    expect(record).toEqual(before);
    expect(f.ledger.update).not.toHaveBeenCalled();
  });

  it('升级操作只保留自己的付款记录，不混用 checkout 编号', async () => {
    const history = source();
    history.result = {
      browser_profile_id: profileId,
      operation: 'subscription_upgrade',
      upgrade_identifier: `upg_${'c'.repeat(32)}`,
      current_plan_before: 'go',
      target_plan: 'plus'
    };
    const record = {
      ...originalRecord(),
      fileKey: `payments/${'d'.repeat(64)}.json`,
      document: { ...history.result, payment_status: 'unknown', payment_attempted: true }
    };
    const f = fixture([history], [record]);
    const restored = await f.service.callback(id, { type: 'restore', accountKey });
    expect(restored).not.toHaveProperty('originalCheckoutIdentifier');
    expect(restored).toMatchObject({ records: [record] });
  });

  it('仅登录恢复不取得原单付款能力，也不因原订单记录缺失阻止只读登录', async () => {
    const f = fixture([source()], []);
    f.job.result.mode = 'open_browser';
    const restored = await f.service.callback(id, { type: 'restore', accountKey });
    expect(restored).not.toHaveProperty('originalCheckoutIdentifier');
    expect(f.table.findMany).toHaveBeenCalledTimes(1);
    expect(f.job.result).not.toHaveProperty('checkout_identifier');
  });

  it('比特执行的真实账本回调也拒绝显式重建原单', async () => {
    const f = fixture();
    await f.service.callback(id, { type: 'restore', accountKey });
    await expect(
      f.service.callback(id, {
        type: 'ledger',
        accountKey,
        fileKey: `${accountKey}.json`,
        revision: 7,
        document: {
          status: 'checkout_attempted',
          stage: 'checkout_create',
          checkout_outcome: 'unknown',
          payment_status: 'not_attempted',
          retry_of: 'd'.repeat(64)
        }
      })
    ).rejects.toThrow('原订单编号不可更换');
    expect(f.ledger.upsert).not.toHaveBeenCalled();
  });
});
