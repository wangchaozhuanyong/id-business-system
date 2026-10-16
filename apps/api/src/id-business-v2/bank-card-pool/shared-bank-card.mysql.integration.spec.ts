import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';
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
    tasks: string[] = [];
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
  });
  afterAll(async () => {
    await db.onlineRechargeTask.deleteMany({ where: { id: { in: tasks } } });
    await db.onlineRechargeCard.deleteMany({ where: { id: { in: cards } } });
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
  it('未知付款超时仍占卡，明确成功并发重放只记一次', async () => {
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
});
