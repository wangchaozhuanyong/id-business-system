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
    findUnique: vi.fn(async () => job),
    findFirst: vi.fn().mockResolvedValue(null),
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

function unpaidReplacementFixture() {
  const historical = source();
  historical.result = {
    browser_profile_id: profileId,
    checkout_identifier: 'cs_original',
    status: 'blocked',
    reason: 'browser_operation_failed',
    stage: 'session_restore',
    account_matched: false,
    checkout_requests_sent: 0,
    payment_attempted: false,
    payment_requests_sent: 0,
    payment_status: 'not_attempted'
  };
  const record = originalRecord();
  record.document = {
    ...record.document,
    status: 'cancelled',
    checkout_identifier: 'cs_current_unpaid',
    checkout_outcome: 'cancelled',
    cancelled_before_confirmation: true,
    payment_requests_sent: 0,
    checkout_requests_sent: 1,
    three_ds_status: 'not_required',
    // 客户端提供的旧字节hash不是历史资格证明。
    retry_of: 'd'.repeat(64)
  };
  const history = [historical];
  return { ...fixture(history, [record]), history, historical, record };
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

  it('旧登录恢复失败引用在当前安全取消原单之后恢复现编号，重放不回退或改写历史', async () => {
    const f = unpaidReplacementFixture();
    const before = structuredClone({ history: f.history, records: f.records });
    expect(await f.service.callback(id, { type: 'restore', accountKey })).toMatchObject({
      originalCheckoutIdentifier: 'cs_current_unpaid'
    });
    expect(f.job.result.checkout_identifier).toBe('cs_current_unpaid');
    expect(await f.service.callback(id, { type: 'restore', accountKey })).toMatchObject({
      originalCheckoutIdentifier: 'cs_current_unpaid'
    });
    expect({ history: f.history, records: f.records }).toEqual(before);
    expect(f.ledger.update).not.toHaveBeenCalled();
    expect(f.ledger.upsert).not.toHaveBeenCalled();
  });

  it('真实首次start没有mode字段，旧助手首restore仍能恢复当前安全取消原单', async () => {
    const f = unpaidReplacementFixture();
    f.job.result = {
      status: 'waiting_local_connector',
      stage: 'connector_dispatch',
      window_name: 'synthetic-window',
      locked_currency: 'USD',
      manual_payment_confirmation: true,
      payment_requests_sent: 0
    };
    await expect(f.service.callback(id, { type: 'restore', accountKey })).resolves.toMatchObject({
      originalCheckoutIdentifier: 'cs_current_unpaid'
    });
    expect(f.job.result).not.toHaveProperty('mode');
    expect(f.ledger.upsert).not.toHaveBeenCalled();
  });

  it('旧报价读取失败可兼容缺省确认计数，但不同更老原单仍逐一核实', async () => {
    const f = unpaidReplacementFixture();
    const older = source();
    older.id = '44444444-4444-4444-8444-444444444444';
    older.result = {
      ...f.historical.result,
      checkout_identifier: 'cs_older',
      checkout_requests_sent: 1,
      stage: 'quote_read',
      reason: 'actual_quote_unknown',
      account_matched: true,
      quote: { plan: 'plus' }
    };
    f.history.push(older);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).resolves.toMatchObject({
      originalCheckoutIdentifier: 'cs_current_unpaid'
    });
  });

  it.each([
    { cancelled_before_confirmation: undefined },
    { confirmation_requests_sent: undefined },
    { confirmation_requests_sent: 1 },
    { payment_requests_sent: 1 },
    { payment_attempted: true },
    { payment_status: 'unknown' },
    { checkout_outcome: 'unknown' },
    { manual_confirmation_accepted: true },
    { payment_evidence: { kind: 'payment_intent', identifier: 'pi_unknown' } },
    { three_ds_status: 'requires_action' }
  ])('当前根存在风险或缺少严格取消证明时不能只凭retry_of忽略旧引用：%j', async (patch) => {
    const f = unpaidReplacementFixture();
    Object.assign(f.record.document, patch);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号不一致'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it.each([
    { stage: 'payment_preparation' },
    { stage: 'unknown' },
    { confirmation_requests_sent: null },
    { confirmation_requests_sent: 1 },
    { payment_requests_sent: undefined },
    { payment_requests_sent: 1 },
    { payment_attempted: true },
    { payment_status: 'unknown' },
    { manual_confirmation_accepted: true },
    { request_attempt_key: 'ambiguous' },
    { checkout_requests_sent: 'unknown' },
    { target_plan: 'pro-20x' },
    { payment_evidence: { kind: 'payment_intent', identifier: 'pi_unknown' } },
    { account_matched: true },
    { quote: { plan: 'plus' } }
  ])('旧来源缺省确认只有明确未进入付款的协议形状可以恢复：%j', async (patch) => {
    const f = unpaidReplacementFixture();
    Object.assign(f.historical.result, patch);
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号不一致'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it('当前任务已经绑定不同编号仍拒绝，不能以安全历史替换当前绑定', async () => {
    const f = unpaidReplacementFixture();
    f.job.result.checkout_identifier = 'cs_bound_to_this_job';
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号不一致'
    );
    expect(f.table.findMany).toHaveBeenCalledTimes(1);
    expect(f.table.findMany.mock.calls[0]![0].where).not.toHaveProperty('plan');
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it.each([{ checkout_requests_sent: '0' }, { confirmation_requests_sent: null }])(
    '当前任务未知类型请求计数不能取得旧引用恢复资格：%j',
    async (patch) => {
      const f = unpaidReplacementFixture();
      Object.assign(f.job.result, patch);
      await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
        '原订单编号不一致'
      );
      expect(f.table.update).not.toHaveBeenCalled();
    }
  );

  it('同套餐付款marker存在时，即使count0也不获得历史替换恢复资格', async () => {
    const f = unpaidReplacementFixture();
    f.records.push({
      ...f.record,
      fileKey: `payments/${'e'.repeat(64)}.json`,
      document: {
        checkout_identifier: 'cs_current_unpaid',
        target_plan: 'plus',
        payment_status: 'cancelled',
        payment_attempted: true,
        confirmation_requests_sent: 0
      }
    });
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号不一致'
    );
  });

  it('更老来源的确认风险仍阻止恢复，不能只跳过最新安全来源', async () => {
    const f = unpaidReplacementFixture();
    f.history.push({
      ...source(),
      id: '44444444-4444-4444-8444-444444444444',
      result: {
        ...f.historical.result,
        checkout_identifier: 'cs_older_unknown',
        confirmation_requests_sent: 1,
        payment_status: 'unknown'
      }
    });
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '历史付款状态未核实'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it('更早有原编号而任务尚未结束时，不能假定过期任务是安全旧引用', async () => {
    const f = unpaidReplacementFixture();
    f.history.push({
      ...source(),
      id: '44444444-4444-4444-8444-444444444444',
      state: 'awaiting_confirmation',
      result: {
        ...f.historical.result,
        checkout_identifier: 'cs_unfinished',
        confirmation_requests_sent: 0
      }
    });
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '历史付款状态未核实'
    );
    expect(f.table.findMany.mock.calls.at(-1)![0].where).not.toHaveProperty('state');
    expect(f.table.update).not.toHaveBeenCalled();
  });

  it('替换后的未知建单没有可核实编号时继续拒绝，不会从旧job拼回编号', async () => {
    const f = unpaidReplacementFixture();
    delete f.record.document.checkout_identifier;
    f.record.document.checkout_outcome = 'unknown';
    await expect(f.service.callback(id, { type: 'restore', accountKey })).rejects.toThrow(
      '原订单编号未核实'
    );
    expect(f.table.update).not.toHaveBeenCalled();
  });
});
