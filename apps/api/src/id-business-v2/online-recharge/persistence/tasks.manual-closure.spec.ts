import { randomUUID, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { OnlineRechargeTask } from '@prisma/client';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { OnlineRechargeSettingsService } from '../settings.service';
import type { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import type { OnlineRechargeOrderSyncService } from '../order-sync.service';
import type { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeTasksRepository } from './tasks.repository';

function fixture() {
  const operator: AuthenticatedUser = {
    id: randomUUID(),
    username: 'fixture-admin',
    displayName: '合成管理员',
    roles: ['admin'],
    permissions: []
  };
  const cardId = randomUUID(),
    taskId = randomUUID();
  const state = {
    row: {
      id: taskId,
      operation: 'recharge',
      provider: 'local',
      plan: 'pro_20x',
      status: 'awaiting_review',
      paymentStarted: true,
      confirmedPaid: false,
      cardId,
      cardLast4: '3211',
      sessionIdentityHash: 'synthetic-account-identity',
      sessionEncrypted: 'synthetic-protected-session',
      leaseOwner: null,
      leaseId: null,
      leaseExpiresAt: null,
      leaseVersion: 3,
      deletedAt: null,
      updatedAt: new Date('2026-10-17T07:00:00.000Z'),
      progress: 100,
      payload: {
        paymentContext: { quoteId: 'synthetic-original-quote' },
        reconciliation: {
          version: 1,
          attempts: 0,
          stopped: true,
          reasonCode: 'legacy_original_identity_missing',
          nextAttemptAt: null
        }
      },
      result: {
        success: false,
        resultUnknown: true,
        error: '原验证失败',
        errorCode: 'VERIFICATION_UNSUPPORTED'
      }
    } as unknown as OnlineRechargeTask,
    card: {
      id: cardId,
      last4: '3211',
      status: 'active',
      leaseOwner: taskId,
      leaseId: randomUUID(),
      leaseVersion: 4,
      leaseExpiresAt: new Date(),
      successCount: 2,
      declineCount: 1
    } as Record<string, unknown>,
    events: [{ message: '原事件', dedupeKey: 'old-event' }] as unknown[],
    audits: [{ action: 'worker.payment_submitted', id: 'old-audit' }] as unknown[]
  };
  const flags = {
    paidBill: false,
    order: false,
    sync: false,
    usage: false,
    active: false,
    cardMissing: false,
    casFailure: false,
    cardFailure: false,
    auditFailure: false
  };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    onlineRechargeTask: {
      findUnique: vi.fn(async () => state.row),
      findFirst: vi.fn(async () => (flags.active ? { id: randomUUID() } : null)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (flags.casFailure) return { count: 0 };
        const increment = (data.leaseVersion as { increment: number }).increment;
        Object.assign(state.row, data, {
          leaseVersion: state.row.leaseVersion + increment,
          updatedAt: new Date('2026-10-17T08:00:00.000Z')
        });
        return { count: 1 };
      })
    },
    onlineRechargeCard: {
      findUnique: vi.fn(async () => (flags.cardMissing ? null : state.card)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (flags.cardFailure) return { count: 0 };
        const increment = (data.leaseVersion as { increment: number }).increment;
        Object.assign(state.card, data, {
          leaseVersion: Number(state.card.leaseVersion) + increment
        });
        return { count: 1 };
      })
    },
    onlineRechargeBill: { findFirst: vi.fn(async () => (flags.paidBill ? { id: 'paid' } : null)) },
    idBusinessV2BankRechargeOrder: {
      findFirst: vi.fn(async () => (flags.order ? { id: 'order' } : null))
    },
    onlineRechargeOrderSync: { findUnique: vi.fn(async () => (flags.sync ? { taskId } : null)) },
    onlineRechargeEvent: {
      findUnique: vi.fn(async () => (flags.usage ? { id: 'usage' } : null)),
      create: vi.fn(async ({ data }: { data: unknown }) => {
        state.events.push(data);
        return data;
      })
    }
  };
  let pending = Promise.resolve();
  const repository = {
    transaction: vi.fn(
      async (_key: string, work: (db: V2CommandTransaction) => Promise<unknown>) => {
        const previous = pending;
        let release!: () => void;
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        const before = structuredClone(state);
        try {
          return await work(tx as unknown as V2CommandTransaction);
        } catch (error) {
          Object.assign(state, before);
          throw error;
        } finally {
          release();
        }
      }
    ),
    log: vi.fn(
      async (_tx: unknown, action: string, _operator: unknown, _id: unknown, data: unknown) => {
        if (flags.auditFailure) throw new Error('synthetic audit unavailable');
        state.audits.push({ action, data });
      }
    )
  };
  const credentials = { forgetCvc: vi.fn(), putCvc: vi.fn() };
  const orderSync = { enqueueInTransaction: vi.fn() };
  const tasks = new OnlineRechargeTasksRepository(
    repository as unknown as OnlineRechargeRepository,
    {} as OnlineRechargeSettingsService,
    {} as FieldEncryptionService,
    credentials as unknown as OnlineRechargeEphemeralCredentials,
    orderSync as unknown as OnlineRechargeOrderSyncService
  );
  const input = {
    id: taskId,
    version: state.row.updatedAt.toISOString(),
    requestId: randomUUID(),
    userConfirmedNotCharged: true,
    confirmationSource: 'user_statement',
    confirmationReference: '合成用户在当前会话确认未扣款并停用旧卡',
    reason: '更换新卡，关闭历史未知结果'
  };
  const close = (changes: Record<string, unknown> = {}, actor = operator) =>
    tasks.action('jobs', 'resolve-not-charged', { ...input, ...changes }, actor);
  return { state, flags, tx, repository, credentials, orderSync, tasks, operator, input, close };
}

