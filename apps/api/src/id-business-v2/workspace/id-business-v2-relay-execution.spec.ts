import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdBusinessV2RelayJob } from '@prisma/client';
import { IdBusinessV2RelayJobRunnerService } from './id-business-v2-relay-job-runner.service';
import { IdBusinessV2RelaySubscriptionAuthService } from './id-business-v2-relay-subscription-auth.service';
import { IdBusinessV2RelayScriptRepository } from './persistence/id-business-v2-relay-script.repository';
import type { IdBusinessV2RelayJobUpdate } from './persistence/id-business-v2-relay-script.repository';
import { idBusinessV2RelayJobSteps } from './id-business-v2-relay-script.support';

const operator = {
  id: 'current-owner',
  username: 'ppfzj1314',
  displayName: '负责人',
  roles: ['admin'],
  permissions: []
};
const job: IdBusinessV2RelayJob = {
  id: 'e400eb2b-6d10-4d9b-85a9-28310bc7ebea',
  userId: 'original-employee',
  accountLabel: '接管任务',
  deploymentKey: 'inherited-job',
  mode: 'gemini_api',
  status: 'draft',
  googleEmail: null,
  billingAccount: null,
  cloudBridgeAccountId: null,
  creditExpiresAt: null,
  completedSteps: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  lastErrorCode: null,
  lastErrorMessage: null,
  location: null,
  modeSecretEncrypted: null,
  modelMapping: {},
  progress: {},
  projectDisplayName: null,
  projectId: null,
  proxyId: null,
  referenceAccountId: null,
  runLeaseExpiresAt: null,
  runLeaseId: null,
  serviceAccountKeyEncrypted: null,
  settings: {},
  targetGroupId: 1
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const transactions = {
  execute: async (callback: (tx: unknown) => Promise<unknown>) => callback({})
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('relay execution ownership and protection', () => {
  it.each(['complete', 'progress', 'failed', 'finished'])(
    'records the current operator for inherited job %s',
    async (scenario) => {
      const audit = {
        append: vi.fn<(...args: unknown[]) => Promise<{ id: string }>>(async () => ({
          id: 'audit'
        }))
      };
      const repository = {
        findJobByIdAndUser: vi.fn(async () => ({
          ...job,
          completedSteps: scenario === 'finished' ? idBusinessV2RelayJobSteps(job.mode) : []
        })),
        withJobLease: async (
          id: string,
          userId: string,
          callback: (leaseId: string) => Promise<unknown>
        ) => {
          expect(id).toBe(job.id);
          expect(userId).toBe(operator.id);
          return callback('our-lease');
        },
        assertJobLease: vi.fn(async () => undefined),
        updateLeasedJob: vi.fn(
          async (id: string, leaseId: string, patch: IdBusinessV2RelayJobUpdate) => {
            expect(id).toBe(job.id);
            expect(leaseId).toBe('our-lease');
            return { ...job, ...patch, runLeaseId: leaseId };
          }
        )
      };
      const alternative = {
        execute: vi.fn(async () => {
          if (scenario === 'failed') throw new Error('synthetic remote failure');
          return { completed: scenario === 'complete', progress: {} };
        })
      };
      const relay = { requireCloudBridgeConnection: vi.fn(async () => ({})) };
      const service = new IdBusinessV2RelayJobRunnerService(
        repository as never,
        transactions as never,
        audit as never,
        {} as never,
        relay as never,
        alternative as never,
        {} as never,
        {} as never
      );
      await service.runNextStep(job.id, operator);
      expect(audit.append).toHaveBeenCalledTimes(1);
      expect(audit.append.mock.calls[0][1]).toMatchObject({
        userId: operator.id,
        objectId: job.id
      });
      expect(job.userId).toBe('original-employee');
    }
  );

  it('rejects a lost lease before failure cleanup can affect a replacement execution', async () => {
    const cleanup = vi.fn();
    const audit = { append: vi.fn() };
    const repository = {
      findJobByIdAndUser: vi.fn(async () => ({ ...job, cloudBridgeAccountId: 12 })),
      withJobLease: async (
        id: string,
        userId: string,
        callback: (leaseId: string) => Promise<unknown>
      ) => {
        expect(id).toBe(job.id);
        expect(userId).toBe(operator.id);
        return callback('expired-lease');
      },
      assertJobLease: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('执行保护已失效')),
      updateLeasedJob: vi.fn()
    };
    const service = new IdBusinessV2RelayJobRunnerService(
      repository as never,
      transactions as never,
      audit as never,
      {} as never,
      { requireCloudBridgeConnection: async () => ({}), withCloudBridgeSession: cleanup } as never,
      {
        execute: async () => {
          throw new Error('remote error');
        }
      } as never,
      {} as never,
      {} as never
    );
    await expect(service.runNextStep(job.id, operator)).rejects.toThrow('执行保护已失效');
    expect(cleanup).not.toHaveBeenCalled();
    expect(repository.updateLeasedJob).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe('relay lease lifecycle', () => {
  function repository() {
    const value = new IdBusinessV2RelayScriptRepository({} as never);
    const acquire = vi.spyOn(value, 'acquireJobLease').mockResolvedValue(true);
    const renew = vi.spyOn(value, 'renewJobLease').mockResolvedValue(true);
    const release = vi.spyOn(value, 'releaseJobLease').mockResolvedValue({ count: 1 });
    return { value, acquire, renew, release };
  }
  it('keeps a long operation protected beyond three minutes and stops renewing after completion', async () => {
    vi.useFakeTimers();
    const { value, acquire, renew, release } = repository();
    const work = deferred<string>();
    const result = value.withJobLease(job.id, operator.id, async () => work.promise);
    await vi.advanceTimersByTimeAsync(190_000);
    expect(renew).toHaveBeenCalledTimes(6);
    expect(release).not.toHaveBeenCalled();
    const leaseId = acquire.mock.calls[0][2];
    expect(renew.mock.calls.every((call) => call[1] === leaseId)).toBe(true);
    work.resolve('completed');
    await expect(result).resolves.toBe('completed');
    expect(release).toHaveBeenCalledWith(job.id, leaseId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(6);
  });
  it('reports renewal loss and releases only its own lease', async () => {
    vi.useFakeTimers();
    const { value, acquire, renew, release } = repository();
    renew.mockResolvedValue(false);
    const work = deferred<string>();
    const result = value.withJobLease(job.id, operator.id, async () => work.promise);
    const rejection = expect(result).rejects.toThrow('续期失败');
    await vi.advanceTimersByTimeAsync(190_000);
    expect(renew).toHaveBeenCalledTimes(1);
    work.resolve('late result');
    await rejection;
    expect(release).toHaveBeenCalledWith(job.id, acquire.mock.calls[0][2]);
  });
  it('blocks a competing operation without releasing the current holder', async () => {
    const { value, acquire, release } = repository();
    acquire.mockResolvedValue(false);
    const execute = vi.fn();
    await expect(value.withJobLease(job.id, operator.id, execute)).rejects.toThrow('正在执行');
    expect(execute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it('protects the whole subscription authorization start, including a delayed remote response', async () => {
    vi.useFakeTimers();
    const { value, renew, release } = repository();
    const remote = deferred<Record<string, string>>();
    vi.spyOn(value, 'findJobByIdAndUser').mockResolvedValue({
      ...job,
      mode: 'antigravity_subscription'
    });
    const update = vi.spyOn(value, 'updateLeasedJob').mockResolvedValue(job);
    const audit = { append: vi.fn(async () => ({ id: 'audit' })) };
    const service = new IdBusinessV2RelaySubscriptionAuthService(
      value,
      transactions as never,
      audit as never,
      { hash: () => 'synthetic-hash', encrypt: () => 'synthetic-encrypted' } as never,
      {
        requireCloudBridgeConnection: async () => ({}),
        withCloudBridgeSession: async () => remote.promise
      } as never,
      {} as never
    );
    const result = service.start(job.id, operator);
    await vi.advanceTimersByTimeAsync(190_000);
    expect(renew).toHaveBeenCalledTimes(6);
    expect(release).not.toHaveBeenCalled();
    remote.resolve({
      auth_url: 'https://accounts.google.com/o/oauth2/v2/auth',
      session_id: 'synthetic-session',
      state: 'synthetic-state'
    });
    await result;
    expect(update).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  });
  it('protects authorization completion and attributes its audit to the current operator', async () => {
    const { value, acquire, release } = repository();
    vi.spyOn(value, 'findJobByIdAndUser').mockResolvedValue({
      ...job,
      mode: 'antigravity_subscription',
      googleEmail: 'employee@example.invalid',
      modeSecretEncrypted: 'synthetic-encrypted',
      modelMapping: { 'gemini-model': 'gemini-model' }
    });
    const update = vi.spyOn(value, 'updateLeasedJob').mockResolvedValue(job);
    const audit = { append: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})) };
    const service = new IdBusinessV2RelaySubscriptionAuthService(
      value,
      transactions as never,
      audit as never,
      {
        hash: () => 'synthetic-hash',
        decrypt: () =>
          JSON.stringify({
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            sessionId: 'synthetic-session',
            state: 'synthetic-state',
            stateHash: 'synthetic-hash'
          })
      } as never,
      {
        requireCloudBridgeConnection: async () => ({}),
        withCloudBridgeSession: async (
          connection: unknown,
          callback: (value: string) => Promise<unknown>
        ) => callback('synthetic-token')
      } as never,
      {
        exchangeAntigravityCode: async () => ({ email: 'employee@example.invalid' }),
        createAntigravityAccount: async () => ({ id: 12 })
      } as never
    );
    await service.complete(
      job.id,
      { callbackUrl: 'http://localhost/callback?state=synthetic-state&code=synthetic-code' },
      operator
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toBe(acquire.mock.calls[0][2]);
    expect(audit.append.mock.calls[0][1]).toMatchObject({ userId: operator.id, objectId: job.id });
    expect(release).toHaveBeenCalledWith(job.id, acquire.mock.calls[0][2]);
  });
});
