import { describe, expect, it, vi } from 'vitest';
import { RegistrationMailDeliveryService } from './registration-mail-delivery.service';
import { registrationWorkerCommand } from './registration-worker';
vi.mock('./registration-worker', () => ({ registrationWorkerCommand: vi.fn() }));

function fixture(patch: object = {}) {
  const row = {
    id: 'job-1',
    ownerId: 'owner-1',
    state: 'awaiting_email',
    leaseUntil: new Date(Date.now() + 60_000),
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
  return { service, repository, jobs, identity };
}
describe('邮件到达唤醒注册执行器', () => {
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
  it.each([{ state: 'cancelled' }, { state: 'running' }, { leaseUntil: new Date(0) }])(
    '停止或过期任务不读码 %j',
    async (patch) => {
      const f = fixture(patch);
      await f.service.deliver('job-1');
      expect(f.jobs.code).not.toHaveBeenCalled();
    }
  );
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
});
