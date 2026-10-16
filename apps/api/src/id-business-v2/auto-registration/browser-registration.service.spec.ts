import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { BrowserRegistrationService } from './browser-registration.service';
import type { AppleMailboxesService } from './apple-mailboxes.service';
import type { AutoRegistrationService } from './auto-registration.service';
import type { RechargeSettingsService } from '../auto-recharge/public-api';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';

const taskId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://admin.example.test';
const nonce = 'fixture-browser-nonce-00000000000000000000';
const claimId = createHash('sha256').update(nonce).digest('hex');
const operator: AuthenticatedUser = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'fixture',
  displayName: '测试管理员',
  roles: ['admin'],
  permissions: []
};

describe('独立浏览器注册任务授权', () => {
  const previousOrigin = process.env.CORS_ORIGIN;
  const mailboxes = { start: vi.fn() };
  const worker = { appleMailboxRequest: vi.fn() };
  const settings = { runtime: vi.fn() };
  const audit = { create: vi.fn() };
  const revalidate = vi.fn();
  let service: BrowserRegistrationService;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
    process.env.CORS_ORIGIN = origin;
    revalidate.mockResolvedValue(true);
    mailboxes.start.mockResolvedValue({
      taskUuid: taskId,
      record: { email: 'fixture@example.test' }
    });
    worker.appleMailboxRequest.mockResolvedValue({ taskUuid: taskId });
    settings.runtime.mockResolvedValue({
      localApiUrl: 'http://127.0.0.1:54345',
      localApiToken: 'synthetic-bitbrowser-fixture',
      connectorToken: 'must-never-be-forwarded',
      browserOptions: { coreVersion: '140' }
    });
    audit.create.mockResolvedValue({});
    service = new BrowserRegistrationService(
      mailboxes as unknown as AppleMailboxesService,
      worker as unknown as AutoRegistrationService,
      settings as unknown as RechargeSettingsService,
      audit as unknown as AuditLogsService
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
    if (previousOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previousOrigin;
  });
  const start = () =>
    service.start({ aliasId: 'alias-one', revision: 1 }, operator, revalidate, origin);
  const call = (
    token: string,
    action: 'claim' | 'event' | 'code' | 'result' | 'fail',
    body: unknown = {},
    browserNonce = nonce
  ) => service.callback(taskId, action, `Bearer ${token}`, browserNonce, body);

  it('验证连接配置后才占用邮箱，使用独立执行入口与不含凭据的启动票据', async () => {
    const result = await start();
    expect(settings.runtime).toHaveBeenCalledWith(operator.id, true, true);
    expect(mailboxes.start).toHaveBeenCalledWith(
      { aliasId: 'alias-one', revision: 1 },
      operator,
      revalidate,
      'browser'
    );
    expect(result.callbackBaseUrl).toBe(
      `${origin}/api/id-business-v2/auto-registration/browser/tasks/${taskId}`
    );
    expect(result.launchToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result)).not.toContain('synthetic-bitbrowser');
  });

  it.each(['https://evil.example.test', `${origin}/`, 'http://admin.example.test', undefined])(
    '拒绝不匹配的管理端来源 %s',
    async (badOrigin) => {
      await expect(service.start({}, operator, revalidate, badOrigin)).rejects.toThrow();
      expect(mailboxes.start).not.toHaveBeenCalled();
    }
  );

  it('本机配置缺失不占用邮箱', async () => {
    settings.runtime.mockRejectedValue(new Error('fixture unavailable'));
    await expect(start()).rejects.toThrow();
    expect(mailboxes.start).not.toHaveBeenCalled();
  });

  it('拒绝非管理员和失效会话', async () => {
    await expect(
      service.start({}, { ...operator, roles: [] }, revalidate, origin)
    ).rejects.toThrow();
    revalidate.mockResolvedValue(false);
    await expect(start()).rejects.toThrow();
    expect(mailboxes.start).not.toHaveBeenCalled();
  });

  it('首次接管只传指定配置与本任务私有响应，充值密钥不传递', async () => {
    const grant = await start();
    worker.appleMailboxRequest.mockResolvedValue({
      email: 'fixture@example.test',
      password: 'synthetic-password-fixture',
      proxy: null
    });
    const result = await call(grant.launchToken, 'claim');
    expect(worker.appleMailboxRequest).toHaveBeenLastCalledWith(
      `/internal/apple-mailboxes/browser/tasks/${taskId}/claim`,
      'POST',
      { claimId },
      operator.id
    );
    expect(JSON.stringify(result)).toContain('synthetic-password-fixture');
    expect(JSON.stringify(result)).not.toContain('must-never-be-forwarded');
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain('synthetic-password-fixture');
  });

  it('拒绝错误票据、跨任务与接管前操作', async () => {
    const grant = await start();
    await expect(call('x'.repeat(43), 'claim')).rejects.toThrow();
    await expect(
      service.callback(
        '22222222-2222-4222-8222-222222222222',
        'claim',
        `Bearer ${grant.launchToken}`,
        nonce,
        {}
      )
    ).rejects.toThrow();
    await expect(
      call(grant.launchToken, 'event', { event: 'password_submitting', sequence: 1 })
    ).rejects.toThrow();
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it('同一浏览器可幂等接管，不允许另一个浏览器替换', async () => {
    const grant = await start();
    await call(grant.launchToken, 'claim');
    await call(grant.launchToken, 'claim');
    await expect(
      call(grant.launchToken, 'claim', {}, 'different-browser-nonce-000000000000000')
    ).rejects.toThrow();
    expect(worker.appleMailboxRequest).toHaveBeenCalledTimes(2);
  });

  it('每次回调重新验证原操作者，失效后不转交密码或验证码', async () => {
    const grant = await start();
    await call(grant.launchToken, 'claim');
    revalidate.mockResolvedValue(false);
    worker.appleMailboxRequest.mockClear();
    await expect(
      call(grant.launchToken, 'code', { after: new Date().toISOString() })
    ).rejects.toThrow();
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it('过期及服务重启不自动恢复票据或重新注册', async () => {
    const grant = await start();
    vi.advanceTimersByTime(30 * 60_000);
    await expect(call(grant.launchToken, 'claim')).rejects.toThrow();
    service.onModuleDestroy();
    await expect(call(grant.launchToken, 'claim')).rejects.toThrow();
    expect(mailboxes.start).toHaveBeenCalledTimes(1);
  });

  it('拒绝用户覆盖内部绑定和非闭合操作', async () => {
    const grant = await start();
    await expect(call(grant.launchToken, 'claim', { claimId: 'replacement' })).rejects.toThrow();
    await expect(
      service.callback(taskId, '../start' as 'event', `Bearer ${grant.launchToken}`, nonce, {})
    ).rejects.toThrow();
    expect(worker.appleMailboxRequest).not.toHaveBeenCalled();
  });

  it('结果审计不保存回调凭据', async () => {
    const grant = await start();
    await call(grant.launchToken, 'claim');
    const body = { session: { accessToken: 'synthetic-access-fixture' } };
    await call(grant.launchToken, 'result', body);
    expect(worker.appleMailboxRequest).toHaveBeenLastCalledWith(
      `/internal/apple-mailboxes/browser/tasks/${taskId}/result`,
      'POST',
      { ...body, claimId },
      operator.id
    );
    expect(JSON.stringify(audit.create.mock.calls)).not.toContain('synthetic-access-fixture');
  });
});
