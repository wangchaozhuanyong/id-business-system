import { ConflictException } from '@nestjs/common';
import type { OnlineRechargeTask } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { BankRechargeOnlineOrderService } from '../auto-recharge/public-api';
import type { V2CommandTransaction } from '../runtime/public-api';
import type { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { verifiedOnlineOrderFact } from './order-sync-facts';
import { OnlineRechargeOrderSyncService } from './order-sync.service';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';

const accountId = randomUUID();
const operator = {
  id: randomUUID(),
  roles: ['admin'],
  permissions: ['id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage']
} as unknown as AuthenticatedUser;
const syntheticSession = JSON.stringify({
  accessToken: `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.unused`
});
function task(overrides: Partial<OnlineRechargeTask> = {}): OnlineRechargeTask {
  const row = {
    id: randomUUID(),
    operation: 'recharge',
    status: 'succeeded',
    plan: 'plus',
    provider: 'local',
    operatorId: operator.id,
    sessionEncrypted: 'synthetic-encrypted',
    emailEncrypted: null,
    cardId: randomUUID(),
    cardLast4: '4242',
    confirmedPaid: true,
    paymentStarted: true,
    leaseVersion: 1,
    payload: {},
    createdAt: new Date('2026-10-16T01:00:00Z'),
    updatedAt: new Date('2026-10-16T01:01:00Z'),
    result: {
      confirmedPaid: true,
      confirmation: {
        source: 'subscription',
        querySucceeded: true,
        verified: true,
        hasActiveSubscription: true,
        accountId,
        expectedAccountId: accountId,
        targetPlan: 'plus',
        observedPlan: 'chatgptplus',
        tierVerified: true,
        observedCanonicalPlan: 'plus'
      }
    },
    ...overrides
  } as OnlineRechargeTask;
  if (!overrides.result)
    (row.result as Record<string, unknown>).paymentEvidence = {
      verified: true,
      source: 'checkout',
      taskId: row.id,
      accountId,
      targetPlan: row.plan,
      cardId: row.cardId,
      cardLast4: row.cardLast4,
      paymentReference: `pi_${row.id}`
    };
  if (row.provider === 'third_party' && !overrides.result) {
    row.providerOrderId = 'synthetic-order';
    row.providerTaskId = 'synthetic-task';
    Object.assign(row.result as object, {
      success: true,
      providerOrderId: row.providerOrderId,
      providerTaskId: row.providerTaskId,
      providerResult: {
        order_id: row.providerOrderId,
        task_id: row.providerTaskId,
        status: 'succeeded',
        result: { ok: true }
      }
    });
  }
  return row;
}
function upgrade(amount = '3.2500') {
  const row = task({ plan: 'pro_500', cardId: randomUUID(), cardLast4: '4242' });
  const context = {
    kind: 'upgrade',
    sourcePlan: 'plus',
    targetPlan: 'pro_500',
    accountId,
    cardId: row.cardId,
    cardLast4: row.cardLast4,
    amount,
    currency: 'PHP',
    quoteId: 'quote-fixture'
  };
  row.payload = { paymentContext: context };
  row.result = {
    confirmedPaid: amount !== '0',
    subscriptionChangedVerified: true,
    paymentEvidence: {
      ...context,
      source: 'subscription_change',
      verified: true,
      country: 'PH',
      checkoutId: 'cs_synthetic',
      paymentReference: 'pi_synthetic'
    },
    confirmation: {
      source: 'subscription',
      querySucceeded: true,
      verified: true,
      hasActiveSubscription: true,
      accountId,
      expectedAccountId: accountId,
      targetPlan: 'pro_500',
      tierVerified: true,
      observedCanonicalPlan: 'pro_500',
      observedPlan: 'synthetic-pro-500'
    }
  };
  row.confirmedPaid = amount !== '0';
  return row;
}

function fixture(initial = [task()]) {
  const rows = initial.map((row) => ({
    ...row,
    rechargeOrder: null as null | { id: string; orderNo: string }
  }));
  const queues = new Map<
    string,
    {
      taskId: string;
      status: string;
      attempts: number;
      nextAttemptAt: Date;
      lastErrorCode: string | null;
    }
  >();
  const tx = {
    onlineRechargeTask: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((item) => item.id === where.id);
        return row ? { ...row, orderSync: queues.get(row.id) ?? null } : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
        rows
          .filter(
            (row) =>
              row.operation === 'recharge' &&
              row.status === 'succeeded' &&
              (!where.id || row.id > where.id.gt)
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, take)
      )
    },
    onlineRechargeOrderSync: {
      findUnique: vi.fn(
        async ({ where }: { where: { taskId: string } }) => queues.get(where.taskId) ?? null
      ),
      findMany: vi.fn(async () =>
        [...queues.values()]
          .filter(
            (queue) => queue.status === 'pending' && queue.nextAttemptAt.getTime() <= Date.now()
          )
          .slice(0, 20)
      ),
      upsert: vi.fn(
        async ({
          where,
          update
        }: {
          where: { taskId: string };
          update: Record<string, unknown>;
        }) => {
          const previous = queues.get(where.taskId);
          const queue = previous
            ? { ...previous, ...update }
            : {
                taskId: where.taskId,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: new Date(),
                lastErrorCode: null
              };
          queues.set(where.taskId, queue);
          return queue;
        }
      ),
      update: vi.fn(
        async ({ where, data }: { where: { taskId: string }; data: Record<string, unknown> }) => {
          const row = queues.get(where.taskId)!;
          Object.assign(row, {
            ...data,
            ...(typeof data.attempts === 'object' ? { attempts: row.attempts + 1 } : {})
          });
          return row;
        }
      )
    },
    onlineRechargeCard: { findUnique: vi.fn(async () => null) }
  };
  const repository = {
    read: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    transaction: vi.fn(async (_key: string, work: (client: typeof tx) => unknown) => work(tx)),
    log: vi.fn(async () => undefined)
  };
  const sync = vi.fn(async (_tx: unknown, fact: { taskId: string }) => {
    const row = rows.find((item) => item.id === fact.taskId)!;
    row.rechargeOrder ??= { id: randomUUID(), orderNo: 'OR-FIXTURE' };
    return row.rechargeOrder;
  });
  const service = new OnlineRechargeOrderSyncService(
    new OnlineRechargeOrderSyncRepository(
      repository as unknown as OnlineRechargeRepository,
      { decrypt: () => syntheticSession } as unknown as FieldEncryptionService,
      { syncInTransaction: sync } as unknown as BankRechargeOnlineOrderService
    )
  );
  return { service, repository, tx, queues, sync, rows };
}
afterEach(() => vi.useRealTimers());

