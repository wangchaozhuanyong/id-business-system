import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import { SharedCardBusyConflict } from '../../bank-card-pool/public-api';

const taskId = '11111111-1111-4111-8111-111111111111';
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/fixture'));
afterEach(() => vi.unstubAllEnvs());
type Card = Record<string, unknown> & {
  id: string;
  successCount: number;
  leaseOwner: string | null;
};

function fixture(selectedId?: string) {
  const cards: Card[] = [firstId, secondId].map((cardId) => ({
    id: cardId,
    numberEncrypted: 'synthetic-encrypted-card',
    status: 'active',
    allowedPlans: ['plus'],
    successCount: 0,
    declineCount: 0,
    leaseOwner: null,
    leaseId: null,
    leaseVersion: 0,
    leaseExpiresAt: null,
    expiryMonth: 12,
    expiryYear: 2099,
    last4: '4242'
  }));
  const task = {
    id: taskId,
    status: 'running',
    plan: 'plus',
    leaseOwner: 'synthetic-worker',
    leaseId: 'synthetic-lease',
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 90000),
    payload: selectedId ? { cardId: selectedId } : {},
    cardId: null as string | null,
    paymentStarted: false
  };
  const tasks = new Map([[task.id, task]]);
  const jobs: {
    id: string;
    action?: string;
    leaseUntil?: Date;
    result: Record<string, unknown>;
  }[] = [];
  function matches(card: Card, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR')
        return (value as Record<string, unknown>[]).some((item) => matches(card, item));
      if (key === 'allowedPlans')
        return (value as { array_contains: string[] }).array_contains.includes('plus');
      if (value && typeof value === 'object') {
        if ('lt' in value) return Number(card[key]) < Number(value.lt);
        if ('lte' in value)
          return card[key] instanceof Date && Number(card[key]) <= Number(value.lte);
        if ('notIn' in value) return !(value.notIn as string[]).includes(String(card[key]));
      }
      return card[key] === value;
    });
  }
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    auditLog: { create: vi.fn(async () => ({ id: 'synthetic-audit' })) },
    idBusinessV2RechargeJob: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          jobs.find((job) => job.id === where.id) ?? null
      ),
      findMany: vi.fn(async ({ where, take }) =>
        jobs
          .filter((job) => {
            const marker = job.result._shared_card_attempt_v1 as { cardId?: string };
            return marker.cardId === where.result.equals && job.id !== where.id?.not;
          })
          .slice(0, take)
      )
    },
    onlineRechargeCard: {
      findFirst: vi.fn(async ({ where, orderBy }) => {
        const eligible = cards.filter((card) => matches(card, where));
        if (orderBy)
          eligible.sort((a, b) => a.successCount - b.successCount || a.id.localeCompare(b.id));
        return eligible[0] ?? null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const found = cards.filter((card) => matches(card, where));
        for (const card of found) Object.assign(card, data);
        return { count: found.length };
      })
    },
    onlineRechargeTask: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tasks.get(where.id)!),
      update: vi.fn(async ({ where, data }) => Object.assign(tasks.get(where.id)!, data))
    },
    idBusinessV2BankRechargeCard: { findUnique: vi.fn(async () => null) }
  };
  const encryption = { decrypt: vi.fn(() => 'synthetic-card-value') };
  const memory = { available: vi.fn(async (ids: string[]) => ids) };
  let active = Promise.resolve();
  const repository = {
    transaction: async (_key: string, work: (client: typeof tx) => unknown) => {
      const previous = active;
      let release!: () => void;
      active = new Promise<void>((resolve) => (release = resolve));
      await previous;
      try {
        return await work(tx);
      } finally {
        release();
      }
    },
    log: vi.fn()
  };
  const worker = new OnlineRechargeWorkerRepository(
    repository as never,
    { cardPolicy: async () => ({ maxSubscriptionCount: 2, maxDeclineCount: 3 }) } as never,
    encryption as never,
    memory as never,
    {} as never
  );
  function attempt(cardId: string, outcome = 'pending') {
    jobs.push({
      id: `synthetic-bit-job-${jobs.length}`,
      result: {
        _shared_card_attempt_v1: {
          cardId,
          authorizedAt: new Date(0).toISOString(),
          outcome
        }
      }
    });
  }
  return {
    cards,
    task,
    tasks,
    jobs,
    tx,
    encryption,
    memory,
    worker,
    repository,
    attempt,
    rpc: {
      taskId,
      workerId: task.leaseOwner,
      leaseId: task.leaseId,
      leaseVersion: task.leaseVersion,
      method: 'reserveCard'
    }
  };
}

