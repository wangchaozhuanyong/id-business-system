import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeAdminRepository } from './admin.repository';
import { readRechargeVoiceEvents } from './recharge-voice-events';

const now = new Date('2026-10-18T01:00:00.000Z');
const at = (offset: number) => new Date(now.getTime() + offset);
const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const encode = (value: unknown) => `v1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const decode = (value: string) =>
  JSON.parse(Buffer.from(value.slice(3), 'base64url').toString()) as Record<string, unknown>;
const cursor = (since = at(-120_000).toISOString()) =>
  encode({ baseline: at(-300_000).toISOString(), since });
type EventRow = {
  id: string;
  taskId: string | null;
  createdAt: Date;
  metadata: unknown;
  stage: string;
};
const event = (number: number, offset: number, plan: unknown = 'plus'): EventRow => ({
  id: uuid(number),
  taskId: uuid(number + 1000),
  createdAt: at(offset),
  metadata: { plan, token: 'synthetic-never-return' },
  stage: 'recharge_started'
});
type Scan = {
  where: {
    stage: string;
    createdAt: { gte: Date; lte: Date };
    OR?: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }];
  };
  take: number;
};
function fixture(rows: EventRow[] = []) {
  const findMany = vi.fn(async ({ where, take }: Scan) =>
    rows
      .filter(
        (row) =>
          row.stage === where.stage &&
          row.createdAt >= where.createdAt.gte &&
          row.createdAt <= where.createdAt.lte
      )
      .filter(
        (row) =>
          !where.OR ||
          row.createdAt > where.OR[0].createdAt.gt ||
          (row.createdAt.getTime() === where.OR[1].createdAt.getTime() &&
            row.id > where.OR[1].id.gt)
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, take)
  );
  const db = { onlineRechargeEvent: { findMany } };
  const read = (value: unknown, time = now) => readRechargeVoiceEvents(db as never, value, time);
  return { rows, db, read, findMany };
}

describe('新充值开始语音事件只读游标', () => {
  it('初始化不读取历史或输出事件，只建立服务端基线', async () => {
    const f = fixture([event(1, -1000)]);
    const result = await f.read('baseline');
    expect(result).toEqual({ items: [], cursor: expect.any(String), hasMore: false });
    expect(decode(result.cursor)).toEqual({
      baseline: now.toISOString(),
      since: now.toISOString()
    });
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('通过已有 runtime-logs 读取入口，基线不参加事务或其他资源查询', async () => {
    const f = fixture();
    const prisma = { ...f.db, onlineRechargeTask: { findMany: vi.fn() } };
    const repository = new OnlineRechargeRepository(
      {} as never,
      prisma as never,
      {} as never,
      { execute: vi.fn() } as never
    );
    expect(await repository.list('runtime-logs', { voiceCursor: 'baseline' })).toEqual({
      items: [],
      cursor: expect.any(String),
      hasMore: false
    });
    expect(f.findMany).not.toHaveBeenCalled();
    expect(prisma.onlineRechargeTask.findMany).not.toHaveBeenCalled();
  });

  it('普通运行日志继续使用清理视图与页码，专用语音读取不会改变原查询', async () => {
    const row = event(1, -1000);
    const findMany = vi.fn(async () => [row]);
    const findFirst = vi.fn(async () => ({ createdAt: at(-2000) }));
    const count = vi.fn(async () => 1);
    const repository = new OnlineRechargeRepository(
      {} as never,
      { onlineRechargeEvent: { findMany, findFirst, count } } as never,
      {} as never,
      {} as never
    );
    expect(await repository.list('runtime-logs', {})).toEqual({
      items: [row],
      total: 1,
      page: 1,
      pageSize: 20
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { stage: 'runtime_clear' },
      orderBy: { createdAt: 'desc' }
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gt: at(-2000) } }),
        skip: 0,
        take: 20
      })
    );
  });

  it('原导出输入不能误用无total的专用游标结果', async () => {
    const f = fixture();
    const repository = new OnlineRechargeRepository(
      {} as never,
      f.db as never,
      {} as never,
      {} as never
    );
    const admin = new OnlineRechargeAdminRepository(
      repository,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      admin.action('runtime-logs', 'export', { voiceCursor: 'baseline' }, {
        roles: ['admin']
      } as never)
    ).rejects.toThrow('导出查询无效');
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it('只选择专用开始事件，回传合法套餐且不泄露元数据和其他业务字段', async () => {
    const f = fixture([
      event(1, -1000),
      { ...event(2, -900), stage: 'runtime_clear' },
      event(3, -800, 'unknown'),
      { ...event(4, -700), taskId: null }
    ]);
    const result = await f.read(cursor());
    expect(result.items).toEqual([
      { id: uuid(1), taskId: uuid(1001), plan: 'plus', createdAt: at(-1000).toISOString() }
    ]);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, taskId: true, createdAt: true, metadata: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 101
      })
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-never-return');
    expect(result).not.toHaveProperty('total');
  });

  it('四种套餐均使用受控枚举', async () => {
    const plans = ['plus', 'pro_5x', 'pro_20x', 'pro_500'];
    expect(
      (await fixture(plans.map((plan, i) => event(i + 1, -10, plan))).read(cursor())).items.map(
        (row) => row.plan
      )
    ).toEqual(plans);
  });

  it('扫描上界固定，按时间与编号推进超过100条的同毫秒事件，不漏后续页', async () => {
    const f = fixture(Array.from({ length: 102 }, (_, i) => event(i + 1, -1000)));
    const first = await f.read(cursor());
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(decode(first.cursor)).toMatchObject({
      through: now.toISOString(),
      after: { at: at(-1000).toISOString(), id: uuid(100) }
    });
    f.rows.push(event(103, 1000));
    const second = await f.read(first.cursor, at(2000));
    expect(second.items.map((row) => row.id)).toEqual([uuid(101), uuid(102)]);
    expect(second.hasMore).toBe(false);
    expect(decode(second.cursor)).toEqual({
      baseline: at(-300_000).toISOString(),
      since: now.toISOString()
    });
    let third = await f.read(second.cursor, at(2000));
    const nextIds = third.items.map((row) => row.id);
    while (third.hasMore) {
      third = await f.read(third.cursor, at(2000));
      nextIds.push(...third.items.map((row) => row.id));
    }
    expect(nextIds).toContain(uuid(103));
  });

  it('无效套餐仍推进已扫描的游标，避免一直停在同一页', async () => {
    const f = fixture(
      Array.from({ length: 101 }, (_, i) => event(i + 1, -500, i === 100 ? 'pro_20x' : 'invalid'))
    );
    const first = await f.read(cursor());
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(decode(first.cursor)).toMatchObject({ after: { id: uuid(100) } });
    expect((await f.read(first.cursor)).items.map((row) => row.plan)).toEqual(['pro_20x']);
  });

  it('完成扫描后重叠60秒，捕获较迟提交事件，同时不读取基线前历史', async () => {
    const baseline = at(-30_000).toISOString();
    const f = fixture([event(1, -31_000)]);
    const first = await f.read(encode({ baseline, since: at(-10_000).toISOString() }));
    expect(first.items).toEqual([]);
    f.rows.push(event(2, -5000));
    expect((await f.read(first.cursor, at(1000))).items.map((row) => row.id)).toEqual([uuid(2)]);
    expect(f.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdAt: { gte: at(-30_000), lte: at(1000) } })
      })
    );
  });

  it('初始化后的旧时间任务即使晚启动也按开始事件时间进入，不依赖任务创建日期', async () => {
    const f = fixture();
    const initial = await f.read('baseline');
    f.rows.push(event(1, 1000));
    expect((await f.read(initial.cursor, at(2000))).items.map((row) => row.taskId)).toEqual([
      uuid(1001)
    ]);
  });

  it('允许1秒内的时钟偏差，但不会把游标时间倒退到基线之前', async () => {
    const f = fixture();
    const future = at(500).toISOString();
    const result = await f.read(encode({ baseline: future, since: future }));
    expect(decode(result.cursor)).toEqual({ baseline: future, since: future });
    await expect(f.read(result.cursor, at(1000))).resolves.toMatchObject({ hasMore: false });
  });

  const valid = { baseline: at(-300_000).toISOString(), since: at(-120_000).toISOString() };
  for (const [name, value] of Object.entries({
    missing: undefined,
    object: {},
    empty: '',
    wrongVersion: 'v2.abc',
    invalidAlphabet: 'v1.+abc',
    oversized: `v1.${'a'.repeat(2048)}`,
    invalidJson: `v1.${Buffer.from('{').toString('base64url')}`,
    array: encode([]),
    extra: encode({ ...valid, token: 'synthetic' }),
    missingSince: encode({ baseline: valid.baseline }),
    timestampNumber: encode({ ...valid, since: 100 }),
    invalidDate: encode({ ...valid, baseline: '2026-02-30T01:00:00.000Z' }),
    future: encode({ ...valid, since: at(2000).toISOString() }),
    beforeBaseline: encode({ ...valid, since: at(-400_000).toISOString() }),
    throughBeforeSince: encode({ ...valid, through: at(-200_000).toISOString() }),
    afterWithoutThrough: encode({ ...valid, after: { at: at(-1000).toISOString(), id: uuid(1) } }),
    afterBeforeWindow: encode({
      ...valid,
      through: now.toISOString(),
      after: { at: at(-200_000).toISOString(), id: uuid(1) }
    }),
    afterAfterThrough: encode({
      ...valid,
      through: at(-1000).toISOString(),
      after: { at: now.toISOString(), id: uuid(1) }
    }),
    invalidAfterId: encode({
      ...valid,
      through: now.toISOString(),
      after: { at: at(-1000).toISOString(), id: 'not-an-id' }
    }),
    extraAfterField: encode({
      ...valid,
      through: now.toISOString(),
      after: { at: at(-1000).toISOString(), id: uuid(1), email: 'synthetic' }
    })
  }))
    it(`拒绝非法游标 ${name}，不访问数据库`, async () => {
      const f = fixture();
      await expect(f.read(value)).rejects.toThrow('充值语音提醒游标无效');
      expect(f.findMany).not.toHaveBeenCalled();
    });
});