describe('线上订单事实适配', () => {
  it('正式本地和第三方均只用同账号准确档位成功证据，未知金额/币种/日期不猜测', () => {
    for (const provider of ['local', 'third_party'] as const) {
      const row = task({ provider });
      Object.assign(row.result as object, {
        amount: '500',
        currency: 'USD',
        expiresAt: '2028-01-01'
      });
      const source = verifiedOnlineOrderFact(row, accountId);
      expect(source).toMatchObject({
        eligible: true,
        fact: {
          provider,
          chargeAmount: null,
          chargeCurrencyCode: null,
          chargeCountryCode: null,
          openedAt: null,
          dueAt: null
        }
      });
    }
  });
  it('保留升级实际补差及零元套餐变更，不使用套餐标价', () => {
    expect(verifiedOnlineOrderFact(upgrade(), accountId)).toMatchObject({
      eligible: true,
      fact: {
        chargeAmount: '3.2500',
        chargeCurrencyCode: 'PHP',
        paymentKind: 'upgrade',
        zeroAmountChange: false,
        paymentReference: 'pi_synthetic',
        checkoutIdentifier: 'cs_synthetic'
      }
    });
    expect(verifiedOnlineOrderFact(upgrade('0'), accountId)).toMatchObject({
      eligible: true,
      fact: {
        chargeAmount: '0',
        zeroAmountChange: true
      }
    });
  });
  it('官网UUID先按现有比特身份协议转64位摘要，证明校验仍比较原始账号', () => {
    const source = verifiedOnlineOrderFact(task(), accountId);
    expect(source).toMatchObject({
      eligible: true,
      fact: {
        accountKey: createHash('sha256').update(accountId).digest('hex')
      }
    });
    if (source.eligible) expect(source.fact.accountKey).not.toBe(accountId);
  });
  it('排除调试、失败、待核对、订阅、续费和其他账号/不准确Pro档位', () => {
    for (const operation of ['debug', 'subscription', 'renewal'] as const)
      expect(verifiedOnlineOrderFact(task({ operation }), accountId).eligible).toBe(false);
    for (const status of ['failed', 'awaiting_review'] as const)
      expect(verifiedOnlineOrderFact(task({ status }), accountId).eligible).toBe(false);
    expect(verifiedOnlineOrderFact(task(), randomUUID()).eligible).toBe(false);
    const row = upgrade();
    (row.result as Record<string, unknown>).confirmation = {
      ...((task().result as Record<string, unknown>).confirmation as object),
      targetPlan: 'pro_500'
    };
    expect(verifiedOnlineOrderFact(row, accountId).eligible).toBe(false);
  });
  it('账单成功或模糊成功不能替代付款证据；报价冲突不能覆盖已核实来源', () => {
    expect(verifiedOnlineOrderFact(task({ confirmedPaid: false }), accountId).eligible).toBe(false);
    const row = upgrade();
    ((row.result as Record<string, unknown>).paymentEvidence as Record<string, unknown>).amount =
      '500';
    expect(verifiedOnlineOrderFact(row, accountId)).toEqual({
      eligible: false,
      reasonCode: 'PAYMENT_EVIDENCE_CONFLICT'
    });
    const vague = task();
    delete (vague.result as Record<string, unknown>).paymentEvidence;
    expect(verifiedOnlineOrderFact(vague, accountId)).toMatchObject({
      eligible: false,
      reasonCode: 'CURRENT_PAYMENT_EVIDENCE_MISSING'
    });
  });
  it('旧本地任务要求原任务、实际卡及当次付款凭据，结算链接本身不能证明付款', () => {
    for (const mutate of [
      (evidence: Record<string, unknown>) => delete evidence.paymentReference,
      (evidence: Record<string, unknown>) => (evidence.taskId = randomUUID()),
      (evidence: Record<string, unknown>) => (evidence.cardId = randomUUID()),
      (evidence: Record<string, unknown>) => (evidence.cardLast4 = '1234')
    ]) {
      const row = task();
      const evidence = (row.result as Record<string, unknown>).paymentEvidence as Record<
        string,
        unknown
      >;
      evidence.checkoutId = 'cs_synthetic';
      mutate(evidence);
      expect(verifiedOnlineOrderFact(row, accountId)).toMatchObject({
        eligible: false,
        reasonCode: 'CURRENT_PAYMENT_EVIDENCE_MISSING'
      });
    }
    expect(
      verifiedOnlineOrderFact(task({ cardId: null, cardLast4: null }), accountId).eligible
    ).toBe(false);
  });
  it('第三方必须匹配实际原单和终态业务结果，金额只读明确实际字段', () => {
    const row = task({ provider: 'third_party' });
    const provider = (row.result as Record<string, unknown>).providerResult as Record<
      string,
      unknown
    >;
    provider.amount = '500';
    provider.currency = 'USD';
    expect(verifiedOnlineOrderFact(row, accountId)).toMatchObject({
      eligible: true,
      fact: {
        chargeAmount: null,
        chargeCurrencyCode: null,
        paymentReference: 'third_party:synthetic-order'
      }
    });
    provider.actual_paid_amount = '3.25';
    provider.paid_currency = 'PHP';
    expect(verifiedOnlineOrderFact(row, accountId)).toMatchObject({
      eligible: true,
      fact: {
        chargeAmount: '3.25',
        chargeCurrencyCode: 'PHP'
      }
    });
    provider.order_id = 'another-order';
    expect(verifiedOnlineOrderFact(row, accountId).eligible).toBe(false);
  });
  it('第三方原单复查输出穿过订单边界，Pro500准确身份/终态凭据可同步且不伪造结算上下文', async () => {
    const recheck = createRequire(resolve(__dirname, 'order-sync.spec.ts'))(
      resolve(__dirname, 'engine/confirmation.cjs')
    ).recheck as (
      task: Record<string, unknown>,
      cfg: unknown,
      injected: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
    const row = task({ provider: 'third_party', plan: 'pro_500' });
    const receipt = {
      order_id: row.providerOrderId,
      task_id: row.providerTaskId,
      status: 'success',
      result: { ok: true },
      actual_paid_amount: '250.1250',
      paid_currency: 'PHP',
      api_key: 'synthetic-sensitive-value'
    };
    row.result = (await recheck(
      {
        plan: row.plan,
        provider: row.provider,
        session: syntheticSession,
        payload: {
          originalOperation: 'recharge',
          originalProvider: row.provider,
          recheckTaskId: row.id,
          providerOrderId: row.providerOrderId,
          providerTaskId: row.providerTaskId
        }
      },
      {},
      {
        pro500Name: 'synthetic-pro-500',
        client: {
          queryTask: async () => ({ success: true, rawStatus: 'success', data: receipt }),
          submitOrder: vi.fn(() => {
            throw new Error('复查不得重新付款');
          })
        },
        query: async () => ({
          ok: true,
          data: {
            upstreamAccountId: accountId,
            rawPlan: 'synthetic-pro-500',
            hasActiveSubscription: true
          }
        })
      }
    )) as OnlineRechargeTask['result'];
    expect(JSON.stringify(row.result)).not.toContain('synthetic-sensitive-value');
    expect(verifiedOnlineOrderFact(row, accountId)).toMatchObject({
      eligible: true,
      fact: {
        taskId: row.id,
        plan: 'pro_500',
        paymentKind: 'unknown',
        chargeAmount: '250.1250',
        chargeCurrencyCode: 'PHP',
        paymentReference: 'third_party:synthetic-order'
      }
    });
    const result = row.result as Record<string, unknown>;
    (result.providerResult as Record<string, unknown>).task_id = 'another-provider-task';
    expect(verifiedOnlineOrderFact(row, accountId).eligible).toBe(false);
  });
});

describe('持久同步队列与历史补录', () => {
  it('同原任务多次登记和重复poll仅建一张单，同事务确认并刷新两域', async () => {
    const f = fixture(),
      row = f.rows[0]!;
    await f.service.enqueueInTransaction(f.tx as unknown as V2CommandTransaction, row.id);
    await f.service.enqueueInTransaction(f.tx as unknown as V2CommandTransaction, row.id);
    await f.service.processPending();
    await f.service.processPending();
    expect(f.queues.size).toBe(1);
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.queues.get(row.id)?.status).toBe('synced');
    expect(f.repository.transaction).toHaveBeenCalledWith(`task:${row.id}`, expect.any(Function), [
      'online-recharge',
      'auto-recharge'
    ]);
    expect(await f.service.summary(row.id)).toMatchObject({
      status: 'synced',
      orderNo: 'OR-FIXTURE'
    });
  });
  it('临时故障退避，重启继续原同步，不改变成功任务或执行付款；第五次转待核对', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      row = f.rows[0]!;
    f.sync.mockRejectedValue(new Error('synthetic-sensitive-error-body'));
    await f.service.enqueueInTransaction(f.tx as unknown as V2CommandTransaction, row.id);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const now = Date.now();
      await f.service.processPending();
      expect(f.queues.get(row.id)?.attempts).toBe(attempt);
      const delayMs = 10 * 2 ** (attempt - 1) * 1000;
      expect(f.queues.get(row.id)?.nextAttemptAt.getTime()).toBe(now + delayMs);
      if (attempt < 5) {
        vi.advanceTimersByTime(delayMs - 1);
        await f.service.processPending();
        expect(f.sync).toHaveBeenCalledTimes(attempt);
        vi.advanceTimersByTime(1);
      }
    }
    expect(f.queues.get(row.id)?.status).toBe('needs_review');
    expect(row.status).toBe('succeeded');
    expect(row.confirmedPaid).toBe(true);
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain(
      'synthetic-sensitive-error-body'
    );
    expect(f.queues.get(row.id)?.lastErrorCode).toBe('ORDER_SYNC_TEMPORARY_FAILURE');
  });
  it('证据冲突立即停止重试，单笔补同步不重新执行充值', async () => {
    const f = fixture(),
      row = f.rows[0]!;
    f.sync.mockRejectedValue(new ConflictException('synthetic-details'));
    await f.service.enqueue(row.id, operator);
    await f.service.processPending();
    expect(f.queues.get(row.id)).toMatchObject({
      status: 'needs_review',
      attempts: 1,
      lastErrorCode: 'ORDER_EVIDENCE_CONFLICT'
    });
    expect(row.status).toBe('succeeded');
  });
  it('已有关联订单（含回收站）直接确认队列，不重新建单或要求已清除的会话', async () => {
    const f = fixture(),
      row = f.rows[0]!;
    row.rechargeOrder = { id: randomUUID(), orderNo: 'OR-RECYCLED' };
    row.sessionEncrypted = null;
    await f.service.enqueueInTransaction(f.tx as unknown as V2CommandTransaction, row.id);
    await f.service.processPending();
    expect(f.sync).not.toHaveBeenCalled();
    expect(f.queues.get(row.id)?.status).toBe('synced');
  });
  it('预览排除debug并含已软删除订单，令牌绑定操作者和任务版本且只用一次', async () => {
    const f = fixture([task(), task(), task({ operation: 'debug' })]);
    f.rows[1]!.rechargeOrder = { id: randomUUID(), orderNo: 'OR-RECYCLED' };
    const preview = await f.service.preview({}, operator);
    expect(preview).toMatchObject({ total: 2, eligible: 1, existing: 1, insufficient: 0 });
    await expect(
      f.service.backfill({ previewToken: preview.previewToken }, { ...operator, id: randomUUID() })
    ).rejects.toThrow('预览已失效');
    f.rows[0]!.updatedAt = new Date();
    expect(await f.service.backfill({ previewToken: preview.previewToken }, operator)).toEqual({
      queued: 0,
      existing: 1,
      skipped: 1
    });
    expect(f.queues.size).toBe(0);
    await expect(
      f.service.backfill({ previewToken: preview.previewToken }, operator)
    ).rejects.toThrow('预览已失效');
  });
  it('分页超过100条仍统计全部并能进入下一批；历史确认只入同步队列', async () => {
    const f = fixture(Array.from({ length: 102 }, () => task()));
    const first = await f.service.preview({}, operator);
    expect(first.total).toBe(102);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.service.preview({ cursor: first.nextCursor }, operator);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(await f.service.backfill({ previewToken: second.previewToken }, operator)).toEqual({
      queued: 2,
      existing: 0,
      skipped: 0
    });
    expect(f.sync).not.toHaveBeenCalled();
  });
  it('预览过期不补录；同步器重建后仍处理数据库中的原队列', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      row = f.rows[0]!;
    const preview = await f.service.preview({}, operator);
    vi.advanceTimersByTime(10 * 60000 + 1);
    await expect(
      f.service.backfill({ previewToken: preview.previewToken }, operator)
    ).rejects.toThrow('预览已失效');
    await f.service.enqueueInTransaction(f.tx as unknown as V2CommandTransaction, row.id);
    const restarted = new OnlineRechargeOrderSyncService(
      new OnlineRechargeOrderSyncRepository(
        f.repository as unknown as OnlineRechargeRepository,
        { decrypt: () => syntheticSession } as unknown as FieldEncryptionService,
        { syncInTransaction: f.sync } as unknown as BankRechargeOnlineOrderService
      )
    );
    await restarted.processPending();
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('succeeded');
  });
  it('同步新动作逐项检查管理员和读写权限，撤销管理权限后旧预览不可执行', async () => {
    const f = fixture();
    const readonlyAdmin = {
      ...operator,
      permissions: ['id_business_v2.online_recharge.read']
    };
    const preview = await f.service.preview({}, readonlyAdmin);
    await expect(f.service.enqueue(f.rows[0]!.id, readonlyAdmin)).rejects.toThrow('权限');
    await expect(
      f.service.backfill({ previewToken: preview.previewToken }, readonlyAdmin)
    ).rejects.toThrow('权限');
    for (const user of [
      { ...operator, permissions: ['id_business_v2.online_recharge.manage'] },
      { ...operator, roles: ['employee'] }
    ]) {
      await expect(f.service.preview({}, user)).rejects.toThrow('权限');
      await expect(f.service.enqueue(f.rows[0]!.id, user)).rejects.toThrow('权限');
      await expect(
        f.service.backfill({ previewToken: preview.previewToken }, user)
      ).rejects.toThrow('权限');
    }
    expect(f.queues.size).toBe(0);
    expect(f.repository.log).not.toHaveBeenCalled();
    expect(
      await f.service.backfill({ previewToken: preview.previewToken }, operator)
    ).toMatchObject({ queued: 1 });
  });
});
