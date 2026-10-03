import { describe, expect, it, vi } from 'vitest';
import { RechargeEmailCodeController } from './recharge-email-code.controller';
import { RechargeEmailCodeService } from './recharge-email-code.service';

const id = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const job = {
    id,
    ownerId: 'admin-test',
    action: 'server',
    state: 'running',
    leaseUntil: new Date(Date.now() + 60_000),
    expectedEmailEncrypted: 'encrypted-fixture',
    result: { stage: 'login_email', payment_requests_sent: 0 } as Record<string, unknown>
  };
  const repository = {
    lock: vi.fn(),
    active: vi.fn(async () => job),
    updateJob: vi.fn(async (_tx, _id, data) => {
      job.result = data.result;
    })
  };
  const operator = { id: job.ownerId, roles: ['admin'], mustResetPassword: false };
  const identity = { getAuthenticatedUser: vi.fn(async () => operator) };
  const mailboxes = {
    rechargeMailbox: vi.fn(async () => ({
      aliasId: 'alias-fixture',
      email: 'owner@example.invalid'
    })),
    rechargeCode: vi.fn(async () => ({ mailId: 'mail-fixture', code: '123456' }))
  };
  const encryption = { decrypt: vi.fn(() => 'owner@example.invalid') };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const service = new RechargeEmailCodeService(
    repository as never,
    transactions as never,
    identity as never,
    encryption as never,
    mailboxes as never,
    audit as never
  );
  async function prepare() {
    await service.request(id, { type: 'prepare' });
    job.result.stage = 'login_email_code_required';
  }
  return { service, job, repository, identity, operator, mailboxes, encryption, audit, prepare };
}

describe('充值登录邮箱验证码', () => {
  it('内部接口先校验 worker 身份，不接受普通未认证请求', async () => {
    const recharge = {
      authorizeWorker: vi.fn(() => {
        throw new Error('denied');
      })
    };
    const codes = { request: vi.fn() };
    const controller = new RechargeEmailCodeController(recharge as never, codes as never);
    expect(() => controller.request(id, undefined, { type: 'read' })).toThrow('denied');
    expect(codes.request).not.toHaveBeenCalled();
  });

  it('准备时间只分配一次，读码不落盘，官网接受后才确认邮件且不再查询', async () => {
    const f = fixture();
    await f.prepare();
    const requestedAt = f.job.result.login_mail_requested_at;
    await f.service.request(id, { type: 'prepare' });
    expect(f.job.result.login_mail_requested_at).toBe(requestedAt);
    expect(await f.service.request(id, { type: 'read' })).toEqual({
      mail: {
        mailId: 'mail-fixture',
        code: '123456'
      }
    });
    expect(f.job.result.login_mail_received_id).toBeUndefined();
    expect(JSON.stringify(f.job.result)).not.toContain('123456');
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('123456');
    expect(f.mailboxes.rechargeCode).toHaveBeenCalledWith(
      'alias-fixture',
      'owner@example.invalid',
      new Date(String(requestedAt)),
      null,
      f.operator
    );
    await expect(f.service.request(id, { type: 'received', mailId: 'other' })).rejects.toThrow();
    f.job.result.stage = 'login_email_code_submitted';
    await expect(f.service.request(id, { type: 'received', mailId: 'other' })).rejects.toThrow(
      '不匹配'
    );
    await f.service.request(id, { type: 'received', mailId: 'mail-fixture' });
    await f.service.request(id, { type: 'received', mailId: 'mail-fixture' });
    f.job.result.stage = 'login_email_code_required';
    expect(await f.service.request(id, { type: 'read' })).toEqual({ mail: null });
    expect(f.mailboxes.rechargeCode).toHaveBeenCalledTimes(1);
    expect(f.repository.lock.mock.calls.length).toBeGreaterThan(1);
  });

  it.each([
    { state: 'finished' },
    { action: 'bitbrowser' },
    { leaseUntil: new Date(0) },
    { expectedEmailEncrypted: null },
    { result: { stage: 'login_email_code_required', status: 'cancelling' } },
    { result: { stage: 'login_email_code_required', payment_attempted: true } },
    { result: { stage: 'login_email_code_required', payment_requests_sent: 1 } },
    { result: { stage: 'login_code_required' } }
  ])('结束/取消/付款/其他验证页面拒绝读码 %j', async (patch) => {
    const f = fixture();
    Object.assign(f.job, patch);
    await expect(f.service.request(id, { type: 'read' })).rejects.toThrow();
    expect(f.mailboxes.rechargeCode).not.toHaveBeenCalled();
  });

  it.each([{ roles: ['staff'] }, { mustResetPassword: true }])(
    '管理员授权失效拒绝 %j',
    async (patch) => {
      const f = fixture();
      Object.assign(f.operator, patch);
      await expect(f.service.request(id, { type: 'prepare' })).rejects.toThrow('授权已失效');
      expect(f.mailboxes.rechargeMailbox).not.toHaveBeenCalled();
    }
  );

  it.each(['cancel', 'email', 'alias', 'authorization', 'lease'])(
    '邮件查询期间 %s 变化不会返回码',
    async (change) => {
      const f = fixture();
      await f.prepare();
      f.mailboxes.rechargeCode.mockImplementationOnce(async () => {
        if (change === 'cancel') f.job.result.status = 'cancelling';
        if (change === 'email') f.encryption.decrypt.mockReturnValue('changed@example.invalid');
        if (change === 'alias')
          f.mailboxes.rechargeMailbox.mockResolvedValue({
            aliasId: 'changed',
            email: 'owner@example.invalid'
          });
        if (change === 'authorization')
          f.mailboxes.rechargeMailbox.mockRejectedValue(new Error('撤权'));
        if (change === 'lease') f.job.leaseUntil = new Date(0);
        return { mailId: 'mail-fixture', code: '123456' };
      });
      await expect(f.service.request(id, { type: 'read' })).rejects.toThrow();
      expect(f.job.result.login_mail_offered_id).toBeUndefined();
    }
  );

  it('不接受外部指定邮箱、验证码、时间或任意接收确认', async () => {
    const f = fixture();
    for (const input of [
      { type: 'prepare', email: 'other@example.invalid' },
      { type: 'read', code: '123456' },
      { type: 'prepare', since: new Date().toISOString() },
      { type: 'received' },
      { type: 'read', mailId: 'mail-fixture' }
    ])
      await expect(f.service.request(id, input)).rejects.toThrow('请求无效');
    expect(f.repository.active).not.toHaveBeenCalled();
    await f.prepare();
    f.job.result.login_mail_requested_at = new Date(Date.now() - 11 * 60_000).toISOString();
    await expect(f.service.request(id, { type: 'read' })).rejects.toThrow('窗口已失效');
  });
});