describe('历史付款的管理员人工结案', () => {
  it('保留全部历史付款资料与计数，只按用户声明结案并停用原卡', async () => {
    const f = fixture(),
      before = structuredClone(f.state);
    expect(await f.close()).toEqual({ success: true });
    expect(f.repository.transaction).toHaveBeenCalledWith('tasks-start', expect.any(Function));
    const locks = JSON.stringify([...f.tx.$executeRaw.mock.calls, ...f.tx.$queryRaw.mock.calls]);
    for (const name of [`online-recharge:task:${f.input.id}`, 'shared-bank-card-pool'])
      expect(
        locks.includes(name) || locks.includes(createHash('sha256').update(name).digest('hex'))
      ).toBe(true);
    expect(f.state.row).toMatchObject({
      status: 'failed',
      stage: 'finished',
      paymentStarted: true,
      confirmedPaid: false,
      leaseVersion: 4,
      sessionEncrypted: before.row.sessionEncrypted,
      payload: before.row.payload,
      result: {
        ...(before.row.result as object),
        manualNotChargedResolution: {
          confirmationSource: 'user_statement',
          paymentProviderVerified: false,
          operatorId: f.operator.id,
          requestId: f.input.requestId
        }
      }
    });
    expect(f.state.card).toMatchObject({
      status: 'disabled',
      leaseOwner: null,
      leaseId: null,
      leaseExpiresAt: null,
      successCount: 2,
      declineCount: 1,
      leaseVersion: 5
    });
    expect(f.state.events[0]).toEqual(before.events[0]);
    expect(f.state.audits[0]).toEqual(before.audits[0]);
    expect(f.state.events).toHaveLength(2);
    expect(f.state.audits).toHaveLength(2);
    expect(f.credentials.putCvc).not.toHaveBeenCalled();
    expect(f.orderSync.enqueueInTransaction).not.toHaveBeenCalled();
  });
  it('人工结案只停止核对计划，保留原计划时间、次数和原始原因', async () => {
    const f = fixture();
    const schedule = {
      version: 1,
      attempts: 1,
      stopped: false,
      startedAt: '2026-10-17T07:00:00.000Z',
      nextAttemptAt: '2026-10-17T07:05:00.000Z',
      reasonCode: 'legacy_original_identity_missing'
    };
    f.state.row.payload = { ...(f.state.row.payload as object), reconciliation: schedule };
    await f.close();
    expect(f.state.row.payload).toMatchObject({
      reconciliation: { ...schedule, stopped: true, nextAttemptAt: null }
    });
  });
  it('只有管理员能作人工结案，manage权限不能代替管理员身份', async () => {
    const f = fixture();
    await expect(
      f.close(
        {},
        { ...f.operator, roles: [], permissions: ['id_business_v2.online_recharge.manage'] }
      )
    ).rejects.toThrow('仅管理员');
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  for (const changes of [
    { userConfirmedNotCharged: false },
    { userConfirmedNotCharged: 'true' },
    { confirmationSource: 'provider' },
    { confirmationReference: '' },
    { reason: '' },
    { version: undefined },
    { requestId: 'not-an-id' }
  ])
    it(`人工结案拒绝缺失或错误声明 ${JSON.stringify(changes)}`, async () => {
      const f = fixture();
      await expect(f.close(changes)).rejects.toThrow();
      expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
      expect(f.repository.log).not.toHaveBeenCalled();
    });
  it('版本已变更时不能解除原保护', async () => {
    const f = fixture();
    await expect(f.close({ version: '2026-10-17T06:00:00.000Z' })).rejects.toThrow(
      '已被其他人修改'
    );
    expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
  });
  for (const change of [
    { operation: 'renewal' },
    { provider: 'third_party' },
    { status: 'running' },
    { paymentStarted: false },
    { confirmedPaid: true },
    { cardId: null },
    { cardLast4: null },
    { sessionIdentityHash: null },
    { leaseOwner: 'active-worker' },
    { leaseId: randomUUID() },
    { leaseExpiresAt: new Date() },
    { deletedAt: new Date() }
  ])
    it(`人工结案拒绝非受控旧单 ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      Object.assign(f.state.row, change);
      await expect(f.close()).rejects.toThrow();
      expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
    });
  for (const key of [
    'checkoutRecoveryVersion',
    'checkoutRecoveryEncrypted',
    'debugCheckoutEncrypted'
  ])
    it(`人工结案不能覆盖已有恢复能力 ${key}`, async () => {
      const f = fixture();
      f.state.row.payload = {
        ...(f.state.row.payload as object),
        [key]: key.endsWith('Version') ? 1 : 'synthetic-protected-recovery'
      };
      await expect(f.close()).rejects.toThrow('已有原单恢复能力');
      expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
    });
  for (const key of ['confirmedPaid', 'success', 'paymentEvidence', 'originalPaymentEvidence'])
    it(`人工结案拒绝结果中的付款证据 ${key}`, async () => {
      const f = fixture();
      f.state.row.result = { [key]: key.endsWith('Evidence') ? { verified: true } : true };
      await expect(f.close()).rejects.toThrow('存在付款或入账证据');
    });
  it('人工结案拒绝保存在原payload中的付款证据', async () => {
    const f = fixture();
    f.state.row.payload = { originalPaymentEvidence: { verified: true } };
    await expect(f.close()).rejects.toThrow('存在付款或入账证据');
  });
  for (const key of ['paidBill', 'order', 'sync', 'usage'] as const)
    it(`人工结案拒绝既有支付或记账记录 ${key}`, async () => {
      const f = fixture();
      f.flags[key] = true;
      await expect(f.close()).rejects.toThrow('存在付款或入账证据');
      expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
    });
  it('人工结案等待同账号执行、原单核对或旧卡其他任务结束', async () => {
    const f = fixture();
    f.flags.active = true;
    await expect(f.close()).rejects.toThrow('仍有执行或核对任务');
    const where = f.tx.onlineRechargeTask.findFirst.mock.calls[0];
    expect(JSON.stringify(where)).toContain('recheckTaskId');
    expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
  });
  for (const kind of ['foreign-owner', 'missing', 'last4'] as const)
    it(`人工结案不能操作不匹配的银行卡 ${kind}`, async () => {
      const f = fixture();
      if (kind === 'foreign-owner') f.state.card.leaseOwner = randomUUID();
      if (kind === 'missing') f.flags.cardMissing = true;
      if (kind === 'last4') f.state.card.last4 = '9999';
      await expect(f.close()).rejects.toThrow('原银行卡绑定或占用已变化');
      expect(f.tx.onlineRechargeTask.updateMany).not.toHaveBeenCalled();
    });
  it('原卡已无占用也只能停用同一张历史关联卡，不改其他资源', async () => {
    const f = fixture();
    f.state.card.leaseOwner = null;
    await f.close();
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: f.state.row.cardId }),
        data: expect.objectContaining({ status: 'disabled' })
      })
    );
  });
  it('并发相同人工结案幂等一次事件与审计，不清除一次提交标记', async () => {
    const f = fixture();
    const results = await Promise.all([f.close(), f.close()]);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(f.tx.onlineRechargeTask.updateMany).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledTimes(1);
    expect(f.repository.log).toHaveBeenCalledTimes(1);
    expect(f.state.audits).toHaveLength(2);
    expect(f.state.row.paymentStarted).toBe(true);
  });
  it('相同requestId更换版本、来源、理由或操作者不能再次结案', async () => {
    const f = fixture();
    await f.close();
    for (const change of [
      { version: f.state.row.updatedAt.toISOString() },
      { requestId: randomUUID() },
      { confirmationReference: '另一确认' },
      { reason: '另一原因' }
    ])
      await expect(f.close(change)).rejects.toThrow('已有不同的人工收尾记录');
    await expect(f.close({}, { ...f.operator, id: randomUUID() })).rejects.toThrow(
      '已有不同的人工收尾记录'
    );
    expect(f.repository.log).toHaveBeenCalledTimes(1);
  });
  for (const kind of ['casFailure', 'cardFailure', 'auditFailure'] as const)
    it(`人工结案 ${kind} 失败完整回滚任务、卡、事件和审计`, async () => {
      const f = fixture(),
        before = structuredClone(f.state);
      f.flags[kind] = true;
      await expect(f.close()).rejects.toThrow();
      expect(f.state).toEqual(before);
    });
});
