import { computed, effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBitBrowserDirectOpen } from './useBitBrowserDirectOpen';
import { DirectBrowserError } from './bitbrowser-direct-api';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
import { ApiError } from '@/api/apiError';
const mock = vi.hoisted(() => ({ run: vi.fn(), callback: vi.fn(), cancel: vi.fn() }));
vi.mock('./bitbrowser-direct-login', () => ({ runDirectLogin: mock.run }));
vi.mock('./api', () => ({
  rechargeApi: { directBrowserCallback: mock.callback, cancelBitBrowser: mock.cancel }
}));
const launch = (): V2RechargeBitBrowserOpenLaunch => ({
  id: 'job-fixture',
  mode: 'open_browser',
  connectorUrl: '',
  connectorToken: '',
  agentToken: 'fixture-only-agent',
  bitBrowser: {
    localApiUrl: 'http://localhost:54345',
    localApiToken: 'fixture-only-api',
    groupName: '组',
    tagName: '标签',
    proxyType: 'http',
    dynamicProxyUrl: 'https://example.invalid/proxy'
  }
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.callback.mockResolvedValue({ ok: true });
  mock.cancel.mockResolvedValue({ id: 'job-fixture', cancellationConfirmed: true });
});
describe('网页直连登录任务生命周期', () => {
  it('密码登录携带服务端账号绑定，重建回执及后续终态统一使用新ID', async () => {
    const current = launch();
    current.accountKey = 'c'.repeat(64);
    current.ownedProfile = {
      sourceJobId: 'source-job',
      profileId: 'a'.repeat(32),
      accountKey: current.accountKey
    };
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      expect(hooks.accountKey).toBe(current.accountKey);
      expect(hooks.ownedProfile).toEqual(current.ownedProfile);
      await hooks.progress('owned_profile_check', {
        browser_profile_id: current.ownedProfile!.profileId
      });
      await hooks.progress('bitbrowser_profile_created', {
        browser_profile_id: 'b'.repeat(32),
        replaced_browser_profile_id: current.ownedProfile!.profileId,
        browser_profile_missing_confirmed: true
      });
      return { status: 'session_ready', account_matched: true };
    });
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    await controller.start(
      current,
      { login: { email: 'fixture@example.com', password: 'fixture-password' } },
      '窗口'
    );
    await vi.waitFor(() => expect(controller.running.value).toBe(false));
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { browser_profile_id: 'b'.repeat(32), payment_requests_sent: 0 }
    });
    expect(
      mock.callback.mock.calls.find(
        ([, , input]) => input.result?.stage === 'bitbrowser_profile_created'
      )?.[2].result
    ).toMatchObject({
      replaced_browser_profile_id: 'a'.repeat(32),
      browser_profile_missing_confirmed: true
    });
    scope.stop();
  });
  it('自动验证码的有效期沿原任务传递给官网提交执行器', async () => {
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    let received: unknown;
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      received = await hooks.code();
      return { status: 'session_ready', account_matched: true };
    });
    await controller.start(
      launch(),
      { login: { email: 'fixture@example.com', password: 'fixture-password' } },
      '窗口'
    );
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    controller.submitCode('job-fixture', '123456', expiresAt);
    await vi.waitFor(() => expect(controller.running.value).toBe(false));
    expect(received).toEqual({ token: '123456', expiresAt });
    scope.stop();
  });
  it('通过原任务授权回调取得归属证明，再把原窗口编号写回执行状态', async () => {
    const ownedProfile = {
      sourceJobId: 'source-job',
      profileId: 'a'.repeat(32),
      accountKey: 'c'.repeat(64)
    };
    mock.callback.mockImplementation(async (_id, _token, input) =>
      input.type === 'restore' ? { ownedProfile, records: [], staleProfiles: [] } : { ok: true }
    );
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      const restored = await hooks.restore(ownedProfile.accountKey);
      expect(restored.ownedProfile).toEqual(ownedProfile);
      await hooks.progress('owned_profile_check', {
        browser_profile_id: restored.ownedProfile.profileId
      });
      return { status: 'session_ready', account_matched: true };
    });
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    await controller.start(launch(), { sessionJson: 'fixture-json' }, '窗口');
    await vi.waitFor(() => expect(controller.running.value).toBe(false));
    expect(mock.callback.mock.calls.find(([, , input]) => input.type === 'restore')).toEqual([
      'job-fixture',
      'fixture-only-agent',
      { type: 'restore', accountKey: ownedProfile.accountKey },
      { signal: expect.any(AbortSignal) }
    ]);
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { browser_profile_id: ownedProfile.profileId, payment_requests_sent: 0 }
    });
    scope.stop();
  });
  it('验证码绑定当前任务且只接收一次，结果写入后清除临时凭据', async () => {
    const scope = effectScope();
    const errors: string[] = [];
    const controller = scope.run(() =>
      useBitBrowserDirectOpen(
        async () => undefined,
        (value) => errors.push(value)
      )
    )!;
    let received = '';
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      received = await hooks.code();
      return { status: 'session_ready', account_matched: true };
    });
    const input = launch();
    const credential = { login: { email: 'fixture@example.com', password: 'fixture-password' } };
    await controller.start(input, credential, '窗口');
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    expect(() => controller.submitCode('other-job', '123456')).toThrow('没有等待验证码');
    controller.submitCode(input.id, '123456');
    expect(() => controller.submitCode(input.id, '123456')).toThrow();
    await vi.waitFor(() => expect(controller.owns(input.id)).toBe(false));
    expect(received).toBe('123456');
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { account_matched: true, payment_requests_sent: 0 }
    });
    expect(credential.login.password).toBe('');
    expect(input.bitBrowser.localApiToken).toBe('');
    expect(input.agentToken).toBe('');
    expect(errors).toEqual([]);
    scope.stop();
  });
  it('页面销毁停止未完成的自动操作，并保存取消结果，不把取消当成登录成功', async () => {
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    mock.run.mockImplementation(
      async (_settings, _credential, _name, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('fixture-abort')), { once: true })
        )
    );
    await controller.start(
      launch(),
      { login: { email: 'fixture@example.com', password: 'fixture-password' } },
      '窗口'
    );
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    scope.stop();
    await vi.waitFor(() => expect(controller.owns('job-fixture')).toBe(false));
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { status: 'cancelled', cancellation_confirmed: true, payment_requests_sent: 0 }
    });
  });
  it('无法记录开始事件时不执行浏览器指令，保留可重试状态', async () => {
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    mock.callback.mockRejectedValueOnce(new Error('fixture-callback-unavailable'));
    await expect(
      controller.start(launch(), { sessionJson: 'fixture-json' }, '窗口')
    ).rejects.toThrow('fixture-callback-unavailable');
    expect(mock.run).not.toHaveBeenCalled();
    expect(controller.owns('job-fixture')).toBe(false);
    scope.stop();
  });
  it('任务启动响应迟到且页面已关闭时拒绝执行，并清除临时凭据', async () => {
    const scope = effectScope();
    const controller = scope.run(() => useBitBrowserDirectOpen(async () => undefined, vi.fn()))!;
    const input = launch();
    const credential = { sessionJson: 'fixture-json' };
    scope.stop();
    await expect(controller.start(input, credential, '窗口')).rejects.toThrow('已停止');
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.callback).not.toHaveBeenCalled();
    expect(credential.sessionJson).toBe('');
    expect(input.agentToken).toBe('');
    expect(input.bitBrowser.localApiToken).toBe('');
  });
});

