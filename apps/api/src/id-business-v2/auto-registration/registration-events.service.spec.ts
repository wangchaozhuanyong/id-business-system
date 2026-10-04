import { describe, expect, it, vi } from 'vitest';
import { RegistrationEventsService } from './registration-events.service';
import { registrationTokenHash } from './registration-jobs.service';

describe('原窗口验证码时间边界', () => {
  function fixture(patch: object = {}) {
    const token = 'a'.repeat(64);
    const job = {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: 'owner',
      attempt: 2,
      state: 'running',
      step: 'email_code',
      registered: false,
      passwordVerified: false,
      mfaVerified: false,
      browserProfileId: 'reg_fixture_1',
      nonceHash: registrationTokenHash(token),
      codeRequestedAt: new Date(Date.now() - 120_000),
      leaseUntil: new Date(Date.now() + 60_000),
      ...patch
    };
    const repository = {
      lock: vi.fn(),
      findInTransaction: vi.fn().mockResolvedValue(job),
      fingerprintExists: vi.fn().mockResolvedValue(false),
      update: vi.fn(async (_tx, _id, data) => {
        Object.assign(job, data);
        return { ...job };
      }),
      saveAccount: vi.fn().mockResolvedValue({ id: 'account' })
    };
    const service = new RegistrationEventsService(
      repository as never,
      { execute: (work: (tx: object) => unknown) => work({}) } as never,
      { append: vi.fn() } as never,
      {} as never
    );
    return { service, repository, job, token };
  }
  it('新的执行尝试在同一步骤和保留窗口继续时不排除暂停期间邮件', async () => {
    const f = fixture();
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'email_code',
      newMailRequest: false
    });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBe(previousTime);
  });
  it('原窗口同一步骤触发新邮件时重新设置读码边界', async () => {
    const f = fixture();
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'email_code',
      newMailRequest: true
    });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBeGreaterThan(
      previousTime
    );
  });
  it('旧执行器缺少新请求标记时沿用原时间重置行为', async () => {
    const f = fixture();
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'email_code'
    });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBeGreaterThan(
      previousTime
    );
  });
  it.each([null, 'true', 1, {}])('拒绝非布尔邮件请求标记%j', async (newMailRequest) => {
    const f = fixture();
    await expect(
      f.service.event(f.job.id, f.token, {
        type: 'waiting_email',
        attempt: 2,
        step: 'email_code',
        newMailRequest
      })
    ).rejects.toThrow('邮件请求标记无效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('其他回执不能提交邮件请求标记', async () => {
    const f = fixture();
    await expect(
      f.service.event(f.job.id, f.token, {
        type: 'progress',
        attempt: 2,
        newMailRequest: true
      })
    ).rejects.toThrow('邮件请求标记无效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('新的窗口首次请求使用新的时间边界', async () => {
    const f = fixture({ browserProfileId: null });
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'email_code',
      browserProfileId: 'reg_fixture_2'
    });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBeGreaterThan(
      previousTime
    );
  });
  it('过期尝试不能调整读码边界', async () => {
    const f = fixture();
    await expect(
      f.service.event(f.job.id, f.token, { type: 'waiting_email', attempt: 1, step: 'email_code' })
    ).rejects.toThrow('授权已失效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('原窗口进入新的验证步骤时重新设置时间边界', async () => {
    const f = fixture({ registered: true });
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'password'
    });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBeGreaterThan(
      previousTime
    );
  });
  it.each(['password', 'mfa'])('先更新%s进度后，新验证请求也重新设置读码边界', async (step) => {
    const f = fixture({ registered: true, passwordVerified: true });
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, { type: 'progress', attempt: 2, step });
    expect(f.job.step).toBe(step);
    await f.service.event(f.job.id, f.token, { type: 'waiting_email', attempt: 2, step });
    const waiting = f.repository.update.mock.calls.find(
      (call) => call[2].state === 'awaiting_email'
    );
    expect(waiting![2].codeRequestedAt.getTime()).toBeGreaterThan(previousTime);
  });
  it.each(['password', 'mfa'])('同一%s步骤的新验证请求不会复用上次时间', async (step) => {
    const f = fixture({ step, registered: true, passwordVerified: true });
    const previousTime = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, { type: 'waiting_email', attempt: 2, step });
    expect(f.repository.update.mock.calls[0][2].codeRequestedAt.getTime()).toBeGreaterThan(
      previousTime
    );
  });
  it.each(['completed', 'cancelled'])('终止状态%s不能重新进入读码', async (state) => {
    const f = fixture({ state });
    await expect(
      f.service.event(f.job.id, f.token, {
        type: 'waiting_email',
        attempt: 2,
        step: 'email_code'
      })
    ).rejects.toThrow('授权已失效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('授权到期不能恢复读码', async () => {
    const f = fixture({ leaseUntil: new Date(Date.now() - 1000) });
    await expect(
      f.service.event(f.job.id, f.token, {
        type: 'waiting_email',
        attempt: 2,
        step: 'email_code'
      })
    ).rejects.toThrow('授权已失效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
});
