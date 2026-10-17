import { ConflictException } from '@nestjs/common';
import { Prisma, type OnlineRechargeTask } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import type { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import type { OnlineRechargeSettingsService } from '../settings.service';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import type { OnlineRechargeOrderSyncService } from '../order-sync.service';

const accountId = randomUUID();
const syntheticSession = JSON.stringify({
  accessToken: `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url')}.unused`
});

function fixture(overrides: Partial<OnlineRechargeTask> = {}, original?: OnlineRechargeTask) {
  const row = {
    id: randomUUID(),
    operation: 'renewal',
    provider: 'local',
    plan: 'plus',
    status: 'running',
    payload: { action: 'disable' },
    progress: 10,
    paymentStarted: false,
    confirmedPaid: false,
    leaseOwner: 'fixture-worker',
    leaseId: randomUUID(),
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 60000),
    sessionEncrypted: 'synthetic-encrypted-session',
    sessionIdentityHash: 'synthetic-identity-hash',
    ...overrides
  } as OnlineRechargeTask;
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ lock_key: 'synthetic' }]),
    onlineRechargeTask: {
      findUnique: vi.fn(async (query?: { where: { id: string } }) =>
        query?.where.id === original?.id ? original! : row
      ),
      findMany: vi.fn(async () => [] as OnlineRechargeTask[]),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      update: vi.fn(
        async ({ where, data }: { where?: { id: string }; data: Partial<OnlineRechargeTask> }) => {
          const target = where?.id === original?.id ? original! : row;
          Object.assign(target, data);
          return target;
        }
      )
    },
    onlineRechargeCard: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => ({
        id: row.cardId,
        last4: row.cardLast4,
        successCount: 0,
        declineCount: 0,
        status: 'active',
        allowedPlans: ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_500'],
        leaseId: 'synthetic-card-lease',
        leaseVersion: 1,
        leaseOwner: row.id,
        leaseExpiresAt: row.leaseExpiresAt
      })),
      findUnique: vi.fn(async () =>
        row.cardId
          ? {
              id: row.cardId,
              successCount: 1,
              declineCount: 0,
              status: 'active'
            }
          : null
      ),
      update: vi.fn(async () => null)
    },
    onlineRechargeCode: { updateMany: vi.fn(async () => ({ count: 0 })) },
    onlineRechargeBill: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ id: 'synthetic-bill' }))
    },
    onlineRechargeEvent: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => null)
    },
    onlineRechargeConfig: { findUnique: vi.fn(async () => null) }
  };
  const repository = {
    transaction: vi.fn(async (_key: string, work: (tx: V2CommandTransaction) => unknown) =>
      work(tx as unknown as V2CommandTransaction)
    ),
    log: vi.fn(async () => undefined)
  };
  const available = vi.fn(async (ids: string[]) => ids);
  const orderSync = { enqueueInTransaction: vi.fn(async () => undefined) };
  const encryption = {
    decrypt: vi.fn<(value?: string | null) => string>(() => syntheticSession),
    encrypt: vi.fn<(value: string) => string>(() => 'synthetic-encrypted-recovery')
  };
  const worker = new OnlineRechargeWorkerRepository(
    repository as unknown as OnlineRechargeRepository,
    {
      cardPolicy: async () => ({ maxSubscriptionCount: 2, maxDeclineCount: 3 })
    } as OnlineRechargeSettingsService,
    encryption as unknown as FieldEncryptionService,
    { available } as unknown as OnlineRechargeEphemeralCredentials,
    orderSync as unknown as OnlineRechargeOrderSyncService
  );
  const rpc = (args: Record<string, unknown> = {}): OnlineRechargeWorkerRpc => ({
    method: 'beforeExternalSubmit',
    taskId: row.id,
    workerId: 'fixture-worker',
    leaseId: row.leaseId!,
    leaseVersion: row.leaseVersion,
    args: { stage: 'renewal_update', renewalAction: 'disable', ...args }
  });
  return { row, tx, repository, worker, rpc, available, orderSync, encryption };
}

