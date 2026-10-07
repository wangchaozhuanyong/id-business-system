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

describe('已注册冷续接的首次真实窗口绑定', () => {
  const profile = 'reg_' + 'b'.repeat(64);
  function fixture() {
    const token = 'a'.repeat(64);
    const job = {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: 'owner',
      accountId: 'account',
      emailHash: 'hash:synthetic@example.invalid',
      attempt: 2,
      state: 'running',
      step: 'password',
      registered: true,
      passwordVerified: false,
      mfaVerified: false,
      browserProfileId: null,
      reason: 'registered_profile_recovery_pending',
      registrationCountryCode: 'US',
      nonceHash: registrationTokenHash(token),
      codeRequestedAt: new Date(Date.now() - 120_000),
      leaseUntil: new Date(Date.now() + 60_000)
    };
    const account = {
      id: job.accountId,
      emailHash: job.emailHash,
      registered: true,
      deletedAt: null
    };
    const repository = {
      lock: vi.fn(),
      findInTransaction: vi.fn(async () => ({ ...job })),
      account: vi.fn().mockResolvedValue(account),
      fingerprintExists: vi.fn().mockResolvedValue(false),
      update: vi.fn(async (_tx, _id, data) => {
        Object.assign(job, data);
        return { ...job };
      }),
      saveAccount: vi.fn().mockResolvedValue(account)
    };
    const audit = { append: vi.fn() };
    const service = new RegistrationEventsService(
      repository as never,
      { execute: (work: (tx: object) => unknown) => work({}) } as never,
      audit as never,
      {} as never
    );
    const bind = (extra: object = {}) =>
      service.event(job.id, token, {
        type: 'progress',
        attempt: 2,
        step: 'password',
        reason: 'proxy_ready',
        browserProfileId: profile,
        ...extra
      });
    return { service, repository, audit, job, account, token, bind };
  }
  it('准备阶段保留许可，真指纹绑定后消费许可且审计不改变证据', async () => {
    const f = fixture();
    const requested = f.job.codeRequestedAt.getTime();
    await f.service.event(f.job.id, f.token, {
      type: 'progress',
      attempt: 2,
      step: 'password',
      reason: 'proxy_verifying'
    });
    expect(f.job.reason).toBe('registered_profile_recovery_pending');
    expect(f.job.browserProfileId).toBeNull();
    await f.bind();
    expect(f.job).toMatchObject({
      browserProfileId: profile,
      reason: 'proxy_ready',
      registered: true,
      passwordVerified: false,
      mfaVerified: false,
      accountId: 'account',
      registrationCountryCode: 'US'
    });
    expect(f.job.codeRequestedAt.getTime()).toBe(requested);
    expect(f.repository.fingerprintExists).toHaveBeenCalledWith({}, profile, f.job.id);
    expect(f.audit.append).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'id_business_v2.auto_registration.profile_rebound',
        objectId: f.job.id,
        afterData: { attempt: 2, browserProfileId: profile, accountId: 'account' }
      })
    );
    await f.service.event(f.job.id, f.token, {
      type: 'waiting_email',
      attempt: 2,
      step: 'password',
      newMailRequest: true
    });
    expect(f.job.codeRequestedAt.getTime()).toBeGreaterThan(requested);
  });
  it('重复指纹不能消费许可，后续唯一指纹仍可绑定一次', async () => {
    const f = fixture();
    f.repository.fingerprintExists.mockResolvedValueOnce(true);
    await expect(f.bind()).rejects.toThrow('指纹与已有任务重复');
    expect(f.repository.update).not.toHaveBeenCalled();
    expect(f.job.reason).toBe('registered_profile_recovery_pending');
    await f.bind({ browserProfileId: 'reg_' + 'c'.repeat(64) });
    await expect(f.bind()).rejects.toThrow('原浏览器窗口');
  });
  it.each([
    'waiting_email',
    'waiting_user',
    'registered',
    'password_verified',
    'totp_pending',
    'mfa_verified',
    'complete'
  ])('绑定前不得越过安全边界 %s', async (type) => {
    const f = fixture();
    await expect(f.service.event(f.job.id, f.token, { type, attempt: 2 })).rejects.toThrow(
      '尚未绑定'
    );
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it.each([
    { step: 'mfa' },
    { reason: 'other' },
    { reason: null },
    { browserProfileId: 'reg_fixture' },
    { browserProfileId: null },
    { browserProfileId: profile, reason: 'proxy_verifying' }
  ])('错误步骤或非真实绑定回执拒绝 %j', async (patch) => {
    const f = fixture();
    await expect(f.bind(patch)).rejects.toThrow('尚未绑定');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it.each([
    { id: 'other' },
    { emailHash: 'hash:other@example.invalid' },
    { registered: false },
    { deletedAt: new Date('2026-10-01T00:00:00Z') }
  ])('首次绑定再次检查账号一致性 %j', async (patch) => {
    const f = fixture();
    f.repository.account.mockResolvedValue({ ...f.account, ...patch });
    await expect(f.bind()).rejects.toThrow('检查点已变化');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('旧尝试、旧nonce和过期租约不能绑定新窗口', async () => {
    const f = fixture();
    await expect(f.bind({ attempt: 1 })).rejects.toThrow('授权已失效');
    await expect(
      f.service.event(f.job.id, 'b'.repeat(64), { type: 'progress', attempt: 2 })
    ).rejects.toThrow('授权已失效');
    f.job.leaseUntil = new Date(Date.now() - 1000);
    await expect(f.bind()).rejects.toThrow('授权已失效');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
  it('准备失败仅撤销授权并保留账号和未完成证据', async () => {
    const f = fixture();
    await f.service.event(f.job.id, f.token, {
      type: 'partial',
      attempt: 2,
      reason: 'session_load_timeout'
    });
    expect(f.job).toMatchObject({
      state: 'partial',
      nonceHash: null,
      leaseUntil: null,
      registered: true,
      passwordVerified: false,
      mfaVerified: false,
      browserProfileId: null
    });
  });
  it('partial不得携带窗口编号绕过首次绑定', async () => {
    const f = fixture();
    await expect(
      f.service.event(f.job.id, f.token, {
        type: 'partial',
        attempt: 2,
        browserProfileId: profile,
        reason: 'session_load_timeout'
      })
    ).rejects.toThrow('尚未绑定');
    expect(f.repository.update).not.toHaveBeenCalled();
  });
});
