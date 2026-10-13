import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeNextCyclePreparationResult } from '@apple-business/shared';
import { cycleFixture, cyclePaidDocument } from './recharge-cycle-test-fixture';
import { readCycleState, cycleSources, automaticallyEnded } from './recharge-cycle-state';
import { object } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';

type Fixture = ReturnType<typeof cycleFixture>;
const inspect = (f: Fixture, patch = {}) =>
  f.prepare('inspect', {
    subscription_inspection: f.inspection(patch)
  }) as Promise<V2RechargeNextCyclePreparationResult>;
async function commit(f: Fixture) {
  const review = readCycleState(f.job)!.review;
  return f.prepare('commit', {
    reviewDigest: review.reviewDigest,
    subscription_inspection: f.inspection({ checked_at: new Date().toISOString() })
  }) as Promise<V2RechargeNextCyclePreparationResult>;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('原账户下一订阅周期资格与一次建单事务', () => {
  it('旧官方账期确证结束且Free/明确无订阅时自动核实；inspect/status不改原记录、不续租约', async () => {
    const f = cycleFixture(),
      before = structuredClone(f.records),
      lease = f.job.leaseUntil;
    const result = await inspect(f);
    expect(result.cycleReview.status).toBe('ready');
    expect(result).not.toHaveProperty('nextCycleContext');
    expect(readCycleState(f.job)?.grant).toBeUndefined();
    await f.prepare('status', { reviewDigest: result.cycleReview.reviewDigest });
    expect(f.records).toEqual(before);
    expect(f.job.leaseUntil).toEqual(lease);
  });
  it('cycle review进度也不续joblease，人工核实预算独立保持5分钟', async () => {
    const f = cycleFixture(false),
      lease = f.job.leaseUntil;
    await inspect(f);
    vi.advanceTimersByTime(60000);
    await f.callback({
      type: 'progress',
      result: {
        status: 'running',
        stage: 'next_subscription_cycle_review',
        payment_attempted: false,
        payment_requests_sent: 0,
        user_action_required: true
      }
    });
    expect(f.job.leaseUntil).toEqual(lease);
    expect(Date.parse(readCycleState(f.job)!.review.expiresAt)).toBe(Date.now() + 4 * 60000);
  });
  it('commit必须第二次fresh核实，归档原证据且仅授一次建单；不能授权付款', async () => {
    const f = cycleFixture();
    await inspect(f);
    await expect(
      f.prepare('commit', {
        reviewDigest: readCycleState(f.job)!.review.reviewDigest,
        subscription_inspection: f.inspection()
      })
    ).rejects.toThrow('重新读取');
    const result = await commit(f);
    expect(result.nextCycleContext?.grant?.status).toBe('granted');
    expect(result.nextCycleContext?.grant?.targetPlan).toBe('plus');
    expect(object(f.job.result).payment_attempted).toBe(false);
    const archives = f.records.filter((record) => record.fileKey.startsWith('history/'));
    expect(archives).toHaveLength(1);
    expect(archives[0]!.fileKey).toHaveLength(77);
    expect(archives[0]!.document).toEqual(f.document);
    for (const record of f.records.filter((record) => !record.fileKey.startsWith('history/'))) {
      expect(record.document).toMatchObject({
        ...f.document,
        cycle_resolution: { status: 'closed' }
      });
    }
  });
  it('无官方旧期末时仅原owner明确核实一次，再fresh才能commit', async () => {
    const f = cycleFixture(false);
    const result = await inspect(f);
    expect(result.cycleReview.status).toBe('awaiting_previous_cycle_confirmation');
    const input = {
      reviewDigest: result.cycleReview.reviewDigest,
      confirmedPreviousCycleEnded: true
    };
    await expect(
      f.local.confirmNextCycle(f.id, input, { ...f.operator, id: 'other' } as never)
    ).rejects.toThrow('无权');
    await f.local.confirmNextCycle(f.id, input, f.operator as never);
    await f.local.confirmNextCycle(f.id, input, f.operator as never);
    expect(
      f.audit.append.mock.calls.filter((call) =>
        (call[1] as { action: string }).action.endsWith('confirm_previous')
      )
    ).toHaveLength(1);
    expect((await commit(f)).nextCycleContext?.grant?.status).toBe('granted');
  });
  it.each([
    { current_plan: 'plus', has_active_subscription: true },
    { has_active_subscription: null },
    { current_plan: 'go', has_active_subscription: false }
  ])('不把缺字段或活跃/其他套餐当Free资格：%j', async (patch) => {
    const f = cycleFixture();
    const before = structuredClone(f.records);
    const result = await inspect(f, patch);
    expect(result.cycleReview.status).toBe('revoked');
    expect(f.records).toEqual(before);
    await expect(
      f.local.confirmNextCycle(
        f.id,
        { reviewDigest: result.cycleReview.reviewDigest, confirmedPreviousCycleEnded: true },
        f.operator as never
      )
    ).rejects.toThrow();
  });
  it('fresh官方未来账期覆盖旧过期记录，inspect不提供manual、commit撤销资格', async () => {
    const f = cycleFixture();
    const future = {
      ...object(f.document.subscription_period),
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date(Date.now() + 86400000).toISOString()
    };
    expect((await inspect(f, { previous_period: future })).cycleReview.status).toBe('revoked');
    const g = cycleFixture();
    await inspect(g);
    const result = (await g.prepare('commit', {
      reviewDigest: readCycleState(g.job)!.review.reviewDigest,
      subscription_inspection: g.inspection({
        checked_at: new Date().toISOString(),
        previous_period: {
          ...object(g.document.subscription_period),
          start: new Date(Date.now() - 86400000).toISOString(),
          end: new Date(Date.now() + 86400000).toISOString()
        }
      })
    })) as V2RechargeNextCyclePreparationResult;
    expect(result.cycleReview.status).toBe('revoked');
    expect(readCycleState(g.job)?.grant).toBeUndefined();
  });
  it('missing旧period时fresh官方future仍不能人工覆盖', async () => {
    const f = cycleFixture(false);
    const future = {
      source: 'official_subscription_response',
      account_key: f.accountKey,
      target_plan: 'plus',
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date(Date.now() + 86400000).toISOString()
    };
    expect((await inspect(f, { previous_period: future })).cycleReview.status).toBe('revoked');
  });
  it.each([
    { status: 'payment_result_unknown' },
    { subscription_status: 'matched' },
    { current_plan: 'free' },
    { quote_digest: 'a'.repeat(64) },
    { payment_status: 'unknown' }
  ])('付款未完整激活或原报价不符不能close：%j', (patch) => {
    const f = cycleFixture();
    Object.assign(object(f.records[1]!.document), patch);
    expect(() => cycleSources(f.records, f.job)).toThrow('只能复查');
  });
  it('全账号其他套餐的未知账本也阻止新周期，不能通过切套餐绕过', async () => {
    const f = cycleFixture();
    const unknown = cyclePaidDocument(f.accountKey, 'cs_unknown');
    unknown.payment_status = 'unknown';
    unknown.target_plan = 'go';
    f.records.push({
      ...f.records[1]!,
      fileKey: 'payments/' + 'c'.repeat(64) + '.json',
      document: unknown
    });
    await expect(inspect(f)).rejects.toThrow('只能复查');
  });
  it('安全取消零付款和完整server no-bank处理保持原证据，并不误报未知', () => {
    const f = cycleFixture();
    f.records.push({
      ...f.records[1]!,
      fileKey: 'payments/' + 'c'.repeat(64) + '.json',
      document: {
        cancelled_before_confirmation: true,
        payment_status: 'cancelled',
        confirmation_requests_sent: 0
      }
    });
    f.records.push({
      ...f.records[1]!,
      fileKey: 'payments/' + 'd'.repeat(64) + '.json',
      document: {
        operator_resolution: 'confirmed_no_bank_request',
        resolved_at: new Date().toISOString(),
        resolution_job_id: f.id,
        source_job_id: f.id,
        verification_job_id: f.id,
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1
      }
    });
    expect(cycleSources(f.records, f.job)).toHaveLength(2);
  });
  it('客户端不能伪造close/origin或直接写history归档', async () => {
    const f = cycleFixture();
    await expect(
      f.callback({ type: 'progress', result: { cycle_resolution: { status: 'closed' } } })
    ).rejects.toThrow('不可写入');
    await expect(
      f.callback({
        type: 'ledger',
        accountKey: f.accountKey,
        fileKey: 'history/' + 'a'.repeat(64) + '.json',
        revision: 0,
        document: {}
      })
    ).rejects.toThrow('记录无效');
  });
  it('普通ledger不能伪造或更改server no-bank处理标记', async () => {
    const f = cycleFixture();
    const payment = f.records[1]!;
    const incoming = {
      ...object(payment.document),
      operator_resolution: 'confirmed_no_bank_request',
      resolved_at: new Date().toISOString(),
      resolution_job_id: f.id,
      source_job_id: f.id,
      verification_job_id: f.id
    };
    await expect(
      f.callback({
        type: 'ledger',
        accountKey: f.accountKey,
        fileKey: payment.fileKey,
        revision: payment.revision,
        document: incoming
      })
    ).rejects.toThrow('只能由服务端写入');
    expect(f.recordTable.upsert).not.toHaveBeenCalled();
  });
  it('合法server no-bank metadata原样保留，省略也可精确CAS重放；新marker不继承旧处理', async () => {
    const f = cycleFixture();
    const record = f.records[1]!;
    const previous = object(record.document);
    Object.assign(previous, {
      operator_resolution: 'confirmed_no_bank_request',
      resolved_at: new Date().toISOString(),
      resolution_job_id: f.id,
      source_job_id: f.id,
      verification_job_id: f.id
    });
    const beforeRevision = record.revision;
    const next: Record<string, unknown> = { ...previous, stage: 'synthetic_recheck' };
    for (const key of [
      'operator_resolution',
      'resolved_at',
      'resolution_job_id',
      'source_job_id',
      'verification_job_id'
    ])
      delete next[key];
    const input = {
      accountKey: f.accountKey,
      ownerId: f.ownerId,
      fileKey: record.fileKey,
      revision: beforeRevision,
      document: next
    };
    expect(await f.repository.saveRecord(f.tx as never, input)).toEqual({
      revision: beforeRevision + 1
    });
    expect(record.document).toHaveProperty('operator_resolution', 'confirmed_no_bank_request');
    expect(await f.repository.saveRecord(f.tx as never, input)).toEqual({
      revision: beforeRevision + 1,
      replayed: true
    });
    const bad = {
      ...input,
      revision: record.revision,
      document: { ...next, source_job_id: '00000000-0000-4000-8000-000000000000' }
    };
    await expect(f.repository.saveRecord(f.tx as never, bad)).rejects.toThrow('不能伪造或变更');
  });
  it('首marker与消费同事务：内容重放只ack replayed，第二operation不保存', async () => {
    const f = cycleFixture();
    await inspect(f);
    await commit(f);
    const marker = f.marker();
    const result = await f.callback(marker);
    expect(result).toEqual({ revision: 4 });
    expect(readCycleState(f.job)?.grant?.status).toBe('consumed');
    expect(await f.callback(marker)).toEqual({ revision: 4, replayed: true });
    const bad = structuredClone(marker);
    bad.document.run_id = 'b'.repeat(32);
    await expect(f.callback(bad)).rejects.toThrow('只能恢复');
    expect(f.recordTable.upsert).toHaveBeenCalledTimes(1);
    expect(
      object(f.records.find((record) => record.fileKey === f.accountKey + '.json')!.document)
    ).toHaveProperty('cycle_origin');
  });
  it('归档后首marker前崩溃且grant过期，fresh重审复用conversion且不重做manual/归档', async () => {
    const f = cycleFixture(false);
    const review = (await inspect(f)).cycleReview;
    await f.local.confirmNextCycle(
      f.id,
      { reviewDigest: review.reviewDigest, confirmedPreviousCycleEnded: true },
      f.operator as never
    );
    await commit(f);
    const archives = f.recordTable.create.mock.calls.length;
    vi.advanceTimersByTime(6 * 60000);
    const restored = await f.callback({
      type: 'restore',
      accountKey: f.accountKey,
      subscriptionCycleProtocol: 1
    });
    expect(restored).toHaveProperty('nextCycleContext');
    expect(restored).not.toHaveProperty('nextCycleContext.grant');
    const fresh = await inspect(f);
    expect(fresh.nextCycleContext?.grant?.reviewDigest).toBe(review.reviewDigest);
    expect(Date.parse(fresh.nextCycleContext!.grant!.expiresAt)).toBeGreaterThan(Date.now());
    expect(f.recordTable.create.mock.calls.length).toBe(archives);
    expect(readCycleState(f.job)?.manualConfirmed).toBe(true);
    await f.callback(f.marker());
    expect(f.recordTable.upsert).toHaveBeenCalledTimes(1);
  });
  it('首marker后崩溃：恢复同一未知操作，不再grant第二create', async () => {
    const f = cycleFixture();
    await inspect(f);
    await commit(f);
    await f.callback(f.marker());
    const restored = await f.callback({
      type: 'restore',
      accountKey: f.accountKey,
      subscriptionCycleProtocol: 1
    });
    expect(restored).toHaveProperty('nextCycleContext.grant.status', 'consumed');
    const replay = await inspect(f);
    expect(replay.cycleReview.status).toBe('consumed');
    expect(replay.nextCycleContext?.grant?.status).toBe('consumed');
    const g = cycleFixture();
    g.records.splice(
      0,
      g.records.length,
      ...structuredClone(f.records).map((record) => ({
        ...record,
        ownerId: g.ownerId,
        accountKey: g.accountKey
      }))
    );
    expect(() => cycleSources(f.records, f.job)).toThrow('未完成');
    expect(f.recordTable.upsert).toHaveBeenCalledTimes(1);
  });
  it('source CAS变化或archive写入审计失败不发grant，原付款事实保留', async () => {
    const f = cycleFixture();
    await inspect(f);
    f.records[1]!.revision += 1;
    await expect(commit(f)).rejects.toThrow('原付款记录已经变化');
    const g = cycleFixture();
    await inspect(g);
    const before = structuredClone(g.records);
    g.audit.append.mockRejectedValueOnce(new Error('synthetic audit rollback'));
    await expect(commit(g)).rejects.toThrow('synthetic audit rollback');
    expect(g.records).toEqual(before);
    expect(readCycleState(g.job)?.grant).toBeUndefined();
  });
  it('协议握手必须client+helper同时1，旧组合不获得下一周期能力', async () => {
    const f = cycleFixture();
    delete object(f.job.result).client_cycle_protocol;
    expect(
      await f.callback({ type: 'restore', accountKey: f.accountKey, subscriptionCycleProtocol: 1 })
    ).not.toHaveProperty('nextCycleContext');
    await expect(inspect(f)).rejects.toThrow('共同支持');
    object(f.job.result).client_cycle_protocol = 1;
    expect(await f.callback({ type: 'restore', accountKey: f.accountKey })).not.toHaveProperty(
      'nextCycleContext'
    );
    expect(
      await f.callback({ type: 'restore', accountKey: f.accountKey, subscriptionCycleProtocol: 1 })
    ).toHaveProperty('nextCycleContext');
  });
  it('只读旧paid绑定或granted未marker取消只结束当前任务，不清零旧付款或窗口', async () => {
    const f = cycleFixture();
    await f.callback({ type: 'restore', accountKey: f.accountKey, subscriptionCycleProtocol: 1 });
    await inspect(f);
    await commit(f);
    const before = structuredClone(f.records);
    await f.local.cancel(f.id, f.operator as never);
    expect(readCycleState(f.job)?.grant).toBeUndefined();
    await f.callback({
      type: 'finished',
      result: {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }
    });
    expect(f.job.state).toBe('finished');
    expect(f.records).toEqual(before);
    expect(readCycleState(f.job)?.review.status).toBe('revoked');
  });
  it('首marker保存后即使0次付款取消也不能撤消费事实或获得第二grant', async () => {
    const f = cycleFixture();
    await inspect(f);
    await commit(f);
    await f.callback(f.marker());
    await f.local.cancel(f.id, f.operator as never);
    expect(readCycleState(f.job)?.grant?.status).toBe('consumed');
    await f.callback({
      type: 'finished',
      result: {
        status: 'cancelled',
        cancellation_confirmed: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }
    });
    expect(readCycleState(f.job)?.grant?.status).toBe('consumed');
    await expect(inspect(f)).rejects.toThrow('执行窗口已结束');
    expect(() => cycleSources(f.records, f.job)).toThrow('未完成');
  });
  it('first-marker未知不能靠后来的零次取消ledger变成第二次周期资格', async () => {
    const f = cycleFixture();
    await inspect(f);
    await commit(f);
    await f.callback(f.marker());
    const record = f.records.find((item) => item.fileKey === f.accountKey + '.json')!;
    await f.callback({
      type: 'ledger',
      accountKey: f.accountKey,
      fileKey: record.fileKey,
      revision: record.revision,
      document: {
        status: 'cancelled',
        checkout_outcome: 'cancelled',
        cancelled_before_confirmation: true,
        payment_status: 'not_attempted',
        payment_attempted: false,
        confirmation_requests_sent: 0,
        target_plan: 'plus'
      }
    });
    expect(record.document).toHaveProperty('cycle_origin');
    expect(() => cycleSources(f.records, f.job)).toThrow('未完成');
    expect(readCycleState(f.job)?.grant?.status).toBe('consumed');
  });
  it('官方已结束证据的自动判定不受旧paid创建时间影响，future不能被旧期覆盖', () => {
    const f = cycleFixture(),
      sources = cycleSources(f.records, f.job);
    const inspection = f.inspection() as never;
    expect(automaticallyEnded(sources, inspection)).toBe(true);
    expect(
      automaticallyEnded(
        sources,
        f.inspection({
          previous_period: {
            ...object(f.document.subscription_period),
            end: new Date(Date.now() + 86400000).toISOString()
          }
        }) as never
      )
    ).toBe(false);
  });
  it('已提交转换的过期status不丢manual证明；fresh重审不重复转换', async () => {
    const f = cycleFixture(false);
    const review = (await inspect(f)).cycleReview;
    await f.local.confirmNextCycle(
      f.id,
      { reviewDigest: review.reviewDigest, confirmedPreviousCycleEnded: true },
      f.operator as never
    );
    await commit(f);
    const writes = f.recordTable.create.mock.calls.length;
    vi.advanceTimersByTime(6 * 60000);
    const expired = (await f.prepare('status', {
      reviewDigest: review.reviewDigest
    })) as V2RechargeNextCyclePreparationResult;
    expect(expired.cycleReview.status).toBe('revoked');
    expect(expired.nextCycleContext).toBeUndefined();
    await expect(f.callback(f.marker())).rejects.toThrow('已过期');
    const fresh = await inspect(f);
    expect(fresh.nextCycleContext?.grant?.reviewDigest).toBe(review.reviewDigest);
    expect(readCycleState(f.job)?.manualConfirmed).toBe(true);
    expect(f.recordTable.create.mock.calls.length).toBe(writes);
  });
  it('原checkout保存的官方期末可补同操作payment周期，外账号/套餐period拒绝', () => {
    const f = cycleFixture();
    delete object(f.records[1]!.document).subscription_period;
    expect(automaticallyEnded(cycleSources(f.records, f.job), f.inspection() as never)).toBe(true);
    object(object(f.records[0]!.document).subscription_period).account_key = 'e'.repeat(64);
    expect(() => cycleSources(f.records, f.job)).toThrow('原账户和原套餐');
  });
  it('paid文件或checkout文件错绑定不可获source资格', () => {
    const f = cycleFixture();
    f.records[1]!.fileKey = 'payments/' + 'e'.repeat(64) + '.json';
    expect(() => cycleSources(f.records, f.job)).toThrow('旧付款文件');
    const g = cycleFixture();
    g.records[0]!.fileKey = g.accountKey + '-go.json';
    expect(() => cycleSources(g.records, g.job)).toThrow('旧结算文件');
  });
  it('跨套餐新周期以Free恢复，旧Plus账期保留；活跃升级只读ctx不close', async () => {
    const f = cycleFixture(true, 'pro-5x');
    const before = structuredClone(f.records);
    const restored = await f.callback({
      type: 'restore',
      accountKey: f.accountKey,
      subscriptionCycleProtocol: 1
    });
    expect(restored).toHaveProperty('nextCycleContext.targetPlan', 'pro-5x');
    expect(readCycleState(f.job)?.grant).toBeUndefined();
    expect(f.records).toEqual(before);
    await inspect(f);
    const result = await commit(f);
    expect(result.nextCycleContext?.grant?.targetPlan).toBe('pro-5x');
    expect(result.nextCycleContext?.sources[0]?.targetPlan).toBe('plus');
  });
  it('strict安全取消的target原单可在已确证结束周期后归档替换，未知create不行', async () => {
    const f = cycleFixture(true, 'go');
    const cancelled = {
      status: 'cancelled',
      checkout_outcome: 'cancelled',
      cancelled_before_confirmation: true,
      payment_status: 'not_attempted',
      payment_attempted: false,
      confirmation_requests_sent: 0,
      target_plan: 'go'
    };
    f.records.push({ ...f.records[0]!, fileKey: f.accountKey + '-go.json', document: cancelled });
    await inspect(f);
    await commit(f);
    await f.callback(f.marker());
    expect(
      f.records.some(
        (record) =>
          record.fileKey.startsWith('history/') &&
          rechargeDocumentDigest(record.document) === rechargeDocumentDigest(cancelled)
      )
    ).toBe(true);
    const g = cycleFixture();
    object(g.records[0]!.document).status = 'checkout_attempted';
    object(g.records[0]!.document).checkout_identifier = undefined;
    await expect(inspect(g)).rejects.toThrow('未完成');
  });
});
