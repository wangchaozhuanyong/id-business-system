import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { RegistrationMailDeliveryService } from './registration-mail-delivery.service';
import { registrationWorkerCommand } from './registration-worker';
vi.mock('./registration-worker', () => ({ registrationWorkerCommand: vi.fn() }));

function fixture(patch: object = {}) {
  const row = {
    id: 'job-1',
    ownerId: 'owner-1',
    state: 'awaiting_email',
    leaseUntil: new Date(Date.now() + 60_000),
    attempt: 2,
    step: 'email_code',
    nonceHash: 'fixture-nonce',
    codeRequestedAt: new Date(Date.now() - 1000),
    lastMailId: null as string | null,
    ...patch
  };
  const repository = {
    find: vi.fn().mockResolvedValue(row),
    waitingMailJobs: vi.fn().mockResolvedValue([row])
  };
  const jobs = {
    code: vi
      .fn()
      .mockResolvedValue({ code: '123456', mailId: 'mail-1', attempt: 2, step: 'email_code' })
  };
  const identity = {
    getAuthenticatedUser: vi
      .fn()
      .mockResolvedValue({ id: 'owner-1', roles: ['admin'], mustResetPassword: false })
  };
  const service = new RegistrationMailDeliveryService(
    { subscribe: vi.fn() } as never,
    repository as never,
    jobs as never,
    identity as never
  );
  return { service, repository, jobs, identity, row };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}
