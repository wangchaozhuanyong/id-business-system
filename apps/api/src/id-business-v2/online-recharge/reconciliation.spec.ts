import { randomUUID } from 'node:crypto';
import type { OnlineRechargeTask } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { originalRecheckSchedule } from './reconciliation';

const startedAt = new Date('2026-10-17T00:00:00Z');
function fixture(changes: Partial<OnlineRechargeTask> = {}) {
  const original = {
    id: randomUUID(),
    operation: 'recharge',
    provider: 'local',
    status: 'awaiting_review',
    plan: 'pro_20x',
    leaseVersion: 2,
    paymentStarted: true,
    confirmedPaid: false,
    sessionEncrypted: 'encrypted-session',
    sessionIdentityHash: 'identity',
    updatedAt: startedAt,
    payload: {
      checkoutRecoveryEncrypted: 'encrypted-original',
      proxyCountryCode: 'PH',
      region: 'PH',
      reconciliation: originalRecheckSchedule(undefined, startedAt)
    },
    ...changes
  } as OnlineRechargeTask;
  const queued: OnlineRechargeTask[] = [];
  const tx = {
    onlineRechargeTask: {
      findMany: vi.fn(async () => [original]),
      findFirst: vi.fn(
        async () => queued.find((row) => ['queued', 'running'].includes(row.status)) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: randomUUID(),
          status: 'queued',
          ...data
        } as unknown as OnlineRechargeTask;
        queued.push(row);
        return row;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(original, data);
        return original;
      })
    }
  };
  let locked = Promise.resolve<unknown>(undefined);
  const repository = {
    transaction: vi.fn((_key: string, work: (tx: unknown) => unknown) => {
      const result = locked.then(() => work(tx));
      locked = result.catch(() => undefined);
      return result;
    }),
    log: vi.fn(async () => undefined)
  };
  const tasks = new OnlineRechargeTasksRepository(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  return { original, queued, tx, repository, tasks };
}
describe('原单只读自动对账调度', () => {
  it('停止原因在重启和详情读取后保留，停止计划不显示虚假的下次核对时间', () => {
    expect(
      originalRecheckSchedule(
        {
          version: 1,
          startedAt: startedAt.toISOString(),
          attempts: 0,
          stopped: true,
          nextAttemptAt: null,
          reasonCode: 'legacy_original_identity_missing'
        },
        startedAt
      )
    ).toMatchObject({
      stopped: true,
      nextAttemptAt: null,
      reasonCode: 'legacy_original_identity_missing'
    });
  });
  it('在原始 1、5、15 分钟排队，重启沿用元数据，只消费三次且不创建付款任务', async () => {
    const f = fixture();
    expect(await f.tasks.processDueRechecks(new Date(startedAt.getTime() + 59999))).toEqual({
      enqueued: 0
    });
    for (const seconds of [60, 300, 900]) {
      expect(
        await f.tasks.processDueRechecks(new Date(startedAt.getTime() + seconds * 1000))
      ).toEqual({ enqueued: 1 });
      const queued = f.queued.at(-1)!;
      expect(queued).toMatchObject({
        operation: 'subscription',
        provider: 'local',
        sessionEncrypted: 'encrypted-session',
        payload: {
          action: 'recheck',
          sourceVersion: 2,
          recheckTaskId: f.original.id,
          proxyCountryCode: 'PH',
          region: 'PH',
          automaticRecheck: true
        }
      });
      expect(queued.payload).not.toHaveProperty('checkoutRecoveryEncrypted');
      expect(queued).not.toHaveProperty('paymentStarted');
      queued.status = 'failed';
    }
    const restarted = new OnlineRechargeTasksRepository(
      f.repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect(await restarted.processDueRechecks(new Date(startedAt.getTime() + 3600000))).toEqual({
      enqueued: 0
    });
    expect(f.queued).toHaveLength(3);
    expect(f.original).toMatchObject({
      status: 'awaiting_review',
      paymentStarted: true,
      payload: {
        reconciliation: {
          attempts: 3,
          stopped: true,
          nextAttemptAt: null,
          reasonCode: 'attempts_exhausted'
        }
      }
    });
  });
  it('并发实例和已经排队的手工核对共用同一锁及查询，不重复入队或消费次数', async () => {
    const f = fixture(),
      now = new Date(startedAt.getTime() + 60000);
    const second = new OnlineRechargeTasksRepository(
      f.repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const results = await Promise.all([
      f.tasks.processDueRechecks(now),
      second.processDueRechecks(now)
    ]);
    expect(results.reduce((n, result) => n + result.enqueued, 0)).toBe(1);
    expect(f.queued).toHaveLength(1);
    expect(f.repository.transaction.mock.calls.every((call) => call[0] === 'tasks-start')).toBe(
      true
    );
    f.tx.onlineRechargeTask.findFirst.mockResolvedValueOnce({
      ...f.queued[0],
      payload: { action: 'recheck', recheckTaskId: f.original.id, sourceVersion: 2 }
    } as OnlineRechargeTask);
    expect(await f.tasks.processDueRechecks(new Date(startedAt.getTime() + 300000))).toEqual({
      enqueued: 0
    });
    expect(f.original.payload).toMatchObject({ reconciliation: { attempts: 1 } });
  });
  it.each([
    [
      { checkoutRecoveryEncrypted: undefined, proxyCountryCode: 'PH', region: 'PH' },
      'legacy_original_identity_missing'
    ],
    [{ checkoutRecoveryEncrypted: 'encrypted-original', region: 'PH' }, 'original_route_missing']
  ])('缺原单或固定地区则保留保护并明确原因，不盲目排队', async (payload, reasonCode) => {
    const f = fixture({ payload });
    expect(await f.tasks.processDueRechecks(new Date(startedAt.getTime() + 600000))).toEqual({
      enqueued: 0
    });
    expect(f.queued).toHaveLength(0);
    expect(f.original).toMatchObject({
      status: 'awaiting_review',
      paymentStarted: true,
      payload: { reconciliation: { stopped: true, reasonCode } }
    });
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain('encrypted-original');
  });
  it('历史结果的 verified 标记不能替代缺失原单来源', async () => {
    const f = fixture({
      payload: { proxyCountryCode: 'PH', region: 'PH' },
      result: { paymentEvidence: { verified: true }, resultUnknown: true }
    });
    expect(await f.tasks.processDueRechecks(new Date(startedAt.getTime() + 60000))).toEqual({
      enqueued: 0
    });
    expect(f.original.payload).toMatchObject({
      reconciliation: { reasonCode: 'legacy_original_identity_missing' }
    });
  });
});
