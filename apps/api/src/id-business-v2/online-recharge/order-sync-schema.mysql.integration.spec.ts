import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';

const enabled = process.env.ONLINE_RECHARGE_MYSQL_TEST === '1';
if (enabled) {
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    !['/id_business_v2_online_recharge_fixture', '/online_recharge_test_audit'].includes(
      target.pathname
    )
  ) {
    throw new Error('订单同步结构测试仅允许专用隔离数据库');
  }
}
const suite = enabled ? describe : describe.skip;

suite('线上订单同步真实 MySQL 约束和原子性', () => {
  const db = new PrismaService();
  const orderIds: string[] = [],
    taskIds: string[] = [],
    cardIds: string[] = [],
    bitCardIds: string[] = [],
    bitJobIds: string[] = [];
  beforeAll(() => db.$connect());
  afterAll(async () => {
    await db.onlineRechargeOrderSync.deleteMany({ where: { taskId: { in: taskIds } } });
    await db.idBusinessV2BankRechargeOrder.deleteMany({ where: { id: { in: orderIds } } });
    await db.onlineRechargeTask.deleteMany({ where: { id: { in: taskIds } } });
    await db.onlineRechargeCard.deleteMany({ where: { id: { in: cardIds } } });
    await db.idBusinessV2RechargeJob.deleteMany({ where: { id: { in: bitJobIds } } });
    await db.idBusinessV2BankRechargeCard.deleteMany({ where: { id: { in: bitCardIds } } });
    await db.$disconnect();
  });
  function orderData() {
    const id = randomUUID();
    orderIds.push(id);
    return { id, orderNo: `O-${id}`, source: 'manual' as const, plan: 'plus' };
  }
  async function task() {
    const id = randomUUID();
    taskIds.push(id);
    return db.onlineRechargeTask.create({
      data: {
        id,
        operation: 'recharge',
        status: 'succeeded',
        plan: 'plus',
        message: '仅隔离结构验收，无付款'
      }
    });
  }
  async function sourceFixtures() {
    const source = await task();
    const cardId = randomUUID();
    cardIds.push(cardId);
    const onlineCard = await db.onlineRechargeCard.create({
      data: {
        id: cardId,
        numberEncrypted: 'synthetic-encrypted-only',
        numberHash: cardId.replaceAll('-', '').padEnd(64, '0'),
        last4: '1234',
        expiryMonth: 12,
        expiryYear: 2030
      }
    });
    const bitCardId = randomUUID();
    bitCardIds.push(bitCardId);
    const bitCard = await db.idBusinessV2BankRechargeCard.create({
      data: { id: bitCardId, label: '隔离比特卡', last4: '4321', currencyCode: 'PHP' }
    });
    const bitJobId = randomUUID();
    bitJobIds.push(bitJobId);
    const bitJob = await db.idBusinessV2RechargeJob.create({
      data: {
        id: bitJobId,
        ownerId: 'synthetic-structure-test',
        plan: 'plus',
        action: 'server',
        state: 'finished',
        result: { status: 'fixture_only' },
        leaseUntil: new Date()
      }
    });
    return { source, onlineCard, bitCard, bitJob };
  }
  it('旧订单保持原编号和默认渠道；精确金额保持 Decimal', async () => {
    const data = orderData();
    const row = await db.idBusinessV2BankRechargeOrder.create({
      data: { ...data, chargeAmount: '0.0012', chargeCurrencyCode: 'PHP' }
    });
    expect(row.orderNo).toBe(data.orderNo);
    expect(row.channel).toBe('bitbrowser');
    expect(row.chargeAmount?.toString()).toBe('0.0012');
    expect(row.onlineRechargeTaskId).toBeNull();
  });
  it('未知线上金额可空，不能把比特订单写成未知实付', async () => {
    const row = await db.idBusinessV2BankRechargeOrder.create({
      data: { ...orderData(), channel: 'online' }
    });
    expect(row.chargeAmount).toBeNull();
    expect(row.chargeCurrencyCode).toBeNull();
    expect(row.status).toBe('pending_details');
    await expect(db.idBusinessV2BankRechargeOrder.create({ data: orderData() })).rejects.toThrow();
  });
  it('插入触发器拒绝两种渠道混用原任务和银行卡引用', async () => {
    const { source, onlineCard, bitCard, bitJob } = await sourceFixtures();
    for (const data of [
      { channel: 'bitbrowser' as const, onlineRechargeTaskId: source.id },
      { channel: 'bitbrowser' as const, onlineRechargeCardId: onlineCard.id },
      { channel: 'online' as const, cardId: bitCard.id },
      { channel: 'online' as const, rechargeJobId: bitJob.id }
    ]) {
      await expect(
        db.idBusinessV2BankRechargeOrder.create({
          data: { ...orderData(), ...data, chargeAmount: '1', chargeCurrencyCode: 'PHP' }
        })
      ).rejects.toThrow();
    }
  });
  it('更新触发器拒绝跨渠道引用和保留其他渠道来源的切换，原记录不变', async () => {
    const { source, onlineCard, bitCard, bitJob } = await sourceFixtures();
    const unlinkedSource = await task();
    const bit = await db.idBusinessV2BankRechargeOrder.create({
      data: { ...orderData(), cardId: bitCard.id, chargeAmount: '1', chargeCurrencyCode: 'PHP' }
    });
    const online = await db.idBusinessV2BankRechargeOrder.create({
      data: {
        ...orderData(),
        channel: 'online',
        onlineRechargeTaskId: source.id,
        onlineRechargeCardId: onlineCard.id,
        chargeAmount: '1',
        chargeCurrencyCode: 'PHP'
      }
    });
    const updates: Prisma.IdBusinessV2BankRechargeOrderUpdateArgs[] = [
      { where: { id: bit.id }, data: { onlineRechargeTaskId: unlinkedSource.id } },
      { where: { id: bit.id }, data: { onlineRechargeCardId: onlineCard.id } },
      { where: { id: online.id }, data: { cardId: bitCard.id } },
      { where: { id: online.id }, data: { rechargeJobId: bitJob.id } },
      { where: { id: bit.id }, data: { channel: 'online' as const } },
      { where: { id: online.id }, data: { channel: 'bitbrowser' as const } }
    ];
    for (const args of updates) {
      await expect(db.idBusinessV2BankRechargeOrder.update(args)).rejects.toThrow();
    }
    expect(
      await db.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: bit.id } })
    ).toMatchObject({
      channel: 'bitbrowser',
      cardId: bitCard.id,
      onlineRechargeTaskId: null,
      onlineRechargeCardId: null
    });
    expect(
      await db.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: online.id } })
    ).toMatchObject({
      channel: 'online',
      cardId: null,
      rechargeJobId: null,
      onlineRechargeTaskId: source.id,
      onlineRechargeCardId: onlineCard.id
    });
  });
  it('并发同步原任务只能建立一张订单，回收站仍占用唯一身份', async () => {
    const source = await task();
    const attempts = await Promise.allSettled(
      [1, 2].map(() =>
        db.idBusinessV2BankRechargeOrder.create({
          data: { ...orderData(), channel: 'online', onlineRechargeTaskId: source.id }
        })
      )
    );
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const existing = await db.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { onlineRechargeTaskId: source.id }
    });
    await db.idBusinessV2BankRechargeOrder.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() }
    });
    await expect(
      db.idBusinessV2BankRechargeOrder.create({
        data: { ...orderData(), channel: 'online', onlineRechargeTaskId: source.id }
      })
    ).rejects.toThrow();
    expect(
      await db.idBusinessV2BankRechargeOrder.count({ where: { onlineRechargeTaskId: source.id } })
    ).toBe(1);
  });
  it('建单和确认同步状态同事务失败时全部回滚', async () => {
    const source = await task();
    await expect(
      db.$transaction(async (tx) => {
        await tx.idBusinessV2BankRechargeOrder.create({
          data: { ...orderData(), channel: 'online', onlineRechargeTaskId: source.id }
        });
        await tx.onlineRechargeOrderSync.create({ data: { taskId: source.id, status: 'synced' } });
        throw new Error('synthetic rollback');
      })
    ).rejects.toThrow('synthetic rollback');
    expect(
      await db.onlineRechargeOrderSync.findUnique({ where: { taskId: source.id } })
    ).toBeNull();
    expect(
      await db.idBusinessV2BankRechargeOrder.findUnique({
        where: { onlineRechargeTaskId: source.id }
      })
    ).toBeNull();
  });
  it('删除线上卡保留订单快照，订单关联的原任务不能硬删除', async () => {
    const source = await task();
    const cardId = randomUUID();
    cardIds.push(cardId);
    await db.onlineRechargeCard.create({
      data: {
        id: cardId,
        numberEncrypted: 'synthetic-encrypted-only',
        numberHash: cardId.replaceAll('-', '').padEnd(64, '0'),
        last4: '1234',
        expiryMonth: 12,
        expiryYear: 2030
      }
    });
    const row = await db.idBusinessV2BankRechargeOrder.create({
      data: {
        ...orderData(),
        channel: 'online',
        onlineRechargeTaskId: source.id,
        onlineRechargeCardId: cardId,
        cardLast4: '1234',
        cardLabelSnapshot: '隔离线上卡',
        chargeAmount: '0',
        chargeCurrencyCode: 'PHP',
        onlineSourceSnapshot: { zeroAmountChange: true }
      }
    });
    await db.onlineRechargeCard.delete({ where: { id: cardId } });
    const saved = await db.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { id: row.id }
    });
    expect(saved.onlineRechargeCardId).toBeNull();
    expect(saved.cardLast4).toBe('1234');
    expect(saved.cardLabelSnapshot).toBe('隔离线上卡');
    expect(saved.chargeAmount?.isZero()).toBe(true);
    await expect(db.onlineRechargeTask.delete({ where: { id: source.id } })).rejects.toThrow();
  });
});