describe('邮件到达唤醒注册执行器', () => {
  beforeEach(() => {
    vi.mocked(registrationWorkerCommand).mockReset().mockResolvedValue({ delivery: 'accepted' });
  });
  it('并发进入步骤和到信事件合并为一次私网投递', async () => {
    vi.mocked(registrationWorkerCommand).mockResolvedValueOnce({ delivery: 'accepted' });
    const f = fixture();
    await Promise.all([f.service.deliver('job-1'), f.service.deliver('job-1')]);
    expect(f.jobs.code).toHaveBeenCalledTimes(1);
  });
  it('投递带尝试、步骤及邮件编号的验证码，不记录验证码内容', async () => {
    vi.mocked(registrationWorkerCommand).mockResolvedValueOnce({ delivery: 'accepted' });
    const f = fixture();
    await f.service.deliver('job-1');
    expect(registrationWorkerCommand).toHaveBeenLastCalledWith('job-1', 2, 'code', {
      attempt: 2,
      step: 'email_code',
      code: '123456',
      mailId: 'mail-1'
    });
  });
  it.each([
    { state: 'cancelled' },
    { state: 'running' },
    { leaseUntil: new Date(0) },
    { nonceHash: null },
    { codeRequestedAt: null }
  ])('停止、过期或缺失绑定的任务不读码 %j', async (patch) => {
    const f = fixture(patch);
    await f.service.deliver('job-1');
    expect(f.jobs.code).not.toHaveBeenCalled();
  });
  it('管理员授权失效不继续，未确认投递不冒充成功', async () => {
    const f = fixture();
    f.identity.getAuthenticatedUser.mockResolvedValueOnce({
      id: 'owner-1',
      roles: [],
      mustResetPassword: false
    });
    await f.service.deliver('job-1');
    expect(f.jobs.code).not.toHaveBeenCalled();
    vi.mocked(registrationWorkerCommand).mockResolvedValueOnce({ delivery: 'unknown' });
    await expect(f.service.deliver('job-1')).rejects.toThrow('尚未确认');
  });
  it('首轮查信期间的新触发在空结果后补齐一次并仅投递一次', async () => {
    const command = vi.mocked(registrationWorkerCommand);
    command.mockClear();
    command.mockResolvedValue({ delivery: 'accepted' });
    const f = fixture();
    let lookupStarted!: () => void;
    let finishFirstLookup!: (value: { code: null }) => void;
    const started = new Promise<void>((resolve) => (lookupStarted = resolve));
    const firstLookup = new Promise<{ code: null }>((resolve) => (finishFirstLookup = resolve));
    f.jobs.code.mockImplementationOnce(() => {
      lookupStarted();
      return firstLookup;
    });

    const firstTrigger = f.service.deliver('job-1');
    await started;
    const laterTriggers = Array.from({ length: 3 }, () => f.service.deliver('job-1'));
    finishFirstLookup({ code: null });
    await Promise.all([firstTrigger, ...laterTriggers]);

    expect.soft(f.jobs.code).toHaveBeenCalledTimes(2);
    expect.soft(command).toHaveBeenCalledTimes(1);
  });
  it('首次空结果且没有新触发时不启动定时查信', async () => {
    vi.useFakeTimers();
    try {
      const command = vi.mocked(registrationWorkerCommand);
      command.mockClear();
      const f = fixture();
      f.jobs.code.mockResolvedValueOnce({ code: null });

      await f.service.deliver('job-1');
      expect(f.jobs.code).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.jobs.code).toHaveBeenCalledTimes(1);
      expect(command).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('多个触发补查后仍为空时结束，不自行启动第三次查询', async () => {
    const f = fixture();
    const started = deferred<void>();
    const first = deferred<{ code: null }>();
    f.jobs.code.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    f.jobs.code.mockResolvedValueOnce({ code: null });
    const waiting = f.service.deliver('job-1');
    await started.promise;
    const triggers = Array.from({ length: 3 }, () => f.service.deliver('job-1'));
    first.resolve({ code: null });
    await Promise.all([waiting, ...triggers]);
    expect(f.jobs.code).toHaveBeenCalledTimes(2);
    expect(registrationWorkerCommand).not.toHaveBeenCalled();
  });
  it('首轮码已确认投递时丢弃合并触发，不重读重送', async () => {
    const f = fixture();
    const started = deferred<void>();
    const first = deferred<{ code: string; mailId: string; attempt: number; step: string }>();
    f.jobs.code.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const waiting = f.service.deliver('job-1');
    await started.promise;
    const triggers = Array.from({ length: 3 }, () => f.service.deliver('job-1'));
    first.resolve({ code: '123456', mailId: 'mail-1', attempt: 2, step: 'email_code' });
    await Promise.all([waiting, ...triggers]);
    expect(f.jobs.code).toHaveBeenCalledTimes(1);
    expect(registrationWorkerCommand).toHaveBeenCalledTimes(1);
  });
  it.each([null, '123456'])('停止服务后在途结果%j不能投递或补查', async (code) => {
    const f = fixture();
    const started = deferred<void>();
    const first = deferred<{
      code: string | null;
      mailId: string;
      attempt: number;
      step: string;
    }>();
    f.jobs.code.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    const waiting = f.service.deliver('job-1');
    await started.promise;
    const trigger = f.service.deliver('job-1');
    f.service.onModuleDestroy();
    first.resolve({ code, mailId: 'mail-1', attempt: 2, step: 'email_code' });
    await Promise.all([waiting, trigger]);
    await f.service.deliver('job-1');
    expect(f.jobs.code).toHaveBeenCalledTimes(1);
    expect(registrationWorkerCommand).not.toHaveBeenCalled();
  });
  it.each([{ state: 'cancelled' }, { leaseUntil: new Date(0) }])(
    '补查前任务终止%j时不读迟到码',
    async (patch) => {
      const f = fixture();
      const started = deferred<void>();
      const first = deferred<{ code: null }>();
      f.jobs.code.mockImplementationOnce(() => {
        started.resolve();
        return first.promise;
      });
      const waiting = f.service.deliver('job-1');
      await started.promise;
      const trigger = f.service.deliver('job-1');
      Object.assign(f.row, patch);
      first.resolve({ code: null });
      await Promise.all([waiting, trigger]);
      expect(f.jobs.code).toHaveBeenCalledTimes(1);
      expect(registrationWorkerCommand).not.toHaveBeenCalled();
    }
  );
  it.each([
    { state: 'cancelled' },
    { leaseUntil: new Date(0) },
    { attempt: 3 },
    { step: 'password' },
    { nonceHash: 'fixture-revoked' },
    { codeRequestedAt: new Date(0) },
    { lastMailId: 'mail-1' }
  ])('查询返回后绑定变化%j时不投递或补查', async (patch) => {
    const f = fixture();
    f.jobs.code.mockImplementationOnce(async () => {
      Object.assign(f.row, patch);
      return { code: '123456', mailId: 'mail-1', attempt: 2, step: 'email_code' };
    });
    await Promise.all([f.service.deliver('job-1'), f.service.deliver('job-1')]);
    expect(f.jobs.code).toHaveBeenCalledTimes(1);
    expect(registrationWorkerCommand).not.toHaveBeenCalled();
  });
  it('查询期间管理员权限被撤销时不投递', async () => {
    const f = fixture();
    f.jobs.code.mockImplementationOnce(async () => {
      f.identity.getAuthenticatedUser.mockResolvedValueOnce({
        id: 'owner-1',
        roles: [],
        mustResetPassword: false
      });
      return { code: '123456', mailId: 'mail-1', attempt: 2, step: 'email_code' };
    });
    await Promise.all([f.service.deliver('job-1'), f.service.deliver('job-1')]);
    expect(f.jobs.code).toHaveBeenCalledTimes(1);
    expect(registrationWorkerCommand).not.toHaveBeenCalled();
  });
  it.each([new ConflictException(), new ForbiddenException()])(
    '读码受控拒绝%s时不消耗合并触发',
    async (error) => {
      const f = fixture();
      f.jobs.code.mockRejectedValueOnce(error);
      await Promise.all([f.service.deliver('job-1'), f.service.deliver('job-1')]);
      expect(f.jobs.code).toHaveBeenCalledTimes(1);
      expect(registrationWorkerCommand).not.toHaveBeenCalled();
    }
  );
  it('并发失败只安排一次重试，真实触发成功后取消旧重试', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.jobs.code.mockRejectedValueOnce(new Error('fixture transport failure'));
      f.service.request('job-1');
      f.service.request('job-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(f.jobs.code).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await f.service.deliver('job-1');
      expect(f.jobs.code).toHaveBeenCalledTimes(2);
      expect(registrationWorkerCommand).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.jobs.code).toHaveBeenCalledTimes(2);
      expect(registrationWorkerCommand).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
