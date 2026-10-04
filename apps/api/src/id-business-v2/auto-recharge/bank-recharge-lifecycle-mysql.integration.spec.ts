import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { BankRechargeLifecycleService } from './bank-recharge-lifecycle.service';
import { BankRechargeSubscriptionReviewService } from './bank-recharge-subscription-review.service';
import { BankRechargeLifecycleRepository } from './persistence/bank-recharge-lifecycle.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';

const url = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !/^\/id_business_v2_(financial|rollback)_integrity_\d+$/.test(parsed.pathname)
  )
    throw new Error('生命周期测试仅允许专用本机隔离数据库');
}
const describeMysql = url ? describe : describe.skip;
describeMysql('银充生命周期真实 MySQL 原子闭环', () => {
  let prisma: PrismaService,
    service: BankRechargeLifecycleService,
    review: BankRechargeSubscriptionReviewService;
  let repository: BankRechargeLifecycleRepository, transactions: V2CommandTransactionManager;
  let operator: AuthenticatedUser;
  const accounts: string[] = [],
    orders: string[] = [],
    jobs: string[] = [];
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    const user = await prisma.user.create({
      data: {
        username: `closure-${randomUUID()}`,
        displayName: '隔离验收管理员',
        passwordHash: 'integration-only'
      }
    });
    operator = { id: user.id, roles: ['admin'], permissions: [] } as unknown as AuthenticatedUser;
    repository = new BankRechargeLifecycleRepository(prisma);
    transactions = new V2CommandTransactionManager(prisma);
    service = new BankRechargeLifecycleService(
      repository,
      transactions,
      new V2TransactionalAuditService()
    );
    review = new BankRechargeSubscriptionReviewService(
      repository,
      transactions,
      new V2TransactionalAuditService()
    );
  });
  afterAll(async () => {
    if (prisma) {
      // Only fixture IDs in a separately guarded temporary database; retain audit receipts.
      await prisma.idBusinessV2BankRechargeSubscription.deleteMany({
        where: { accountId: { in: accounts } }
      });
      await prisma.idBusinessV2BankRechargeOrder.deleteMany({ where: { id: { in: orders } } });
      await prisma.idBusinessV2RechargeJob.deleteMany({ where: { id: { in: jobs } } });
      await prisma.idBusinessV2ChatgptAccount.deleteMany({ where: { id: { in: accounts } } });
      await prisma.$disconnect();
    }
  });
  async function account(official = false) {
    const id = randomUUID();
    accounts.push(id);
    return prisma.idBusinessV2ChatgptAccount.create({
      data: {
        id,
        emailEncrypted: 'fixture-encrypted',
        emailHash: createHash('sha256').update(id).digest('hex'),
        emailMasked: `${id.slice(0, 4)}***@example.test`,
        passwordEncrypted: 'retained-encrypted-password',
        totpSecretEncrypted: 'retained-encrypted-totp',
        ...(official
          ? { officialAccountKey: createHash('sha256').update(`official-${id}`).digest('hex') }
          : {})
      }
    });
  }
  async function order(accountId: string, source: 'manual' | 'automatic' = 'manual') {
    const id = randomUUID();
    orders.push(id);
    let jobId: string | null = null;
    if (source === 'automatic') {
      const stored = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
        where: { id: accountId }
      });
      jobId = randomUUID();
      jobs.push(jobId);
      await prisma.idBusinessV2RechargeJob.create({
        data: {
          id: jobId,
          ownerId: operator.id,
          accountKey: stored.officialAccountKey,
          chatgptAccountId: accountId,
          plan: 'plus',
          action: 'server',
          state: 'finished',
          result: { status: 'fixture_only' },
          leaseUntil: new Date()
        }
      });
    }
    return prisma.idBusinessV2BankRechargeOrder.create({
      data: {
        id,
        orderNo: `CL-${id}`,
        source,
        accountId,
        rechargeJobId: jobId,
        chargeAmount: '100',
        chargeCurrencyCode: 'CNY',
        plan: 'plus',
        ...(source === 'automatic'
          ? { verifiedAt: new Date(), paymentEvidenceId: `pi_${id}` }
          : { manualEvidenceRef: `mistake-${id}` })
      }
    });
  }
  async function confirm(
    entity: 'account' | 'order',
    id: string,
    action: 'cancel' | 'delete' | 'restore'
  ) {
    const preview = await service.preview(entity, id, action);
    return {
      expectedUpdatedAt: preview.expectedUpdatedAt,
      previewFingerprint: preview.previewFingerprint,
      operationId: randomUUID(),
      reason: '本机隔离闭环验收',
      confirmNoPaymentOrReceipt: true
    };
  }
  it('账号删除→重放→恢复保留原密文及唯一键，恢复仍停用且候选不可用', async () => {
    const original = await account();
    const input = await confirm('account', original.id, 'delete');
    const first = await service.execute('account', original.id, 'delete', input, operator);
    expect(await service.execute('account', original.id, 'delete', input, operator)).toEqual(first);
    const repo = new BankRechargeRepository(prisma);
    expect(await prisma.$transaction((tx) => repo.findAccount(tx, original.id))).toBeNull();
    await expect(service.preview('account', original.id, 'restore')).rejects.toThrow(
      '另一管理员审批'
    );
    const saved = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: original.id }
    });
    expect(saved.status).toBe('disabled');
    expect(saved.deletedAt).not.toBeNull();
    expect(saved.emailHash).toBe(original.emailHash);
    expect(saved.passwordEncrypted).toBe(original.passwordEncrypted);
    expect(saved.totpSecretEncrypted).toBe(original.totpSecretEncrypted);
    expect(
      await prisma.auditLog.count({
        where: { objectId: original.id, action: { endsWith: '.delete' } }
      })
    ).toBe(1);
  });
  it('作废与回收站恢复不改变较新当前指针，不自动入账', async () => {
    const a = await account();
    const old = await order(a.id);
    const current = await order(a.id);
    await prisma.idBusinessV2BankRechargeSubscription.create({
      data: {
        accountId: a.id,
        currentOrderId: current.id,
        plan: 'plus',
        openedAt: new Date('2026-10-03T00:00:00Z'),
        dueAt: new Date('2026-11-03T00:00:00Z')
      }
    });
    const cancel = await confirm('order', old.id, 'cancel');
    await service.execute('order', old.id, 'cancel', cancel, operator);
    await service.execute(
      'order',
      old.id,
      'delete',
      await confirm('order', old.id, 'delete'),
      operator
    );
    await expect(service.preview('order', old.id, 'restore')).rejects.toThrow('另一管理员审批');
    const projection = await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
      where: { accountId: a.id }
    });
    expect(projection.currentOrderId).toBe(current.id);
    expect(projection.status).toBe('active');
    expect(
      (await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: old.id } }))
        .status
    ).toBe('cancelled');
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { sourceType: 'bank_recharge', sourceId: old.id }
      })
    ).toBe(0);
  });
  it('审计写入失败时订单作废与订阅投影一并回滚', async () => {
    const a = await account();
    const o = await order(a.id);
    await prisma.idBusinessV2BankRechargeSubscription.create({
      data: {
        accountId: a.id,
        currentOrderId: o.id,
        plan: 'plus',
        openedAt: new Date('2026-10-01T00:00:00Z')
      }
    });
    const failing = new BankRechargeLifecycleService(repository, transactions, {
      append: async () => {
        throw new Error('simulated audit failure');
      }
    } as never);
    await expect(
      failing.execute('order', o.id, 'cancel', await confirm('order', o.id, 'cancel'), operator)
    ).rejects.toThrow('simulated audit failure');
    expect(
      (await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: o.id } })).status
    ).toBe('pending_details');
    expect(
      (
        await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
          where: { accountId: a.id }
        })
      ).status
    ).toBe('active');
  });
  it('同一操作并发确认只提交一次；自动已付款单不可作废', async () => {
    const a = await account();
    const o = await order(a.id);
    const input = await confirm('order', o.id, 'cancel');
    const results = await Promise.allSettled([
      service.execute('order', o.id, 'cancel', input, operator),
      service.execute('order', o.id, 'cancel', input, operator)
    ]);
    expect(results.some((item) => item.status === 'fulfilled')).toBe(true);
    await service.execute('order', o.id, 'cancel', input, operator);
    expect(
      await prisma.auditLog.count({
        where: { objectId: o.id, action: 'id_business_v2.bank_recharge.order.cancel' }
      })
    ).toBe(1);
    const paid = await order(a.id, 'automatic');
    await expect(service.preview('order', paid.id, 'cancel')).rejects.toThrow('付款');
  });
  it('历史单日期核对不能覆盖新订阅，正确日期建立投影且审计失败全回滚', async () => {
    const a = await account(true);
    const old = await order(a.id, 'automatic');
    const current = await order(a.id);
    await prisma.idBusinessV2BankRechargeSubscription.create({
      data: {
        accountId: a.id,
        currentOrderId: current.id,
        plan: 'plus',
        openedAt: new Date('2026-10-03T00:00:00Z')
      }
    });
    const preview = await review.preview(old.id);
    const command = {
      expectedUpdatedAt: preview.expectedUpdatedAt,
      expectedCurrentOrderId: preview.expectedCurrentOrderId,
      expectedSubscriptionUpdatedAt: preview.expectedSubscriptionUpdatedAt,
      openedAt: '2026-10-01T00:00:00.000Z',
      dueAt: '2026-11-01T00:00:00.000Z',
      dateEvidenceRef: 'official-reference',
      reason: '日期核对',
      operationId: randomUUID(),
      confirmedOfficialDates: true,
      makeCurrent: true
    };
    await expect(review.verify(old.id, command, operator)).rejects.toThrow('历史或同时间');
    const b = await account(true);
    const fresh = await order(b.id, 'automatic');
    const p = await review.preview(fresh.id);
    const clean = {
      expectedUpdatedAt: p.expectedUpdatedAt,
      expectedCurrentOrderId: null,
      expectedSubscriptionUpdatedAt: null,
      openedAt: command.openedAt,
      dueAt: command.dueAt,
      dateEvidenceRef: 'official-reference',
      reason: '日期核对',
      operationId: randomUUID(),
      confirmedOfficialDates: true,
      makeCurrent: true
    };
    const failing = new BankRechargeSubscriptionReviewService(repository, transactions, {
      append: async () => {
        throw new Error('review audit failure');
      }
    } as never);
    await expect(failing.verify(fresh.id, clean, operator)).rejects.toThrow('review audit failure');
    expect(
      await prisma.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId: b.id } })
    ).toBeNull();
    expect(
      (await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: fresh.id } }))
        .openedAt
    ).toBeNull();
    await review.verify(fresh.id, clean, operator);
    expect(
      (
        await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
          where: { accountId: b.id }
        })
      ).currentOrderId
    ).toBe(fresh.id);
  });
  it('official past dates enter expired warnings without returning the account to waiting', async () => {
    const a = await account(true);
    const recorded = await order(a.id, 'automatic');
    const preview = await review.preview(recorded.id);
    const dueAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await review.verify(
      recorded.id,
      {
        expectedUpdatedAt: preview.expectedUpdatedAt,
        expectedCurrentOrderId: null,
        expectedSubscriptionUpdatedAt: null,
        openedAt: new Date(dueAt.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        dueAt: dueAt.toISOString(),
        dateEvidenceRef: 'past-official-period',
        reason: '核对真实历史订阅到期',
        operationId: randomUUID(),
        confirmedOfficialDates: true,
        makeCurrent: true
      },
      operator
    );
    expect(
      (
        await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
          where: { accountId: a.id }
        })
      ).status
    ).toBe('expired');
    const warnings = await new BankRechargeQueryRepository(prisma).renewalWarnings();
    expect(warnings.items.find((item) => item.orderId === recorded.id)?.warningState).toBe(
      'expired'
    );
    await prisma.idBusinessV2BankRechargeSubscription.update({
      where: { accountId: a.id },
      data: { status: 'cancelled' }
    });
    expect(
      (await new BankRechargeQueryRepository(prisma).renewalWarnings()).items.some(
        (item) => item.orderId === recorded.id
      )
    ).toBe(false);
  });
});
