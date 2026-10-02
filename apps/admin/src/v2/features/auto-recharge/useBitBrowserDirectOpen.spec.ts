import { effectScope } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBitBrowserDirectOpen } from './useBitBrowserDirectOpen';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
const mock = vi.hoisted(() => ({ run: vi.fn(), callback: vi.fn() }));
vi.mock('./bitbrowser-direct-login', () => ({ runDirectLogin: mock.run }));
vi.mock('./api', () => ({ rechargeApi: { directBrowserCallback: mock.callback } }));
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
});
describe('网页直连登录任务生命周期', () => {
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
