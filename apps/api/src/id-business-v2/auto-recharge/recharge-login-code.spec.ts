import { afterEach, describe, expect, it, vi } from 'vitest';
import { RechargeLoginCodeService } from './recharge-login-code.service';

const jobId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const operator = { id: 'owner', roles: ['admin'] };
function fixture(kind: 'email' | 'totp' = 'email') {
  const job = {
    id: jobId,
    ownerId: 'owner',
    action: 'bitbrowser',
    state: 'awaiting_human_verification',
    chatgptAccountId: accountId,
    expectedEmailEncrypted: 'synthetic@example.invalid',
    createdAt: new Date(),
    leaseUntil: new Date(Date.now() + 60_000),
    result: {
      stage: 'login_code_required',
      login_code_type: kind,
      login_challenge_id: challengeId
    } as Record<string, unknown>
  };
  const repository = {
    lock: vi.fn(),
    active: vi.fn(async () => job),
    updateJob: vi.fn(async (_tx, _id, patch) => Object.assign(job, patch))
  };
  const audit = { append: vi.fn() };
  const accounts = {
    requireActive: vi.fn(async () => ({ emailEncrypted: 'synthetic@example.invalid' })),
    totpCode: vi.fn(async () => ({ token: '123456', expiresAt: new Date(Date.now() + 30_000) }))
  };
  const identity = { getAuthenticatedUser: vi.fn(async () => operator) };
  const mailboxes = {
    rechargeMailbox: vi.fn(async () => ({ aliasId: 'alias' })),
    waitForRechargeCode: vi.fn(async () => ({ code: '654321', mailId: 'mail' }))
  };
  const service = new RechargeLoginCodeService(
    repository as never,
    { execute: (work: (tx: unknown) => unknown) => work({}) } as never,
    audit as never,
    accounts as never,
    { decrypt: (value: string) => value } as never,
    identity as never,
    mailboxes as never
  );
  const input = { accountId, kind, challengeId };
  return { service, job, repository, accounts, mailboxes, identity, audit, input };
}
afterEach(() => vi.useRealTimers());
describe('比特登录自动取码绑定', () => {
  it('只领取指定任务的邮箱验证码一次，持久化结果和审计均不含验证码', async () => {
    const f = fixture();
    const result = await f.service.request(jobId, f.input, operator as never);
    expect(result).toMatchObject({ token: '654321', kind: 'email', challengeId });
    await expect(f.service.request(jobId, f.input, operator as never)).rejects.toThrow('已领取');
    expect(f.mailboxes.waitForRechargeCode).toHaveBeenCalledOnce();
    expect(f.accounts.totpCode).not.toHaveBeenCalled();
    expect(JSON.stringify([f.audit.append.mock.calls, f.job.result])).not.toContain('654321');
  });
  it.each(['owner', 'account', 'challenge', 'kind', 'paid', 'cancelled', 'permission'])(
    '拒绝不匹配或失效的 %s，不读取邮箱',
    async (change) => {
      const f = fixture();
      if (change === 'owner') f.job.ownerId = 'other';
      if (change === 'account') f.job.chatgptAccountId = jobId;
      if (change === 'challenge') f.job.result.login_challenge_id = jobId;
      if (change === 'kind') f.job.result.login_code_type = 'totp';
      if (change === 'paid') f.job.result.payment_attempted = true;
      if (change === 'cancelled') f.job.state = 'finished';
      if (change === 'permission')
        f.identity.getAuthenticatedUser.mockResolvedValue({ id: 'owner', roles: [] });
      await expect(f.service.request(jobId, f.input, operator as never)).rejects.toThrow();
      expect(f.mailboxes.waitForRechargeCode).not.toHaveBeenCalled();
    }
  );
  it('等待期间任务变化，迟到邮件不能返回或改写当前任务', async () => {
    const f = fixture();
    let receive!: (mail: { code: string; mailId: string }) => void;
    f.mailboxes.waitForRechargeCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          receive = resolve;
        })
    );
    const pending = f.service.request(jobId, f.input, operator as never);
    await vi.waitFor(() => expect(f.mailboxes.waitForRechargeCode).toHaveBeenCalledOnce());
    f.job.result.login_challenge_id = jobId;
    receive({ code: '654321', mailId: 'late' });
    await expect(pending).rejects.toThrow('已变化');
    expect(f.job.result).not.toHaveProperty('login_code_issued_email');
  });
  it('2FA 临期时等待下一周期，返回至少八秒有效期，完全不读取邮箱', async () => {
    vi.useFakeTimers();
    const f = fixture('totp');
    f.accounts.totpCode.mockResolvedValueOnce({
      token: '111111',
      expiresAt: new Date(Date.now() + 2000)
    });
    const pending = f.service.request(jobId, f.input, operator as never);
    await vi.advanceTimersByTimeAsync(2050);
    const result = await pending;
    expect(result).toMatchObject({ token: '123456', kind: 'totp' });
    expect(f.accounts.totpCode).toHaveBeenCalledTimes(2);
    expect(f.mailboxes.waitForRechargeCode).not.toHaveBeenCalled();
  });
});