describe('原结账单的受保护恢复资料', () => {
  function paymentFixture(embeddedStripe = false) {
    const cardId = randomUUID(),
      checkoutId = embeddedStripe ? 'cs_live_syntheticOriginal' : 'oaics_synthetic_original';
    const context = {
      kind: 'initial',
      sourcePlan: 'free',
      targetPlan: 'pro_20x',
      accountId,
      cardId,
      cardLast4: '4242',
      amount: '9990',
      currency: 'PHP',
      quoteId: `quote:${createHash('sha256').update(checkoutId).digest('hex').slice(0, 32)}`
    };
    const recovery = {
      ...context,
      version: 1,
      checkoutId,
      processorEntity: 'openai',
      checkoutUrl: `https://chatgpt.com/checkout/openai/${checkoutId}`,
      ...(embeddedStripe
        ? {
            source: {
              kind: 'official_checkout_response' as const,
              checkoutId,
              processorEntity: 'openai'
            }
          }
        : {})
    };
    const f = fixture({
      operation: 'recharge',
      plan: 'pro_20x',
      cardId,
      cardLast4: '4242',
      payload: { checkoutRecoveryVersion: 1, paymentLimit: { currency: 'PHP', maxAmount: '9990' } }
    });
    const submit = (changes: Record<string, unknown> = {}) =>
      f.rpc({ stage: 'payment', paymentContext: context, checkoutRecovery: recovery, ...changes });
    return { ...f, context, recovery, submit };
  }

  it('新任务必须在付款开始标记的同一次更新中加密保存原单，审计没有恢复 URL', async () => {
    const f = paymentFixture();
    await f.worker.beforeSubmit(f.submit());
    expect(f.encryption.encrypt).toHaveBeenCalledWith(JSON.stringify(f.recovery));
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentStarted: true,
          payload: expect.objectContaining({
            checkoutRecoveryEncrypted: 'synthetic-encrypted-recovery',
            paymentContext: f.context
          })
        })
      })
    );
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain(f.recovery.checkoutUrl);
  });
  it('内嵌 cs 原单来源与付款标记一起加密保存，重复提交不增加审计或写入', async () => {
    const f = paymentFixture(true);
    await f.worker.beforeSubmit(f.submit());
    const encryptedInput = JSON.parse(f.encryption.encrypt.mock.calls[0]![0]);
    expect(encryptedInput).toEqual(f.recovery);
    expect(f.row).toMatchObject({
      paymentStarted: true,
      payload: { checkoutRecoveryEncrypted: 'synthetic-encrypted-recovery' }
    });
    await expect(f.worker.beforeSubmit(f.submit())).rejects.toThrow('重复提交');
    expect(f.encryption.encrypt).toHaveBeenCalledTimes(1);
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledTimes(1);
    expect(f.repository.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain(f.recovery.checkoutId);
    expect(JSON.stringify(f.row.payload)).not.toContain(f.recovery.checkoutUrl);
  });
  it.each([
    undefined,
    { kind: 'guessed_url', checkoutId: 'cs_live_syntheticOriginal', processorEntity: 'openai' },
    {
      kind: 'official_checkout_response',
      checkoutId: 'cs_live_differentOriginal',
      processorEntity: 'openai'
    },
    {
      kind: 'official_checkout_response',
      checkoutId: 'cs_live_syntheticOriginal',
      processorEntity: 'different'
    }
  ])('内嵌 cs 来源缺失或错绑不得写入付款标记或付款审计 %j', async (source) => {
    const f = paymentFixture(true);
    await expect(
      f.worker.beforeSubmit(f.submit({ checkoutRecovery: { ...f.recovery, source } }))
    ).rejects.toThrow();
    expect(f.row.paymentStarted).toBe(false);
    expect(f.encryption.encrypt).not.toHaveBeenCalled();
    expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
    expect(f.repository.log).not.toHaveBeenCalled();
  });
  it('恢复资料缺失、账号或报价错绑、加密失败及超额时，均不写付款开始标记', async () => {
    for (const change of [
      { checkoutRecovery: undefined },
      { checkoutRecovery: { accountId: randomUUID() } },
      { checkoutRecovery: { amount: '9991' } },
      { paymentContext: { amount: '9990.01' } },
      { encryptFails: true }
    ]) {
      const f = paymentFixture();
      const changes: Record<string, unknown> = {};
      if ('checkoutRecovery' in change)
        changes.checkoutRecovery =
          change.checkoutRecovery === undefined
            ? undefined
            : { ...f.recovery, ...change.checkoutRecovery };
      if ('paymentContext' in change)
        changes.paymentContext = { ...f.context, ...change.paymentContext };
      if ('encryptFails' in change)
        f.encryption.encrypt.mockImplementation(() => {
          throw new Error('fixture encryption unavailable');
        });
      await expect(f.worker.beforeSubmit(f.submit(changes))).rejects.toThrow();
      expect(f.row.paymentStarted).toBe(false);
      expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
    }
  });
  function recheckFixture() {
    const original = paymentFixture();
    Object.assign(original.row, {
      status: 'awaiting_review',
      paymentStarted: true,
      leaseVersion: 2,
      payload: {
        checkoutRecoveryVersion: 1,
        paymentContext: original.context,
        checkoutRecoveryEncrypted: 'synthetic-encrypted-recovery'
      }
    });
    const f = fixture(
      {
        operation: 'subscription',
        plan: 'pro_20x',
        payload: {
          recheckTaskId: original.row.id,
          sourceVersion: 2,
          originalOperation: 'recharge',
          originalProvider: 'local',
          paymentContext: original.context
        }
      },
      original.row
    );
    f.encryption.decrypt.mockImplementation((value) =>
      value === 'synthetic-encrypted-recovery'
        ? JSON.stringify(original.recovery)
        : syntheticSession
    );
    return { ...f, original };
  }
  it('仅有效租约且绑定原任务版本、账号、卡及报价的核对任务可解密', async () => {
    const f = recheckFixture();
    expect(await f.worker.getCheckoutRecovery(f.rpc())).toEqual(f.original.recovery);
    expect(f.repository.log).toHaveBeenCalledWith(
      f.tx,
      'worker.checkout_recovery.read',
      undefined,
      f.original.row.id,
      { recheckTaskId: f.row.id, sourceVersion: 2 }
    );
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain(
      f.original.recovery.checkoutUrl
    );
    for (const mutate of [
      (item: ReturnType<typeof recheckFixture>) => {
        item.row.operation = 'recharge';
      },
      (item: ReturnType<typeof recheckFixture>) => {
        item.row.leaseExpiresAt = new Date(0);
      },
      (item: ReturnType<typeof recheckFixture>) => {
        item.original.row.leaseVersion = 3;
      },
      (item: ReturnType<typeof recheckFixture>) => {
        item.original.row.cardId = randomUUID();
      },
      (item: ReturnType<typeof recheckFixture>) => {
        item.row.sessionIdentityHash = 'different';
      },
      (item: ReturnType<typeof recheckFixture>) => {
        (item.row.payload as Record<string, unknown>).paymentContext = {
          ...item.original.context,
          amount: '9989'
        };
      }
    ]) {
      const item = recheckFixture();
      mutate(item);
      await expect(item.worker.getCheckoutRecovery(item.rpc())).rejects.toThrow();
    }
  });
  it('旧单缺少原始来源只返回空资料，不补造原单，也不接受参数中的其他原任务编号', async () => {
    const f = recheckFixture();
    delete (f.original.row.payload as Record<string, unknown>).checkoutRecoveryEncrypted;
    expect(await f.worker.getCheckoutRecovery(f.rpc({ recheckTaskId: randomUUID() }))).toBeNull();
    expect(f.encryption.encrypt).not.toHaveBeenCalled();
  });
});

