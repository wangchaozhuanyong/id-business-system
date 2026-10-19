import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bitBrowserPendingCapacity,
  SharedCardBusyConflict
} from './persistence/shared-card-capacity';

const cardId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/fixture'));
afterEach(() => vi.unstubAllEnvs());
function marker(outcome = 'pending', changes: Record<string, unknown> = {}) {
  return {
    cardId,
    authorizedAt: new Date(0).toISOString(),
    outcome,
    ...changes
  };
}
function fixture(results: unknown[]) {
  const findMany = vi.fn(async () =>
    results.map((result, index) => ({ id: `job-${index}`, result }))
  );
  const tx = { idBusinessV2RechargeJob: { findMany } };
  return { tx, findMany };
}

describe('比特未决付款的共享银行卡额度读取', () => {
  it('只计同卡私有 pending，已终结记录和客户端付款字段均不占额度', async () => {
    const f = fixture([
      { _shared_card_attempt_v1: marker() },
      { _shared_card_attempt_v1: marker('paid') },
      { _shared_card_attempt_v1: marker('declined') },
      { _shared_card_attempt_v1: marker('resolved') },
      { _shared_card_attempt_v1: marker('pending', { cardId: 'other-card' }) },
      { payment_attempted: true, payment_status: 'unknown', sharedCardId: cardId },
      null,
      []
    ]);
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId)).toBe(1);
    expect(f.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { result: { path: '$._shared_card_attempt_v1.cardId', equals: cardId } },
      select: { id: true, result: true },
      orderBy: { id: 'asc' },
      take: 501
    });
  });

  it('可排除当前比特任务，仅排除相同 jobId', async () => {
    const f = fixture([
      { _shared_card_attempt_v1: marker() },
      { _shared_card_attempt_v1: marker() }
    ]);
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId, 'job-0')).toBe(1);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'job-0' } }) })
    );
  });

  it.each([
    { authorizedAt: 'not-a-date' },
    { authorizedAt: '1970-01-01' },
    { authorizedAt: null },
    { authorizedAt: '2026-02-30T00:00:00.000Z' },
    { outcome: 'unknown' },
    { outcome: null }
  ])('同卡私有记录不完整时拒绝分配：%j', async (changes) => {
    const f = fixture([{ _shared_card_attempt_v1: marker('pending', changes) }]);
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('不完整');
  });

  it('允许读取恰好 500 条，遇到 501 条时拒绝而非截断计数', async () => {
    const f = fixture(Array.from({ length: 500 }, () => ({ _shared_card_attempt_v1: marker() })));
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId)).toBe(500);
    f.findMany.mockResolvedValueOnce(
      Array.from({ length: 501 }, (_, index) => ({
        id: `job-${index}`,
        result: { _shared_card_attempt_v1: marker() }
      }))
    );
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('过多');
  });

  it('读取失败不按零额度继续，不获取锁或修改任何记录', async () => {
    const f = fixture([]);
    f.findMany.mockRejectedValueOnce(new Error('synthetic-read-failed'));
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('稍后重新核对');
    expect(Object.keys(f.tx)).toEqual(['idBusinessV2RechargeJob']);
    expect(Object.keys(f.tx.idBusinessV2RechargeJob)).toEqual(['findMany']);
  });
});

