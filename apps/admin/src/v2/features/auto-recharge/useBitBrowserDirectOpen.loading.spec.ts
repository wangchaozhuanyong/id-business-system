import type { EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeBitBrowserOpenLaunch } from './contracts';
import type { DirectLoginCredential } from './bitbrowser-direct-credential';

const mock = vi.hoisted(() => ({ callback: vi.fn(), run: vi.fn() }));
vi.mock('./api', () => ({ rechargeApi: { directBrowserCallback: mock.callback } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const launch = (): V2RechargeBitBrowserOpenLaunch => ({
  id: 'loading-job-fixture',
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
    dynamicProxyUrl: 'https://example.invalid/proxy',
    staticProxyCredentials: { username: 'fixture-user', password: 'fixture-password' }
  }
});

let scope: EffectScope;
let flow: ReturnType<typeof import('./useBitBrowserDirectOpen').useBitBrowserDirectOpen>;
let loading: ReturnType<typeof deferred<{ runDirectLogin: typeof mock.run }>>;
let entered = vi.fn<() => void>();
let reportError = vi.fn<(message: string) => void>();

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  loading = deferred();
  entered = vi.fn<() => void>();
  reportError = vi.fn<(message: string) => void>();
  vi.doMock('./bitbrowser-direct-login', async () => {
    entered();
    return loading.promise;
  });
  const { effectScope } = await import('vue');
  const { useBitBrowserDirectOpen } = await import('./useBitBrowserDirectOpen');
  mock.callback.mockResolvedValue({ ok: true });
  scope = effectScope();
  flow = scope.run(() => useBitBrowserDirectOpen(vi.fn(), reportError))!;
});

afterEach(() => {
  scope.stop();
  vi.doUnmock('./bitbrowser-direct-login');
  vi.resetModules();
});

async function startLoading(credential: DirectLoginCredential) {
  const input = launch();
  expect(entered).not.toHaveBeenCalled();
  await flow.start(input, credential, '测试窗口');
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  expect(flow.owns(input.id)).toBe(true);
  expect(flow.running.value).toBe(true);
  expect(mock.run).not.toHaveBeenCalled();
  return input;
}

function expectCleared(input: V2RechargeBitBrowserOpenLaunch, credential: DirectLoginCredential) {
  if (credential.login) expect(credential.login.password).toBe('');
  else expect(credential.sessionJson).toBe('');
  expect(input.agentToken).toBe('');
  expect(input.bitBrowser.localApiToken).toBe('');
  expect(input.bitBrowser.dynamicProxyUrl).toBe('');
  expect(input.bitBrowser.staticProxyCredentials?.password).toBe('');
  expect(flow.owns(input.id)).toBe(false);
  expect(flow.running.value).toBe(false);
}

describe('登录执行模块按需加载', () => {
  it('记录开始事件并锁定任务后才加载，加载中重复点击不启动第二次执行', async () => {
    const credential = { login: { email: 'fixture@example.com', password: 'fixture-password' } };
    const input = await startLoading(credential);
    expect(mock.callback).toHaveBeenCalledOnce();
    await expect(flow.start(launch(), credential, '重复窗口')).rejects.toThrow('已有登录任务');
    expect(entered).toHaveBeenCalledOnce();
    mock.run.mockResolvedValue({ status: 'session_ready', account_matched: true });
    loading.resolve({ runDirectLogin: mock.run });
    await vi.waitFor(() => expect(flow.running.value).toBe(false));
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
      type: 'finished',
      result: { status: 'session_ready', payment_attempted: false, payment_requests_sent: 0 }
    });
    expectCleared(input, credential);
  });

  it.each(['cancel', 'dispose', 'remote'] as const)(
    '加载期间停止（%s）后，即使模块随后成功加载也不执行浏览器指令',
    async (stop) => {
      const credential = { sessionJson: 'fixture-session' };
      const input = await startLoading(credential);
      const stopped = stop === 'dispose' ? scope.stop() : flow.cancel(input.id, stop === 'remote');
      loading.resolve({ runDirectLogin: mock.run });
      await stopped;
      await vi.waitFor(() => expect(flow.running.value).toBe(false));
      expect(mock.run).not.toHaveBeenCalled();
      if (stop === 'remote') expect(mock.callback).toHaveBeenCalledOnce();
      else
        expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
          type: 'finished',
          result: {
            status: 'cancelled',
            cancellation_confirmed: true,
            payment_attempted: false,
            payment_requests_sent: 0
          }
        });
      if (stop !== 'cancel') expect(reportError).not.toHaveBeenCalled();
      expectCleared(input, credential);
    }
  );

  it.each(['active', 'cancel', 'dispose', 'remote'] as const)(
    '模块加载失败（%s）沿用失败或取消终态并清理临时凭据',
    async (state) => {
      const credential = { login: { email: 'fixture@example.com', password: 'fixture-password' } };
      const input = await startLoading(credential);
      let stopped: Promise<void> | undefined;
      if (state === 'dispose') scope.stop();
      else if (state !== 'active') stopped = flow.cancel(input.id, state === 'remote');
      loading.reject(new Error('fixture-module-download-failed'));
      await stopped;
      await vi.waitFor(() => expect(flow.running.value).toBe(false));
      expect(mock.run).not.toHaveBeenCalled();
      if (state === 'remote') expect(mock.callback).toHaveBeenCalledOnce();
      else
        expect(mock.callback.mock.calls.at(-1)?.[2]).toMatchObject({
          type: 'finished',
          result: {
            status: state === 'active' ? 'blocked' : 'cancelled',
            reason:
              state === 'active'
                ? 'bitbrowser_direct_command_failed'
                : 'bitbrowser_direct_cancelled',
            payment_attempted: false,
            payment_requests_sent: 0
          }
        });
      if (state === 'remote' || state === 'dispose') expect(reportError).not.toHaveBeenCalled();
      else expect(reportError).toHaveBeenCalledOnce();
      expectCleared(input, credential);
    }
  );
});