describe('线上代充保留比特未决付款的共享额度', () => {
  it('不付款验收缺少临时安全码时不写入人工等待状态', async () => {
    const f = fixture(firstId);
    Object.assign(f.task, {
      operation: 'debug',
      payload: { cardId: firstId, validationMode: 'ready_before_payment' }
    });
    f.memory.available.mockResolvedValueOnce([]);
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ pendingCredentials: true });
    expect(f.task.status).toBe('running');
    expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
  });
  it.each(['fresh', 'prior', 'resumed'])(
    '自动分配跳过 NOWAIT 忙卡并实际预留下一张：%s',
    async (route) => {
      vi.stubEnv('DATABASE_URL', 'mysql://synthetic/fixture');
      const f = fixture();
      if (route === 'prior') f.cards[0]!.leaseOwner = taskId;
      if (route === 'resumed') f.task.cardId = firstId;
      f.tx.$queryRaw.mockImplementation(async (query: { values: unknown[] }) => {
        if (query.values[0] === firstId) throw { code: 'P2010', meta: { code: '3572' } };
        return [];
      });
      expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: secondId });
      expect(f.cards[1]!.leaseOwner).toBe(taskId);
      expect(f.tx.idBusinessV2RechargeJob.findMany).not.toHaveBeenCalled();
    }
  );

  it('过期比特原单的 PK NOWAIT 忙时，自动分配仍可取得另一张卡', async () => {
    vi.stubEnv('DATABASE_URL', 'mysql://synthetic/fixture');
    const f = fixture();
    f.cards[0]!.leaseOwner = 'locked-bit-job';
    f.cards[0]!.leaseExpiresAt = new Date(0);
    f.tx.$queryRaw.mockImplementation(async (query: unknown) => {
      if (Array.isArray(query)) throw { errno: 3572 };
      return [];
    });
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: secondId });
    expect(f.cards[0]!.leaseOwner).toBe('locked-bit-job');
  });

  it('手选 NOWAIT 忙卡明确拒绝，不能回退到其他卡', async () => {
    vi.stubEnv('DATABASE_URL', 'mysql://synthetic/fixture');
    const f = fixture(firstId);
    f.tx.$queryRaw.mockRejectedValueOnce({ errno: 3572 });
    await expect(f.worker.reserveCard(f.rpc)).rejects.toBeInstanceOf(SharedCardBusyConflict);
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    { errno: 1213 },
    { code: 'P2010', meta: { code: '1205' } },
    new Error('synthetic-db-failure')
  ])('自动分配遇其他 DB 错误时立即拒绝，不继续选卡：%j', async (error) => {
    vi.stubEnv('DATABASE_URL', 'mysql://synthetic/fixture');
    const f = fixture();
    f.tx.$queryRaw.mockRejectedValueOnce(error);
    await expect(f.worker.reserveCard(f.rpc)).rejects.toThrow('稍后重新核对');
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });
  it('成功次数加未决次数已满时跳过首卡并实际预留下一张', async () => {
    const f = fixture();
    f.cards[0]!.successCount = 1;
    f.cards[1]!.successCount = 1;
    f.attempt(firstId);
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: secondId });
    expect(f.cards[0]!.leaseOwner).toBeNull();
    expect(f.cards[1]!.leaseOwner).toBe(taskId);
  });

  it('手选额度满的卡返回空且不读取安全码或解密', async () => {
    const f = fixture(firstId);
    f.cards[0]!.successCount = 1;
    f.attempt(firstId);
    expect(await f.worker.reserveCard(f.rpc)).toBeNull();
    expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
    expect(f.memory.available).not.toHaveBeenCalled();
  });

  it.each(['paid', 'declined', 'resolved'])('明确 %s 的历史记录不占未决额度', async (outcome) => {
    const f = fixture(firstId);
    f.cards[0]!.successCount = 1;
    f.attempt(firstId, outcome);
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: firstId });
  });

  it('已有同任务租约也不能越过未决额度，换卡使用新卡租约', async () => {
    const f = fixture();
    f.cards[0]!.successCount = 1;
    f.cards[0]!.leaseOwner = taskId;
    f.cards[0]!.leaseId = 'old-card-lease';
    f.cards[0]!.leaseVersion = 9;
    f.attempt(firstId);
    const result = await f.worker.reserveCard(f.rpc);
    expect(result).toMatchObject({ id: secondId, leaseVersion: 1 });
    expect(result && 'leaseId' in result ? result.leaseId : undefined).not.toBe('old-card-lease');
  });

  it('原卡恢复分支也遵守额度，下一张仍可预留', async () => {
    const f = fixture();
    f.task.cardId = firstId;
    f.cards[0]!.successCount = 1;
    f.attempt(firstId);
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: secondId });
  });

  it('旧比特无 marker 时仍由原卡租约阻止线上取得', async () => {
    const f = fixture(firstId);
    f.cards[0]!.leaseOwner = 'legacy-bit-job';
    f.cards[0]!.leaseExpiresAt = new Date(0);
    expect(await f.worker.reserveCard(f.rpc)).toBeNull();
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });

  it('满两分钟且执行租约到期的比特卡可定向释放，保留原单未决额度', async () => {
    const f = fixture(firstId);
    f.attempt(firstId);
    const job = f.jobs[0]!;
    Object.assign(job, { action: 'bitbrowser', leaseUntil: new Date(0) });
    job.result.payment_attempted = true;
    f.cards[0]!.leaseOwner = job.id;
    f.cards[0]!.leaseExpiresAt = new Date(0);
    const snapshot = structuredClone(job);
    expect(await f.worker.reserveCard(f.rpc)).toMatchObject({ id: firstId });
    expect(f.cards[0]!.leaseOwner).toBe(taskId);
    expect(job).toEqual(snapshot);
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledTimes(2);
    expect(f.tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(f.tx.idBusinessV2RechargeJob.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: job.id }
    });
  });

  it.each(['online', 'recent', 'running', 'mismatched', 'not-attempted'])(
    '不释放不满足条件的占用：%s',
    async (scenario) => {
      const f = fixture(firstId);
      f.attempt(firstId);
      const job = f.jobs[0]!;
      Object.assign(job, {
        action: scenario === 'online' ? 'online' : 'bitbrowser',
        leaseUntil: scenario === 'running' ? new Date(Date.now() + 60000) : new Date(0)
      });
      job.result.payment_attempted = scenario !== 'not-attempted';
      const attempt = job.result._shared_card_attempt_v1 as Record<string, unknown>;
      if (scenario === 'recent') attempt.authorizedAt = new Date(Date.now() - 119000).toISOString();
      if (scenario === 'mismatched') attempt.cardId = secondId;
      f.cards[0]!.leaseOwner = job.id;
      f.cards[0]!.leaseExpiresAt = new Date(0);
      expect(await f.worker.reserveCard(f.rpc)).toBeNull();
      expect(f.cards[0]!.leaseOwner).toBe(job.id);
      expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
      expect(f.encryption.decrypt).not.toHaveBeenCalled();
    }
  );

  it('定向释放的 CAS 失败时不交出卡资料', async () => {
    const f = fixture(firstId);
    f.attempt(firstId);
    const job = f.jobs[0]!;
    Object.assign(job, { action: 'bitbrowser', leaseUntil: new Date(0) });
    job.result.payment_attempted = true;
    f.cards[0]!.leaseOwner = job.id;
    f.cards[0]!.leaseExpiresAt = new Date(0);
    f.tx.onlineRechargeCard.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await f.worker.reserveCard(f.rpc)).toBeNull();
    expect(f.cards[0]!.leaseOwner).toBe(job.id);
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledTimes(1);
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });

  it('最终预留前再次核对未决额度，变化后不交出卡资料', async () => {
    const f = fixture(firstId);
    f.cards[0]!.successCount = 1;
    f.memory.available.mockImplementationOnce(async (ids) => {
      f.attempt(firstId);
      return ids;
    });
    expect(await f.worker.reserveCard(f.rpc)).toBeNull();
    expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });

  it('已有一个比特未决时，两个线上账号并发只能取得最后一份额度', async () => {
    const f = fixture(firstId);
    f.attempt(firstId);
    const secondTask = { ...f.task, id: '44444444-4444-4444-8444-444444444444' };
    f.tasks.set(secondTask.id, secondTask);
    const other = new OnlineRechargeWorkerRepository(
      f.repository as never,
      { cardPolicy: async () => ({ maxSubscriptionCount: 2, maxDeclineCount: 3 }) } as never,
      f.encryption as never,
      f.memory as never,
      {} as never
    );
    const results = await Promise.all([
      f.worker.reserveCard(f.rpc),
      other.reserveCard({ ...f.rpc, taskId: secondTask.id })
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledTimes(1);
    expect(f.encryption.decrypt).toHaveBeenCalledTimes(1);
    expect(f.cards[0]!.leaseOwner).toBe(taskId);
  });

  it('连续 500 张候选额度满时有界退出，不继续扫描或解密', async () => {
    const f = fixture();
    f.cards.length = 0;
    for (let index = 0; index <= 500; index++) {
      const cardId = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`;
      f.cards.push({
        id: cardId,
        status: 'active',
        allowedPlans: ['plus'],
        successCount: 1,
        declineCount: 0,
        leaseOwner: null
      });
      if (index < 500) f.attempt(cardId);
    }
    expect(await f.worker.reserveCard(f.rpc)).toBeNull();
    expect(f.tx.onlineRechargeCard.findFirst).toHaveBeenCalledTimes(501);
    expect(f.tx.idBusinessV2RechargeJob.findMany).toHaveBeenCalledTimes(500);
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
  });
});