describe('续费提交与付款提交隔离', () => {
  for (const action of ['enable', 'disable']) {
    it(`${action} 持久记录变更意图，无需银行卡且不冒充付款`, async () => {
      const f = fixture({ payload: { action } });
      await expect(f.worker.beforeSubmit(f.rpc({ renewalAction: action }))).resolves.toMatchObject({
        ok: true
      });
      expect(f.row).toMatchObject({
        paymentStarted: false,
        confirmedPaid: false,
        stage: 'renewal_submitted',
        payload: { action, renewalSubmission: { action, leaseVersion: 1 } }
      });
      expect(f.repository.log).toHaveBeenCalledWith(
        expect.anything(),
        'worker.renewal_submitted',
        undefined,
        f.row.id,
        { action, leaseVersion: 1 }
      );
    });
  }

  it('查询任务、动作不匹配、过期租约和调试任务均不允许变更', async () => {
    const cases = [
      fixture({ payload: { action: 'check' } }),
      fixture({ payload: { action: 'enable' } }),
      fixture({ leaseExpiresAt: new Date(Date.now() - 1) }),
      fixture({ operation: 'debug' })
    ];
    for (const f of cases) {
      await expect(f.worker.beforeSubmit(f.rpc())).rejects.toBeInstanceOf(ConflictException);
      expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
    }
  });

  it('同任务重复回调不能再次提交外部变更', async () => {
    const f = fixture();
    await f.worker.beforeSubmit(f.rpc());
    await expect(f.worker.beforeSubmit(f.rpc())).rejects.toThrow('禁止重复提交');
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledTimes(1);
  });

  it('已确认充值后的自动取消保留付款证据和原阶段', async () => {
    const f = fixture({
      operation: 'recharge',
      payload: {},
      confirmedPaid: true,
      paymentStarted: true,
      stage: 'payment_confirmed'
    });
    await f.worker.beforeSubmit(f.rpc());
    expect(f.row).toMatchObject({
      confirmedPaid: true,
      paymentStarted: true,
      stage: 'payment_confirmed',
      payload: { renewalSubmission: { action: 'disable' } }
    });
    await expect(
      fixture({ operation: 'recharge' }).worker.beforeSubmit(f.rpc())
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('续费提交后执行器离线转待核对，不重新入队', async () => {
    const f = fixture({
      payload: { action: 'disable', renewalSubmission: { action: 'disable', leaseVersion: 1 } },
      leaseExpiresAt: new Date(Date.now() - 1)
    });
    f.tx.onlineRechargeTask.findMany.mockResolvedValue([f.row]);
    await f.worker.claim('replacement-worker');
    expect(f.row.status).toBe('awaiting_review');
    expect(f.row.paymentStarted).toBe(false);
    expect(f.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalled();
  });

  it('成功必须有同账号目标续费状态，普通失败仍保留待核对', async () => {
    for (const result of [
      { ok: true, data: { upstreamAccountId: randomUUID(), autoRenewRaw: false } },
      { ok: true, data: { upstreamAccountId: accountId, autoRenewRaw: true } },
      { ok: true, data: { accountId, autoRenewRaw: false } },
      { ok: false, resultUnknown: true }
    ]) {
      const f = fixture({
        payload: { action: 'disable', renewalSubmission: { action: 'disable' } }
      });
      const response = await f.worker.finish(
        f.rpc({ status: result.ok ? 'succeeded' : 'failed', result }),
        !result.ok
      );
      expect(response.status).toBe('awaiting_review');
    }
    const f = fixture({ payload: { action: 'disable', renewalSubmission: { action: 'disable' } } });
    await expect(
      f.worker.finish(
        f.rpc({
          status: 'succeeded',
          result: { ok: true, data: { upstreamAccountId: accountId, autoRenewRaw: false } }
        }),
        false
      )
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(f.row.confirmedPaid).toBe(false);
  });

  it('明确的授权拒绝可结束为失败，不能伪装成充值付款', async () => {
    const f = fixture({ payload: { action: 'disable', renewalSubmission: { action: 'disable' } } });
    await expect(
      f.worker.finish(
        f.rpc({
          status: 'failed',
          definitiveFailure: true,
          result: { ok: false, statusCode: 401, definitiveFailure: true, renewalRejected: true }
        }),
        true
      )
    ).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('续费原单核对与付款核对隔离', () => {
  function recheckFixture(
    originalOverrides: Partial<OnlineRechargeTask> = {},
    payloadOverrides: Record<string, unknown> = {}
  ) {
    const original = fixture({
      status: 'awaiting_review',
      leaseVersion: 2,
      leaseOwner: null,
      leaseId: null,
      leaseExpiresAt: null,
      payload: { action: 'disable', renewalSubmission: { action: 'disable' } },
      ...originalOverrides
    }).row;
    const f = fixture(
      {
        operation: 'subscription',
        payload: {
          recheckTaskId: original.id,
          sourceVersion: 2,
          originalOperation: 'renewal',
          renewalAction: 'disable',
          ...payloadOverrides
        }
      },
      original
    );
    return { ...f, original };
  }

  const result = () => ({
    success: true,
    renewalVerified: true,
    confirmedPaid: false,
    data: { upstreamAccountId: accountId, autoRenewRaw: false }
  });

  for (const confirmedPaid of [false, true]) {
    it(`同账号目标续费状态确认原单，保留原付款标记 ${confirmedPaid}，不建账单或计卡`, async () => {
      const f = recheckFixture({ confirmedPaid, cardId: randomUUID(), codeId: randomUUID() });
      await f.worker.finish(f.rpc({ status: 'succeeded', result: result() }), false);
      expect(f.original).toMatchObject({
        status: 'succeeded',
        stage: 'rechecked',
        confirmedPaid,
        result: { renewalVerified: true, confirmedPaid: false, recheckedByTaskId: f.row.id }
      });
      expect(f.row.confirmedPaid).toBe(false);
      expect(f.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
      expect(f.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
      expect(f.tx.onlineRechargeCode.updateMany).not.toHaveBeenCalled();
    });
  }

  it('旧目标套餐存在或错误夹带付款标记不能把续费核对当成已付款', async () => {
    const f = recheckFixture();
    const proof = {
      source: 'subscription',
      querySucceeded: true,
      verified: true,
      hasActiveSubscription: true,
      accountId,
      expectedAccountId: accountId,
      targetPlan: 'plus',
      observedPlan: 'plus'
    };
    await f.worker.finish(
      f.rpc({
        status: 'succeeded',
        confirmedPaid: true,
        result: { success: true, confirmedPaid: true, confirmation: proof }
      }),
      false
    );
    expect(f.original.status).toBe('awaiting_review');
    expect(f.row.confirmedPaid).toBe(false);
    expect(f.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
  });

  it('未提交、动作不匹配、缺少真实上游账号或目标状态不符时保留原单待核对', async () => {
    const cases = [
      { original: { payload: { action: 'disable' } }, payload: {}, result: result() },
      { original: {}, payload: { renewalAction: 'enable' }, result: result() },
      { original: {}, payload: {}, result: { ...result(), renewalVerified: false } },
      {
        original: {},
        payload: {},
        result: { ...result(), data: { accountId, autoRenewRaw: false } }
      },
      {
        original: {},
        payload: {},
        result: { ...result(), data: { upstreamAccountId: randomUUID(), autoRenewRaw: false } }
      },
      {
        original: {},
        payload: {},
        result: { ...result(), data: { upstreamAccountId: accountId, autoRenewRaw: true } }
      }
    ];
    for (const item of cases) {
      const f = recheckFixture(item.original as Partial<OnlineRechargeTask>, item.payload);
      await f.worker.finish(f.rpc({ status: 'succeeded', result: item.result }), false);
      expect(f.original.status).toBe('awaiting_review');
      expect(f.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
      expect(f.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    }
  });

  it('普通充值核对仍接受同账号精确套餐及原单付款证据', async () => {
    const context = {
      kind: 'initial',
      sourcePlan: 'free',
      targetPlan: 'plus',
      accountId,
      cardId: randomUUID(),
      cardLast4: '4242',
      amount: '20',
      currency: 'USD',
      quoteId: 'synthetic-original-quote'
    };
    const f = recheckFixture(
      { operation: 'recharge', payload: { paymentContext: context }, paymentStarted: true },
      {
        originalOperation: 'recharge',
        paymentContext: context
      }
    );
    await f.worker.finish(
      f.rpc({
        status: 'succeeded',
        result: {
          success: true,
          confirmedPaid: true,
          paymentEvidence: { ...context, source: 'checkout', verified: true },
          confirmation: {
            source: 'subscription',
            querySucceeded: true,
            verified: true,
            hasActiveSubscription: true,
            accountId,
            expectedAccountId: accountId,
            targetPlan: 'plus',
            observedPlan: 'plus'
          }
        }
      }),
      false
    );
    expect(f.original).toMatchObject({ status: 'succeeded', confirmedPaid: true });
    expect(f.orderSync.enqueueInTransaction).toHaveBeenCalledWith(f.tx, f.original.id);
    expect(f.orderSync.enqueueInTransaction).not.toHaveBeenCalledWith(f.tx, f.row.id);
    expect(f.tx.onlineRechargeBill.create).toHaveBeenCalledTimes(1);
  });
});

describe('准确升级与实际付款卡、报价的持久证据', () => {
  function upgradeFixture(amount = '500.1234', original?: OnlineRechargeTask) {
    const cardId = randomUUID();
    const context = {
      kind: 'upgrade',
      sourcePlan: 'plus',
      targetPlan: 'pro_500',
      accountId,
      cardId,
      cardLast4: '4242',
      amount,
      currency: 'USD',
      quoteId: 'synthetic-upgrade-quote'
    };
    const f = fixture(
      { operation: 'recharge', plan: 'pro_500', cardId, cardLast4: '4242', payload: {} },
      original
    );
    const evidence = { ...context, source: 'subscription_change', verified: true };
    const confirmation = {
      verified: true,
      source: 'subscription',
      querySucceeded: true,
      hasActiveSubscription: true,
      accountId,
      expectedAccountId: accountId,
      targetPlan: 'pro_500',
      observedPlan: 'pro',
      observedCanonicalPlan: 'pro_500',
      tierVerified: true
    };
    const submit = (changes: Record<string, unknown> = {}) =>
      f.rpc({ stage: 'payment', paymentContext: { ...context, ...changes } });
    return { ...f, context, evidence, confirmation, submit };
  }

  it('仅内部已保存卡路线可不要求安全码，普通新卡路线仍等待临时安全码', async () => {
    const saved = upgradeFixture();
    saved.available.mockResolvedValue([]);
    saved.tx.onlineRechargeCard.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await saved.worker.reserveCard(saved.rpc({ requireCvc: false }))).toMatchObject({
      id: saved.context.cardId,
      hasCvc: false
    });
    expect(saved.row.status).toBe('running');
    const fresh = upgradeFixture();
    fresh.available.mockResolvedValue([]);
    expect(await fresh.worker.reserveCard(fresh.rpc())).toMatchObject({
      pendingCredentials: true,
      cardId: fresh.context.cardId
    });
    expect(fresh.row.status).toBe('awaiting_credentials');
  });

  it('外部付款前持久保存精确账号、目标、报价与实际卡；同任务只提交一次', async () => {
    const f = upgradeFixture();
    await f.worker.beforeSubmit(f.submit());
    expect(f.row).toMatchObject({ paymentStarted: true, payload: { paymentContext: f.context } });
    await expect(f.worker.beforeSubmit(f.submit())).rejects.toThrow('重复提交');
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledTimes(1);
  });

  it('单次上限从任务读取，执行器不能抬高或更换币种', async () => {
    for (const [amount, currency] of [
      ['9990.0001', 'PHP'],
      ['1', 'USD']
    ]) {
      const f = upgradeFixture(amount);
      f.row.payload = { paymentLimit: { currency: 'PHP', maxAmount: '9990.0000' } };
      await expect(
        f.worker.beforeSubmit(
          f.submit({ currency, paymentLimit: { currency, maxAmount: '999999' } })
        )
      ).rejects.toThrow('付款上限');
      expect(f.row.paymentStarted).toBe(false);
      expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
    }
    const f = upgradeFixture('9990.0000');
    f.row.payload = { paymentLimit: { currency: 'PHP', maxAmount: '9990.0000' } };
    await f.worker.beforeSubmit(f.submit({ currency: 'PHP' }));
    expect(f.row.paymentStarted).toBe(true);
    expect(f.row.payload).toMatchObject({ paymentLimit: { maxAmount: '9990.0000' } });
  });

  it('套餐规则币种与原订阅报价不一致时不提交；一致才继续原有付款校验', async () => {
    const f = upgradeFixture('28095');
    f.row.payload = {
      region: 'CL',
      proxyCountryCode: 'CL',
      planRegion: {
        policy: 'plan',
        configVersion: 17,
        targetPlan: 'pro_500',
        paymentRegion: 'CL',
        proxyCountryCode: 'CL',
        expectedCurrency: 'CLP'
      }
    };
    await expect(f.worker.beforeSubmit(f.submit())).rejects.toThrow();
    expect(f.row.paymentStarted).toBe(false);
    expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
    await f.worker.beforeSubmit(f.submit({ currency: 'CLP' }));
    expect(f.row.paymentStarted).toBe(true);
  });

  it('套餐路由普通档位同样必须提供官网报价，不能绕过最终币种核验', async () => {
    const f = upgradeFixture();
    f.row.plan = 'pro_5x';
    f.row.payload = {
      region: 'CL',
      proxyCountryCode: 'CL',
      planRegion: {
        policy: 'plan',
        configVersion: 17,
        targetPlan: 'pro_5x',
        paymentRegion: 'CL',
        proxyCountryCode: 'CL',
        expectedCurrency: 'CLP'
      }
    };
    await expect(f.worker.beforeSubmit(f.rpc({ stage: 'payment' }))).rejects.toThrow('缺少可核实');
    expect(f.row.paymentStarted).toBe(false);
    expect(f.tx.onlineRechargeTask.update).not.toHaveBeenCalled();
  });

  it('错误账号、卡、币种、缺失报价、同档、降档或未纳入来源均不能提交', async () => {
    for (const changes of [
      { accountId: randomUUID() },
      { cardId: randomUUID() },
      { cardLast4: '0000' },
      { targetPlan: 'pro_20x' },
      { currency: 'usd' },
      { amount: 500 },
      { amount: '' },
      { amount: '-1' },
      { sourcePlan: 'pro_500' },
      { sourcePlan: 'go' },
      { kind: 'initial', sourcePlan: 'plus' }
    ]) {
      const f = upgradeFixture();
      await expect(f.worker.beforeSubmit(f.submit(changes))).rejects.toThrow();
      expect(f.row.paymentStarted).toBe(false);
    }
    const f = upgradeFixture();
    await expect(f.worker.beforeSubmit(f.rpc({ stage: 'payment' }))).rejects.toThrow('缺少');
  });

  it('付款证据卡或金额不一致不能计次、建成功账单或宣告升级成功', async () => {
    for (const changes of [
      { cardId: randomUUID() },
      { amount: '499' },
      { currency: 'PHP' },
      { quoteId: 'other-quote' }
    ]) {
      const f = upgradeFixture();
      await f.worker.beforeSubmit(f.submit());
      const evidence = { ...f.evidence, ...changes };
      await expect(
        f.worker.cardAction(
          f.rpc({ cardId: f.context.cardId, paymentEvidence: evidence }),
          'recordCardUsage'
        )
      ).rejects.toThrow('未核实');
      await expect(
        f.worker.billing(
          f.rpc({
            record: {
              status: 'success',
              amount: f.context.amount,
              currency: 'USD',
              amountSource: 'checkout',
              paymentEvidence: evidence
            }
          })
        )
      ).rejects.toThrow('未核实');
      const response = await f.worker.finish(
        f.rpc({
          status: 'succeeded',
          result: { confirmedPaid: true, confirmation: f.confirmation, paymentEvidence: evidence }
        }),
        false
      );
      expect(response.status).toBe('awaiting_review');
      expect(f.row.confirmedPaid).toBe(false);
      expect(f.tx.onlineRechargeBill.upsert).not.toHaveBeenCalled();
      expect(f.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    }
  });

  it('同账号准确档位和相同Decimal报价确认升级，升级后不能自动更改续费', async () => {
    const f = upgradeFixture();
    await f.worker.beforeSubmit(f.submit());
    await f.worker.cardAction(
      f.rpc({ cardId: f.context.cardId, paymentEvidence: f.evidence }),
      'recordCardUsage'
    );
    await expect(f.worker.beforeSubmit(f.rpc())).rejects.toThrow('不允许');
    const response = await f.worker.finish(
      f.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          confirmation: f.confirmation,
          paymentEvidence: { ...f.evidence, amount: '500.123400' }
        }
      }),
      false
    );
    // 超过四位小数的非规范金额不是可接受的付款证据。
    expect(response.status).toBe('awaiting_review');
    expect(f.orderSync.enqueueInTransaction).not.toHaveBeenCalled();
    const valid = upgradeFixture();
    await valid.worker.beforeSubmit(valid.submit());
    expect(
      await valid.worker.finish(
        valid.rpc({
          status: 'succeeded',
          result: {
            confirmedPaid: true,
            confirmation: valid.confirmation,
            paymentEvidence: valid.evidence
          }
        }),
        false
      )
    ).toMatchObject({ status: 'succeeded' });
    expect(valid.orderSync.enqueueInTransaction).toHaveBeenCalledWith(valid.tx, valid.row.id);
  });

  it('零应付升级只确认套餐变更，不计扣款、不造账单，并释放当前卡租约', async () => {
    const f = upgradeFixture('0.0000');
    await f.worker.beforeSubmit(f.submit());
    await expect(
      f.worker.cardAction(
        f.rpc({ cardId: f.context.cardId, paymentEvidence: f.evidence }),
        'recordCardUsage'
      )
    ).rejects.toThrow('未核实');
    await expect(
      f.worker.billing(
        f.rpc({
          record: {
            status: 'success',
            amount: '0',
            amountSource: 'checkout',
            currency: 'USD',
            paymentEvidence: f.evidence
          }
        })
      )
    ).rejects.toThrow('未核实');
    const response = await f.worker.finish(
      f.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: false,
          subscriptionChangedVerified: true,
          confirmation: f.confirmation,
          paymentEvidence: f.evidence
        }
      }),
      false
    );
    expect(response.status).toBe('succeeded');
    expect(f.row.confirmedPaid).toBe(false);
    expect(f.orderSync.enqueueInTransaction).toHaveBeenCalledWith(f.tx, f.row.id);
    expect(f.tx.onlineRechargeCard.updateMany).toHaveBeenCalledWith({
      where: { leaseOwner: f.row.id },
      data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
    });
    expect(f.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
    expect(f.tx.onlineRechargeBill.upsert).not.toHaveBeenCalled();
  });

  it('原单核对必须有匹配实际付款证据，只有准确套餐仍不能造扣款账单', async () => {
    for (const withEvidence of [false, true]) {
      const original = upgradeFixture();
      await original.worker.beforeSubmit(original.submit());
      Object.assign(original.row, {
        status: 'awaiting_review',
        leaseVersion: 2,
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null
      });
      const f = fixture(
        {
          operation: 'subscription',
          plan: 'pro_500',
          payload: {
            originalOperation: 'recharge',
            recheckTaskId: original.row.id,
            sourceVersion: 2,
            paymentContext: original.context
          }
        },
        original.row
      );
      await f.worker.finish(
        f.rpc({
          status: 'succeeded',
          result: {
            confirmedPaid: true,
            confirmation: original.confirmation,
            ...(withEvidence ? { paymentEvidence: original.evidence } : {})
          }
        }),
        false
      );
      expect(original.row.status).toBe(withEvidence ? 'succeeded' : 'awaiting_review');
      expect(f.tx.onlineRechargeBill.create).toHaveBeenCalledTimes(withEvidence ? 1 : 0);
      if (withEvidence) {
        expect(f.tx.onlineRechargeBill.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            cardId: original.context.cardId,
            cardLast4: '4242',
            currency: 'USD',
            amount: new Prisma.Decimal('500.1234')
          })
        });
      }
    }
  });

  it('计卡事务保存付款证据，进程重启后只读核对只补账单和订单，不再次计卡', async () => {
    const original = upgradeFixture();
    await original.worker.beforeSubmit(original.submit());
    original.row.result = { diagnostic: 'preserved' };
    await original.worker.cardAction(
      original.rpc({
        cardId: original.context.cardId,
        paymentEvidence: { ...original.evidence, checkoutUrl: 'https://example.invalid/private' }
      }),
      'recordCardUsage'
    );
    expect(original.row.result).toMatchObject({
      diagnostic: 'preserved',
      confirmedPaid: true,
      paymentEvidence: original.evidence
    });
    expect(original.row.result).not.toHaveProperty('paymentEvidence.checkoutUrl');
    expect(original.tx.onlineRechargeTask.update).toHaveBeenLastCalledWith({
      where: { id: original.row.id },
      data: {
        confirmedPaid: true,
        result: expect.objectContaining({ paymentEvidence: original.evidence })
      }
    });
    Object.assign(original.row, {
      status: 'awaiting_review',
      leaseOwner: null,
      leaseId: null,
      leaseExpiresAt: null
    });
    const stored = (original.row.result as Record<string, unknown>)
      .paymentEvidence as Prisma.JsonValue;
    const recheck = fixture(
      {
        operation: 'subscription',
        plan: 'pro_500',
        payload: {
          originalOperation: 'recharge',
          recheckTaskId: original.row.id,
          sourceVersion: 1,
          paymentContext: original.context,
          originalPaymentEvidence: stored
        }
      },
      original.row
    );
    recheck.tx.onlineRechargeEvent.findUnique.mockResolvedValue({
      id: 'usage-already-recorded'
    } as never);
    await recheck.worker.finish(
      recheck.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: stored,
          confirmation: original.confirmation
        }
      }),
      false
    );
    expect(original.row.status).toBe('succeeded');
    expect(recheck.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    expect(recheck.tx.onlineRechargeBill.create).toHaveBeenCalledTimes(1);
    expect(recheck.orderSync.enqueueInTransaction).toHaveBeenCalledTimes(1);
  });

  it('计卡后本地失败回执不能丢弃事务内已保存的付款证据', async () => {
    const f = upgradeFixture();
    await f.worker.beforeSubmit(f.submit());
    await f.worker.cardAction(
      f.rpc({ cardId: f.context.cardId, paymentEvidence: f.evidence }),
      'recordCardUsage'
    );
    await f.worker.finish(
      f.rpc({ status: 'failed', message: '本地后续步骤失败', result: { confirmedPaid: false } }),
      true
    );
    expect(f.row).toMatchObject({
      status: 'awaiting_review',
      confirmedPaid: true,
      result: { paymentEvidence: f.evidence }
    });
  });

  it('原单已付但套餐延迟时保留卡占用，后续准确核对和迟到回执只记账一次', async () => {
    const original = upgradeFixture();
    await original.worker.beforeSubmit(original.submit());
    Object.assign(original.row, { status: 'awaiting_review', leaseVersion: 2 });
    const recheck = () =>
      fixture(
        {
          operation: 'subscription',
          plan: 'pro_500',
          payload: {
            originalOperation: 'recharge',
            recheckTaskId: original.row.id,
            sourceVersion: 2,
            paymentContext: original.context
          }
        },
        original.row
      );
    const first = recheck();
    await first.worker.finish(
      first.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: original.evidence,
          confirmation: { ...original.confirmation, hasActiveSubscription: false }
        }
      }),
      false
    );
    expect(original.row).toMatchObject({
      status: 'awaiting_review',
      confirmedPaid: true,
      stage: 'paid_pending_activation'
    });
    expect(first.tx.onlineRechargeCard.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { leaseOwner: original.row.id } })
    );
    expect(first.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    expect(first.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
    expect(first.orderSync.enqueueInTransaction).not.toHaveBeenCalled();
    const later = recheck();
    later.tx.onlineRechargeCard.findUnique.mockResolvedValue({
      id: original.context.cardId,
      successCount: 0,
      declineCount: 0,
      status: 'active'
    });
    await later.worker.finish(
      later.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: original.evidence,
          confirmation: original.confirmation
        }
      }),
      false
    );
    expect(original.row.status).toBe('succeeded');
    expect(later.tx.onlineRechargeCard.update).toHaveBeenCalledTimes(1);
    expect(later.tx.onlineRechargeBill.create).toHaveBeenCalledTimes(1);
    expect(later.orderSync.enqueueInTransaction).toHaveBeenCalledTimes(1);
    const duplicate = recheck();
    await duplicate.worker.finish(
      duplicate.rpc({
        status: 'succeeded',
        result: {
          confirmedPaid: true,
          paymentEvidence: original.evidence,
          confirmation: original.confirmation
        }
      }),
      false
    );
    expect(duplicate.tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    expect(duplicate.tx.onlineRechargeBill.create).not.toHaveBeenCalled();
    expect(duplicate.orderSync.enqueueInTransaction).not.toHaveBeenCalled();
  });

  it('只有Pro或未来未生效档位保留待核对，不用旧订阅冒充500成功', async () => {
    for (const proof of [
      { observedCanonicalPlan: undefined, tierVerified: false },
      { observedCanonicalPlan: 'pro_20x' },
      { hasActiveSubscription: false }
    ]) {
      const f = upgradeFixture();
      await f.worker.beforeSubmit(f.submit());
      expect(
        await f.worker.finish(
          f.rpc({
            status: 'succeeded',
            result: {
              confirmedPaid: true,
              confirmation: { ...f.confirmation, ...proof },
              paymentEvidence: f.evidence
            }
          }),
          false
        )
      ).toMatchObject({ status: 'awaiting_review' });
    }
  });
});
