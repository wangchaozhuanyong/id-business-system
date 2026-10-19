import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from '../auto-recharge/persistence/recharge.repository';
import { rechargeCardAttempt } from '../auto-recharge/persistence/recharge-payment-hold.repository';
import {
  SharedBankCardRepository,
  lockSharedBankCards
} from './persistence/shared-bank-card.repository';
import {
  bitBrowserPendingCapacity,
  SharedCardBusyConflict
} from './persistence/shared-card-capacity';
import { OnlineRechargeRepository } from '../online-recharge/persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from '../online-recharge/persistence/worker.repository';

const enabled = process.env.SHARED_BANK_CARD_MYSQL_TEST === '1';
(enabled ? describe : describe.skip)('共享银行卡真实 MySQL 租约与并发', () => {
  const db = new PrismaService();
  const transactions = new V2CommandTransactionManager(db);
  const audit = new V2TransactionalAuditService();
  const encryption = new FieldEncryptionService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: 'synthetic-shared-card-fixture',
      HASH_SECRET: 'synthetic-shared-card-index'
    })
  );
  const pool = new SharedBankCardRepository(db, encryption, transactions, audit);
  const repository = new OnlineRechargeRepository({} as never, db, audit, transactions);
  const worker = new OnlineRechargeWorkerRepository(
    repository,
    { cardPolicy: async () => ({ maxSubscriptionCount: 2, maxDeclineCount: 3 }) } as never,
    encryption,
    { available: async (ids: string[]) => ids } as never,
    {} as never
  );
  const cards: string[] = [],
    tasks: string[] = [],
    jobs: string[] = [],
    legacyCards: string[] = [];
  let connected = false;
  let currencyCreated = false;
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  }
  const run = <T>(work: Parameters<V2CommandTransactionManager['execute']>[0]) =>
    transactions.execute(work, {
      changedScopes: ['online-recharge'],
      requestId: randomUUID(),
      retryMode: 'none'
    }) as Promise<T>;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/id_business_v2_shared_bank_fixture'
    )
      throw new Error('共享银行卡验收仅允许自有隔离数据库');
    await db.$connect();
    connected = true;
    if (!(await db.idBusinessV2BankRechargeCurrency.findUnique({ where: { code: 'XTS' } }))) {
      await db.idBusinessV2BankRechargeCurrency.create({
        data: { code: 'XTS', name: '共享卡隔离测试币种', minorUnits: 2 }
      });
      currencyCreated = true;
    }
  });
  afterAll(async () => {
    if (!connected) return;
    await db.idBusinessV2RechargeJob.deleteMany({ where: { id: { in: jobs } } });
    await db.onlineRechargeTask.deleteMany({ where: { id: { in: tasks } } });
    await db.idBusinessV2BankRechargeCard.deleteMany({ where: { id: { in: legacyCards } } });
    await db.onlineRechargeCard.deleteMany({ where: { id: { in: cards } } });
    if (currencyCreated)
      await db.idBusinessV2BankRechargeCurrency.delete({ where: { code: 'XTS' } });
    await db.$disconnect();
  });
  async function fixture() {
    const card = await db.onlineRechargeCard.create({
      data: {
        numberHash: encryption.hash(randomUUID())!,
        numberEncrypted: encryption.encrypt('synthetic-only')!,
        last4: '1111',
        expiryMonth: 12,
        expiryYear: 2099,
        allowedPlans: ['plus']
      }
    });
    cards.push(card.id);
    const task = await db.onlineRechargeTask.create({
      data: {
        message: '隔离租约验收',
        status: 'running',
        plan: 'plus',
        leaseOwner: 'shared-card-ci',
        leaseId: randomUUID(),
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 120000),
        payload: { cardId: card.id }
      }
    });
    tasks.push(task.id);
    const legacy = {
      id: randomUUID(),
      numberHash: card.numberHash,
      numberEncrypted: card.numberEncrypted,
      last4: card.last4,
      expiry: '12/99',
      active: true,
      currencyCode: 'USD'
    } as never;
    const rpc = {
      method: 'reserveCard',
      taskId: task.id,
      workerId: task.leaseOwner!,
      leaseId: task.leaseId!,
      leaseVersion: task.leaseVersion
    };
    return { card, task, legacy, rpc };
  }
  async function pendingJob(cardId: string, jobId = randomUUID()) {
    const shared = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: cardId } });
    let legacy = await db.idBusinessV2BankRechargeCard.findUnique({
      where: { numberHash: shared.numberHash }
    });
    if (!legacy) {
      legacy = await db.idBusinessV2BankRechargeCard.create({
        data: {
          label: '共享卡隔离映射',
          last4: shared.last4,
          numberHash: shared.numberHash,
          numberEncrypted: shared.numberEncrypted,
          expiry: '12/99',
          currencyCode: 'XTS'
        }
      });
      legacyCards.push(legacy.id);
    }
    const job = await db.idBusinessV2RechargeJob.create({
      data: {
        id: jobId,
        ownerId: 'shared-card-ci',
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        cardId: legacy.id,
        leaseUntil: new Date(0),
        result: {
          payment_attempted: true,
          _shared_card_attempt_v1: {
            cardId,
            authorizedAt: new Date(0).toISOString(),
            outcome: 'pending'
          }
        }
      }
    });
    jobs.push(job.id);
    return job;
  }

  it('额度当前读的实际 SQL 计划必须使用既有主键、唯一号卡索引与 job.card_id 索引', async () => {
    const f = await fixture();
    await pendingJob(f.card.id);
    expect(await run((tx) => bitBrowserPendingCapacity(tx, f.card.id))).toBe(1);
    let statement: Prisma.Sql | undefined;
    await bitBrowserPendingCapacity(
      {
        $queryRaw: async (query: Prisma.Sql) => {
          statement = query;
          return [];
        }
      } as never,
      f.card.id
    );
    if (!statement) throw new Error('未捕获实际额度查询');
    const plan = await db.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`EXPLAIN FORMAT=TRADITIONAL ${statement}`
    );
    const detail = JSON.stringify(
      plan.map((row) => ({
        columns: Object.keys(row).sort(),
        table: row.table,
        tableType: typeof row.table,
        tableBytes: row.table instanceof Uint8Array,
        type: row.type,
        key: row.key,
        keyType: typeof row.key,
        rows: row.rows,
        extra: row.Extra
      })),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)
    ).slice(0, 4000);
    // Only plan metadata for this isolated synthetic fixture; no query parameters or card data.
    console.info('SHARED_CARD_EXPLAIN_PLAN', detail);
    expect(plan.find((row) => row.table === 's')?.key, detail).toBe('PRIMARY');
    expect(plan.find((row) => row.table === 'l')?.key, detail).toBe(
      'id_business_v2_bank_recharge_cards_number_hash_key'
    );
    expect(plan.find((row) => row.table === 'j')?.key, detail).toBe(
      'id_business_v2_recharge_jobs_card_id_idx'
    );
    expect(['const', 'eq_ref', 'ref', 'range'], detail).toContain(
      plan.find((row) => row.table === 'j')?.type
    );
  });
  it('比特与线上同时抢卡，只有一方取得租约', async () => {
    const f = await fixture(),
      bit = randomUUID();
    const results = await Promise.allSettled([
      run(async (tx) => {
        await pool.reserveLegacy(tx, f.legacy, 'plus', bit);
        return bit;
      }),
      worker.reserveCard(f.rpc)
    ]);
    const granted = results.filter(
      (result) => result.status === 'fulfilled' && result.value !== null
    );
    expect(granted).toHaveLength(1);
    const saved = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } });
    expect([bit, f.task.id]).toContain(saved.leaseOwner);
    expect(saved.leaseVersion).toBe(1);
  });
  it('两个比特任务并发请求也只能有一个成功', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((job) =>
        run(async (tx) => {
          await pool.reserveLegacy(tx, f.legacy, 'plus', job);
          return job;
        })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('缺可信授权记录的旧未知付款不凭超时释放，明确成功并发重放只记一次', async () => {
    const f = await fixture(),
      bit = randomUUID();
    await run((tx) => pool.reserveLegacy(tx, f.legacy, 'plus', bit));
    await db.onlineRechargeCard.update({
      where: { id: f.card.id },
      data: { leaseExpiresAt: new Date(0) }
    });
    await run((tx) =>
      pool.finishBitBrowser(tx, bit, { payment_attempted: true, payment_status: 'unknown' }, false)
    );
    expect(await worker.reserveCard(f.rpc)).toBeNull();
    await Promise.all([1, 2].map(() => run((tx) => pool.finishBitBrowser(tx, bit, {}, true))));
    expect(
      await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } })
    ).toMatchObject({ leaseOwner: null, successCount: 1 });
  });
  it('套餐不匹配的手选卡不回退分配，执行前也拒绝跨套餐提交', async () => {
    const f = await fixture();
    await db.onlineRechargeCard.update({
      where: { id: f.card.id },
      data: { allowedPlans: ['pro_20x'] }
    });
    expect(await worker.reserveCard(f.rpc)).toBeNull();
    await expect(
      run((tx) => pool.reserveLegacy(tx, f.legacy, 'plus', randomUUID()))
    ).rejects.toThrow('不允许');
    await db.onlineRechargeTask.update({ where: { id: f.task.id }, data: { cardId: f.card.id } });
    await db.onlineRechargeCard.update({
      where: { id: f.card.id },
      data: {
        leaseOwner: f.task.id,
        leaseId: randomUUID(),
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 120000)
      }
    });
    await expect(worker.beforeSubmit(f.rpc)).rejects.toThrow('不允许');
    expect(
      (await db.onlineRechargeTask.findUniqueOrThrow({ where: { id: f.task.id } })).paymentStarted
    ).toBe(false);
  });
  it('预约事务失败回滚后，另一种充值可以正常取得原卡', async () => {
    const f = await fixture();
    await expect(
      run(async (tx) => {
        await pool.reserveLegacy(tx, f.legacy, 'plus', randomUUID());
        throw new Error('合成回滚');
      })
    ).rejects.toThrow('合成回滚');
    expect(await worker.reserveCard(f.rpc)).toMatchObject({ id: f.card.id });
  });

  it('持 job 锁与持共享锁形成反向依赖时，额度 NOWAIT 读取立即拒绝并解除等待', async () => {
    const f = await fixture();
    const job = await pendingJob(f.card.id);
    const locked = gate(),
      sharedHeld = gate(),
      sharedRequested = gate();
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM id_business_v2_recharge_jobs WHERE id = ${job.id} FOR UPDATE`;
        locked.resolve();
        await sharedHeld.promise;
        const waiting = lockSharedBankCards(tx);
        sharedRequested.resolve();
        await waiting;
        return 'holder-completed';
      },
      { isolationLevel: 'Serializable', timeout: 10000 }
    );
    let elapsed = Infinity;
    const reader = (async () => {
      await locked.promise;
      try {
        return await db.$transaction(
          async (tx) => {
            await lockSharedBankCards(tx);
            sharedHeld.resolve();
            await sharedRequested.promise;
            const started = Date.now();
            try {
              return await bitBrowserPendingCapacity(tx, f.card.id);
            } finally {
              elapsed = Date.now() - started;
            }
          },
          { isolationLevel: 'Serializable', timeout: 10000 }
        );
      } finally {
        sharedHeld.resolve();
      }
    })();
    const [held, read] = await Promise.allSettled([holder, reader]);
    expect(held).toEqual({ status: 'fulfilled', value: 'holder-completed' });
    expect(read.status).toBe('rejected');
    if (read.status === 'rejected') expect(read.reason).toBeInstanceOf(SharedCardBusyConflict);
    expect(elapsed).toBeLessThan(3000);
    expect(
      (await db.idBusinessV2RechargeJob.findUniqueOrThrow({ where: { id: job.id } })).result
    ).toMatchObject({ _shared_card_attempt_v1: { outcome: 'pending' } });
  }, 30000);

  it('自动选卡遇 A 卡原单 NOWAIT 忙时，仍能在同一事务取得 B 卡', async () => {
    const first = await fixture(),
      second = await fixture();
    const job = await pendingJob(first.card.id);
    await db.onlineRechargeCard.update({
      where: { id: second.card.id },
      data: { successCount: 1 }
    });
    await db.onlineRechargeTask.update({ where: { id: first.task.id }, data: { payload: {} } });
    const locked = gate(),
      release = gate();
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM id_business_v2_recharge_jobs WHERE id = ${job.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { isolationLevel: 'Serializable', timeout: 10000 }
    );
    try {
      await locked.promise;
      const excludedIds = cards.filter(
        (cardId) => ![first.card.id, second.card.id].includes(cardId)
      );
      expect(await worker.reserveCard({ ...first.rpc, args: { excludedIds } })).toMatchObject({
        id: second.card.id
      });
      expect(
        (await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: first.card.id } })).leaseOwner
      ).toBeNull();
    } finally {
      release.resolve();
      await holder;
    }
  }, 30000);

  it('映射卡下的私有 marker 指向其他共享卡时拒绝，不能按零未决放行', async () => {
    const f = await fixture(),
      other = await fixture();
    const job = await pendingJob(f.card.id);
    await db.idBusinessV2RechargeJob.update({
      where: { id: job.id },
      data: {
        result: {
          _shared_card_attempt_v1: {
            cardId: other.card.id,
            authorizedAt: new Date(0).toISOString(),
            outcome: 'pending'
          }
        }
      }
    });
    await expect(
      run(async (tx) => {
        await lockSharedBankCards(tx);
        return bitBrowserPendingCapacity(tx, f.card.id);
      })
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('满两分钟的 Bit 卡仅释放独占，原未决 marker 与额度保留', async () => {
    const f = await fixture();
    const job = await pendingJob(f.card.id);
    await db.onlineRechargeCard.update({
      where: { id: f.card.id },
      data: {
        leaseOwner: job.id,
        leaseId: randomUUID(),
        leaseExpiresAt: new Date(0)
      }
    });
    expect(await worker.reserveCard(f.rpc)).toMatchObject({ id: f.card.id });
    expect(
      await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } })
    ).toMatchObject({ leaseOwner: f.task.id, successCount: 0 });
    expect(
      (await db.idBusinessV2RechargeJob.findUniqueOrThrow({ where: { id: job.id } })).result
    ).toMatchObject({ _shared_card_attempt_v1: { outcome: 'pending', cardId: f.card.id } });
    expect(await run((tx) => bitBrowserPendingCapacity(tx, f.card.id))).toBe(1);
  });
  it('原hold已释放且新任务占卡后，两个并发迟到成功在真实auto锁下恰计一次且不清新lease', async () => {
    const f = await fixture(),
      source = await pendingJob(f.card.id);
    await db.onlineRechargeCard.update({
      where: { id: f.card.id },
      data: { leaseOwner: source.id, leaseId: randomUUID(), leaseExpiresAt: new Date(0) }
    });
    expect(await worker.reserveCard(f.rpc)).toMatchObject({ id: f.card.id });
    const before = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } });
    const auto = new RechargeRepository(db);
    await Promise.all(
      [1, 2].map(() =>
        run(async (tx) => {
          await auto.lock(tx);
          const current = await auto.findJob(tx, source.id);
          if (!current) throw new Error('Missing original fixture job');
          const attempt = rechargeCardAttempt(current);
          if (!attempt) throw new Error('Missing trusted fixture attempt');
          const settled = await pool.finishBitBrowser(
            tx,
            current.id,
            { payment_status: 'paid', payment_attempted: true },
            true,
            attempt
          );
          await auto.updateJob(
            tx,
            current.id,
            {
              result: toV2JsonDocument({
                ...(current.result as Record<string, unknown>),
                _shared_card_attempt_v1: settled
              })
            },
            { factsOnly: true }
          );
        })
      )
    );
    const after = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } });
    expect(after).toMatchObject({
      successCount: 1,
      leaseOwner: before.leaseOwner,
      leaseId: before.leaseId,
      leaseVersion: before.leaseVersion
    });
    expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt);
    expect(after.leaseOwner).toBe(f.task.id);
    expect(
      rechargeCardAttempt(
        await db.idBusinessV2RechargeJob.findUniqueOrThrow({ where: { id: source.id } })
      )
    ).toMatchObject({ cardId: f.card.id, outcome: 'paid' });
    expect(await run((tx) => bitBrowserPendingCapacity(tx, f.card.id))).toBe(0);
  });

  it('已有一个比特未决时，两个不同账号并发只能取得剩余一份额度', async () => {
    const f = await fixture();
    await pendingJob(f.card.id);
    await db.onlineRechargeTask.update({
      where: { id: f.task.id },
      data: { sessionIdentityHash: encryption.hash(randomUUID()) }
    });
    const other = await db.onlineRechargeTask.create({
      data: {
        message: '隔离第二账号额度验收',
        status: 'running',
        plan: 'plus',
        leaseOwner: 'shared-card-ci',
        leaseId: randomUUID(),
        leaseVersion: 1,
        leaseExpiresAt: new Date(Date.now() + 120000),
        sessionIdentityHash: encryption.hash(randomUUID()),
        payload: { cardId: f.card.id }
      }
    });
    tasks.push(other.id);
    const results = await Promise.allSettled([
      worker.reserveCard(f.rpc),
      worker.reserveCard({ ...f.rpc, taskId: other.id, leaseId: other.leaseId! })
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value !== null)
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value === null)
    ).toHaveLength(1);
    const saved = await db.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.card.id } });
    expect([f.task.id, other.id]).toContain(saved.leaseOwner);
    expect(saved.successCount).toBe(0);
    expect(await run((tx) => bitBrowserPendingCapacity(tx, f.card.id))).toBe(1);
  });

  it('其他银行卡的非匹配 job 行被锁时，本卡额度读取不得因全表扫描被阻断', async () => {
    const f = await fixture();
    const otherCard = await fixture();
    const suffix = randomUUID().slice(-12);
    const unrelated = await pendingJob(otherCard.card.id, `00000000-0000-4000-8000-${suffix}`);
    await pendingJob(f.card.id, `ffffffff-ffff-4fff-bfff-${suffix}`);
    const locked = gate(),
      release = gate();
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM id_business_v2_recharge_jobs WHERE id = ${unrelated.id} FOR UPDATE`;
        locked.resolve();
        await release.promise;
      },
      { isolationLevel: 'Serializable', timeout: 10000 }
    );
    try {
      await locked.promise;
      const pending = await run(async (tx) => {
        await lockSharedBankCards(tx);
        return bitBrowserPendingCapacity(tx, f.card.id);
      });
      expect(pending).toBe(1);
    } finally {
      release.resolve();
      await holder;
    }
  }, 30000);
});