afterEach(() => vi.resetAllMocks());

describe('仅登录窗口控制器收尾', () => {
  it('成功结果已保存后刷新失败，不回传矛盾失败结果或误报浏览器执行失败', async () => {
    mock.run.mockResolvedValue({ status: 'session_ready', account_matched: true });
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fixture-refresh-unavailable'));
    const scope = effectScope();
    const error = vi.fn();
    const flow = scope.run(() => useBitBrowserDirectOpen(refresh, error))!;
    const current = launch();
    const credential = { sessionJson: 'fixture-json' };
    await flow.start(current, credential, '测试窗口');
    await vi.waitFor(() => expect(flow.running.value).toBe(false));
    const finished = mock.callback.mock.calls.filter(([, , input]) => input.type === 'finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.[2]).toMatchObject({
      type: 'finished',
      result: { status: 'session_ready', account_matched: true, payment_requests_sent: 0 }
    });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '执行状态已保存，但页面刷新失败，请刷新原任务核对。'
    );
    expect(credential.sessionJson).toBe('');
    expect(current.agentToken).toBe('');
    expect(current.bitBrowser.localApiToken).toBe('');
    scope.stop();
  });

  it('已确认的开始事件刷新失败时继续原任务，后续状态仍通过授权回调保存', async () => {
    mock.run.mockResolvedValue({ status: 'session_ready', account_matched: true });
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('fixture-refresh-unavailable'))
      .mockResolvedValueOnce(undefined);
    const scope = effectScope();
    const error = vi.fn();
    const flow = scope.run(() => useBitBrowserDirectOpen(refresh, error))!;
    await flow.start(launch(), { sessionJson: 'fixture-json' }, '测试窗口');
    await vi.waitFor(() => expect(flow.running.value).toBe(false));
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.callback.mock.calls.map(([, , input]) => input.type)).toEqual([
      'progress',
      'finished'
    ]);
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { status: 'session_ready', account_matched: true }
    });
    expect(error).toHaveBeenCalledExactlyOnceWith(
      '执行状态已保存，但页面刷新失败，请刷新原任务核对。'
    );
    scope.stop();
  });

  it('登录失败且终态保存失败后响应式释放控制器，可重新操作', async () => {
    mock.callback.mockResolvedValueOnce({ ok: true }).mockRejectedValue(new Error('离线'));
    mock.run.mockRejectedValue(new DirectBrowserError('official_login_not_verified'));
    const scope = effectScope();
    const error = vi.fn();
    const flow = scope.run(() => useBitBrowserDirectOpen(vi.fn(), error))!;
    const current = launch();
    const credential = { sessionJson: 'fixture-json' };
    const owns = computed(() => flow.owns(current.id));
    expect(owns.value).toBe(false);
    await flow.start(current, credential, '测试窗口');
    await vi.waitFor(() => expect(mock.callback).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(owns.value).toBe(false));
    expect(credential.sessionJson).toBe('');
    expect(current.agentToken).toBe('');
    expect(current.bitBrowser.localApiToken).toBe('');
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('资料已解锁'));
    scope.stop();
  });

  it('另一页面已结束任务时中止本地执行，不再用旧凭据回传或报失败', async () => {
    mock.callback.mockResolvedValue({ ok: true });
    mock.cancel.mockResolvedValue({ id: 'job-fixture', cancellationConfirmed: true });
    mock.run.mockImplementation(
      (_settings, _credential, _name, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(new DirectBrowserError('bitbrowser_direct_cancelled'))
          )
        )
    );
    const scope = effectScope();
    const error = vi.fn();
    const flow = scope.run(() => useBitBrowserDirectOpen(vi.fn(), error))!;
    const current = launch();
    await flow.start(current, { sessionJson: 'fixture-json' }, '测试窗口');
    await vi.waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    expect(flow.owns(current.id)).toBe(true);
    expect(flow.running.value).toBe(true);
    await flow.cancel(current.id, true);
    expect(flow.owns(current.id)).toBe(false);
    expect(flow.running.value).toBe(false);
    expect(mock.callback).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    scope.stop();
  });
  it('页面读取挂起时进度继续保存、登录正常结束，只合并一次补读', async () => {
    let release!: () => void;
    const reading = new Promise<void>((resolve) => (release = resolve));
    const refresh = vi.fn().mockReturnValueOnce(reading).mockResolvedValue(undefined);
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      await hooks.progress('owned_profile_check', { browser_profile_id: 'a'.repeat(32) });
      await hooks.progress('session_restore', {});
      return { status: 'session_ready', account_matched: true };
    });
    const scope = effectScope();
    const flow = scope.run(() => useBitBrowserDirectOpen(refresh, vi.fn()))!;
    await flow.start(launch(), { sessionJson: 'fixture-json' }, '测试窗口');
    await vi.waitFor(() => expect(flow.running.value).toBe(false));
    expect(refresh).toHaveBeenCalledOnce();
    expect(mock.callback.mock.calls.map(([, , input]) => input.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'finished'
    ]);
    release();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    scope.stop();
  });
  it('原始409及请求编号不会被终态保存失败、取消结果或迟到页面读取错误覆盖', async () => {
    const primary = new ApiError('原单付款状态未安全核实，不能更换比特窗口', {
      code: 'RECHARGE_PROFILE_CONFLICT',
      kind: 'conflict',
      requestId: 'fixture-original-request-id',
      status: 409,
      retryable: false
    });
    let failRead!: (reason: unknown) => void;
    const refresh = vi.fn(() => new Promise<void>((_resolve, reject) => (failRead = reject)));
    mock.callback.mockResolvedValueOnce({ ok: true }).mockRejectedValue(primary);
    mock.run.mockImplementation(async (_settings, _credential, _name, _signal, hooks) => {
      await hooks.progress('owned_profile_check', {});
    });
    const report = vi.fn();
    const scope = effectScope();
    const flow = scope.run(() => useBitBrowserDirectOpen(refresh, report))!;
    await flow.start(launch(), { sessionJson: 'fixture-json' }, '测试窗口');
    await vi.waitFor(() => expect(flow.running.value).toBe(false));
    expect(mock.cancel).toHaveBeenCalledOnce();
    expect(report.mock.lastCall?.[0]).toContain(primary.message);
    expect(report.mock.lastCall?.[0]).toContain(primary.code);
    expect(report.mock.lastCall?.[0]).toContain(primary.requestId);
    expect(report.mock.lastCall?.[0]).toContain('资料已解锁');
    const reports = report.mock.calls.length;
    failRead(new Error('fixture-delayed-read-failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(reports);
    scope.stop();
  });
  it('首进度请求挂起时也可以立即停止，收尾使用独立信号并清理资料', async () => {
    let initialSignal!: AbortSignal;
    mock.callback.mockImplementationOnce((_id, _token, _input, options) => {
      initialSignal = options.signal;
      return new Promise(() => {});
    });
    const scope = effectScope();
    const flow = scope.run(() => useBitBrowserDirectOpen(vi.fn(), vi.fn()))!;
    const input = launch();
    const credential = { sessionJson: 'fixture-json' };
    const started = flow.start(input, credential, '测试窗口');
    const failed = expect(started).rejects.toThrow('已停止');
    expect(flow.running.value).toBe(true);
    await flow.cancel(input.id);
    await failed;
    expect(flow.running.value).toBe(false);
    expect(initialSignal.aborted).toBe(true);
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { status: 'cancelled', cancellation_confirmed: true }
    });
    expect(mock.callback.mock.calls.at(-1)?.[3].signal.aborted).toBe(false);
    expect(input.agentToken).toBe('');
    expect(credential.sessionJson).toBe('');
    scope.stop();
  });
});