describe('MySQL 共享额度当前读合同', () => {
  function mysqlFixture(rows: unknown = []) {
    vi.stubEnv('DATABASE_URL', 'mysql://synthetic/fixture');
    const queryRaw = vi.fn<(query: unknown) => Promise<unknown>>(async () => rows);
    const findMany = vi.fn();
    return {
      tx: { $queryRaw: queryRaw, idBusinessV2RechargeJob: { findMany } },
      queryRaw,
      findMany
    };
  }

  it('固定既有卡索引联结、排序、501 上限及 NOWAIT，值使用 Prisma 参数化', async () => {
    const selected = "synthetic-card' OR 1=1 --";
    const f = mysqlFixture([
      {
        id: 'job-1',
        result: JSON.stringify({ _shared_card_attempt_v1: marker('pending', { cardId: selected }) })
      },
      { id: 'job-2', result: { _shared_card_attempt_v1: marker('declined', { cardId: selected }) } }
    ]);
    expect(await bitBrowserPendingCapacity(f.tx as never, selected, 'excluded-job')).toBe(1);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    const query = f.queryRaw.mock.calls[0]![0] as unknown as { sql: string; values: unknown[] };
    const sql = query.sql.replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      'SELECT j.id, j.result FROM online_recharge_cards s STRAIGHT_JOIN id_business_v2_bank_recharge_cards l ON l.number_hash = s.number_hash STRAIGHT_JOIN id_business_v2_recharge_jobs j FORCE INDEX (id_business_v2_recharge_jobs_card_id_idx) ON j.card_id = l.id WHERE s.id = ? AND j.id <> ? ORDER BY j.id LIMIT 501 FOR SHARE NOWAIT'
    );
    expect(query.values).toEqual([selected, 'excluded-job']);
    expect(sql).not.toContain(selected);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('无排除任务时仍参数化空排除值，不改变 SQL', async () => {
    const f = mysqlFixture();
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId)).toBe(0);
    const query = f.queryRaw.mock.calls[0]![0] as unknown as { values: unknown[] };
    expect(query.values).toEqual([cardId, '']);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('不存在 legacy 映射或历史记录时返回零，不能另发无索引 JSON 查询', async () => {
    const f = mysqlFixture([]);
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId)).toBe(0);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('SQL 返回的私有标记和当前共享卡不一致时拒绝分配', async () => {
    const f = mysqlFixture([
      {
        id: 'job',
        result: { _shared_card_attempt_v1: marker('pending', { cardId: 'wrong-card' }) }
      }
    ]);
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('稍后重新核对');
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each(['NOWAIT', 'DEADLOCK', 'DATABASE_UNAVAILABLE'])(
    '%s 异常统一拒绝，不重试或退回快照读取',
    async (reason) => {
      const f = mysqlFixture();
      f.queryRaw.mockRejectedValueOnce(new Error(reason));
      const failure = await bitBrowserPendingCapacity(f.tx as never, cardId).catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(ConflictException);
      expect(failure).not.toBeInstanceOf(SharedCardBusyConflict);
      expect(f.queryRaw).toHaveBeenCalledTimes(1);
      expect(f.findMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    { errno: 3572 },
    { code: 'P2010', meta: { code: '3572' } },
    { code: 'P2010', meta: { code: 3572 } }
  ])('仅确认的 MySQL NOWAIT 错误映射为可跳卡冲突：%j', async (error) => {
    const f = mysqlFixture();
    f.queryRaw.mockRejectedValueOnce(error);
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toBeInstanceOf(
      SharedCardBusyConflict
    );
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { errno: 1213 },
    { errno: 1205 },
    { errno: '3572' },
    { code: 'P2034', meta: { code: '3572' } },
    { code: 'ER_LOCK_NOWAIT' },
    { code: '3572' },
    { meta: { code: '3572' } },
    { code: 'P2010', meta: { code: '1213' } }
  ])('未知、死锁或超时错误不能伪装成可跳卡忙：%j', async (error) => {
    const f = mysqlFixture();
    f.queryRaw.mockRejectedValueOnce(error);
    const failure = await bitBrowserPendingCapacity(f.tx as never, cardId).catch(
      (caught: unknown) => caught
    );
    expect(failure).toBeInstanceOf(ConflictException);
    expect(failure).not.toBeInstanceOf(SharedCardBusyConflict);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    [null],
    [{ id: 42, result: {} }],
    [{ id: 'job', result: '{invalid-json' }],
    [{ id: 'job', result: 'null' }],
    [{ id: 'job', result: '[]' }],
    [{ id: 'job', result: '1' }],
    [{ id: 'job', result: { _shared_card_attempt_v1: null } }]
  ])('拒绝不合法的 SQL 行或 JSON，禁止回退：%j', async (rows) => {
    const f = mysqlFixture(rows);
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('稍后重新核对');
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('映射卡下没有私有标记的旧记录不占新额度，但不能忽略其他卡标记', async () => {
    const f = mysqlFixture([
      { id: 'legacy-job', result: { payment_attempted: true, payment_status: 'unknown' } },
      { id: 'new-job', result: { _shared_card_attempt_v1: marker() } }
    ]);
    expect(await bitBrowserPendingCapacity(f.tx as never, cardId)).toBe(1);
    expect(f.queryRaw).toHaveBeenCalledTimes(1);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('SQL 返回 501 条仍拒绝，不能把截断结果用于额度分配', async () => {
    const f = mysqlFixture(
      Array.from({ length: 501 }, (_, index) => ({
        id: `job-${index}`,
        result: { _shared_card_attempt_v1: marker() }
      }))
    );
    await expect(bitBrowserPendingCapacity(f.tx as never, cardId)).rejects.toThrow('过多');
    expect(f.findMany).not.toHaveBeenCalled();
  });
});
