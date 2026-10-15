import { ConflictException } from '@nestjs/common';
import type { OnlineRechargeTask } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import type { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import type { OnlineRechargeSettingsService } from '../settings.service';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './worker.repository';

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
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => null)
    },
    onlineRechargeCode: { updateMany: vi.fn(async () => ({ count: 0 })) },
    onlineRechargeBill: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => null)
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
  const worker = new OnlineRechargeWorkerRepository(
    repository as unknown as OnlineRechargeRepository,
    {} as OnlineRechargeSettingsService,
    { decrypt: () => syntheticSession } as unknown as FieldEncryptionService,
    {} as OnlineRechargeEphemeralCredentials
  );
  const rpc = (args: Record<string, unknown> = {}): OnlineRechargeWorkerRpc => ({
    method: 'beforeExternalSubmit',
    taskId: row.id,
    workerId: 'fixture-worker',
    leaseId: row.leaseId!,
    leaseVersion: row.leaseVersion,
    args: { stage: 'renewal_update', renewalAction: 'disable', ...args }
  });
  return { row, tx, repository, worker, rpc };
}

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

  it('普通充值核对仍接受同账号精确套餐付款证据', async () => {
    const f = recheckFixture(
      { operation: 'recharge', payload: {}, paymentStarted: true },
      {
        originalOperation: 'recharge'
      }
    );
    await f.worker.finish(
      f.rpc({
        status: 'succeeded',
        result: {
          success: true,
          confirmedPaid: true,
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
    expect(f.tx.onlineRechargeBill.create).toHaveBeenCalledTimes(1);
  });
});
