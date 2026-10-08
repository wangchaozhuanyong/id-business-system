import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectBrowserError } from './bitbrowser-direct-api';
import { runDirectLogin } from './bitbrowser-direct-login';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';

const mock = vi.hoisted(() => ({
  post: vi.fn(),
  evaluate: vi.fn(),
  command: vi.fn(),
  close: vi.fn()
}));
vi.mock('./bitbrowser-cdp', () => ({
  BrowserCdp: {
    connect: async () => ({
      command: mock.command,
      evaluate: mock.evaluate,
      close: mock.close,
      onEvent: () => () => {}
    })
  }
}));
vi.mock('./bitbrowser-direct-api', async (original) => ({
  ...(await original<typeof import('./bitbrowser-direct-api')>()),
  directBrowserApi: () => ({ post: mock.post }),
  directBrowserCatalog: async () => ({
    groups: [{ id: 'group', name: '组' }],
    tags: [{ id: 'tag', name: '标签' }]
  })
}));
beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://fixture.invalid' } });
  mock.post.mockImplementation(async (path) => ({
    data:
      path === '/browser/update'
        ? { id: 'a'.repeat(32) }
        : path === '/browser/detail'
          ? {
              id: 'a'.repeat(32),
              syncTabs: false,
              syncCookies: false,
              syncLocalStorage: false,
              syncIndexedDb: false,
              syncAuthorization: false
            }
          : path === '/browser/open'
            ? { ws: 'ws://localhost:9222/devtools/browser/fixture' }
            : {}
  }));
  mock.command.mockImplementation(async (method) =>
    method === 'Browser.getVersion'
      ? { product: 'Chrome/152.0.0.0' }
      : method === 'Target.getTargets'
        ? { targetInfos: [{ type: 'page', targetId: 'page', url: 'about:blank' }] }
        : method === 'Target.attachToTarget'
          ? { sessionId: 'session' }
          : {}
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const settings = {
  localApiUrl: 'http://localhost:54345',
  localApiToken: 'fixture',
  groupName: '组',
  tagName: '标签',
  proxyType: 'http' as const,
  dynamicProxyUrl: ''
};
const credential = () => ({
  sessionJson: JSON.stringify({
    sessionToken: 'fixture-session',
    user: { id: 'user-fixture', email: 'user@example.com' },
    account: { id: 'account-fixture' }
  })
});

const identity = {
  kind: 'identity',
  email: 'user@example.com',
  userId: 'user-fixture',
  accountId: 'account-fixture',
  plan: 'free'
};
function automaticLogin(states: string[], submitWaits = 0) {
  let index = 0;
  const actions: string[] = [];
  mock.evaluate.mockImplementation(async (_session, expression: string) => {
    const action = /^"([^"]+)"/.exec(expression.slice(expression.lastIndexOf(')(') + 2))![1]!;
    actions.push(action);
    if (action === 'inspect') {
      const kind = states[Math.min(index++, states.length - 1)]!;
      return kind === 'identity' ? identity : { kind };
    }
    if (action === 'submit' && submitWaits-- > 0) return { kind: 'loading' };
    return { kind: action === 'login' || action === 'submit' ? 'submitted' : 'filled' };
  });
  return actions;
}

describe('仅登录窗口失败不会转成长时间的假验证等待', () => {
  it.each(['unauthenticated', 'email'])('JSON 会话失效立即失败：%s', async (kind) => {
    mock.evaluate.mockResolvedValue({ kind });
    const progress = vi.fn();
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        progress,
        code: vi.fn()
      })
    ).rejects.toThrow('未能确认官网账号登录成功');
    expect(progress.mock.calls.some(([stage]) => stage === 'verification_required')).toBe(false);
    expect(mock.close).toHaveBeenCalledOnce();
  });
  it('窗口控制连接断开立即结束，不吞掉错误并继续等待验证', async () => {
    mock.evaluate.mockRejectedValue(new DirectBrowserError('bitbrowser_direct_debug_unavailable'));
    const progress = vi.fn();
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        progress,
        code: vi.fn()
      })
    ).rejects.toThrow('网页无法连接窗口控制接口');
    expect(progress.mock.calls.some(([stage]) => stage === 'verification_required')).toBe(false);
    expect(mock.close).toHaveBeenCalledOnce();
  });
});

describe('账号密码自动登录的入口与表单提交', () => {
  it('无法确认实际内核时停止且不填写凭据', async () => {
    mock.command.mockResolvedValue({});
    await expect(
      runDirectLogin(
        settings,
        { login: { email: 'user@example.com', password: 'fixture-password' } },
        '测试窗口',
        new AbortController().signal,
        { progress: vi.fn(), code: vi.fn() }
      )
    ).rejects.toThrow('无法确认比特窗口实际使用的内核版本');
    expect(mock.evaluate).not.toHaveBeenCalled();
  });
  it('实际内核与配置不一致时不填写凭据', async () => {
    mock.command.mockResolvedValue({ product: 'Chrome/130.0.0.0' });
    await expect(
      runDirectLogin(
        settings,
        { login: { email: 'user@example.com', password: 'fixture-password' } },
        '测试窗口',
        new AbortController().signal,
        { progress: vi.fn(), code: vi.fn() }
      )
    ).rejects.toThrow('配置');
    expect(mock.evaluate).not.toHaveBeenCalled();
  });
  it('依次打开登录入口、提交邮箱密码及2FA，核实身份后成功且清理密码', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['login', 'email', 'password', 'code', 'identity']);
    const input = { login: { email: 'user@example.com', password: 'fixture-password' } };
    const code = vi.fn().mockResolvedValue('123456');
    const progress = vi.fn();
    const result = runDirectLogin(settings, input, '测试窗口', new AbortController().signal, {
      progress,
      code
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    expect(actions.filter((action) => action === 'login')).toHaveLength(1);
    expect(actions.filter((action) => action === 'submit')).toHaveLength(3);
    expect(code).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith('login_code_submitted');
    expect(mock.command.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(
      false
    );
    expect(input.login.password).toBe('');
  });

  it('等待启用中的提交按钮，不提前标记已提交或重复取2FA', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'code', 'identity'], 1);
    const code = vi.fn().mockResolvedValue('123456');
    const progress = vi.fn();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      { progress, code }
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'submit')).toHaveLength(2);
    expect(code).toHaveBeenCalledOnce();
    expect(progress.mock.calls.filter(([stage]) => stage === 'login_code_submitted')).toHaveLength(
      1
    );
  });

  it('用户完成官网验证后恢复未提交的步骤，已提交步骤不自动重放', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['manual', 'email', 'email', 'password', 'identity']);
    const progress = vi.fn();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      { progress, code: vi.fn() }
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'email')).toHaveLength(1);
    expect(actions.filter((action) => action === 'submit')).toHaveLength(2);
    expect(progress).toHaveBeenCalledWith('verification_required', { user_action_required: true });
  });

  it.each(['password', 'code'])(
    '提交%s时出现验证，完成后继续原步骤且只取一次验证码',
    async (kind) => {
      vi.useFakeTimers();
      const actions = automaticLogin([kind, 'manual', kind, 'identity']);
      const evaluate = mock.evaluate.getMockImplementation()!;
      let challenge = true;
      mock.evaluate.mockImplementation(async (...args) => {
        const state = await evaluate(...args);
        if (actions.at(-1) === 'submit' && challenge) {
          challenge = false;
          return { kind: 'manual' };
        }
        return state;
      });
      const code = vi.fn().mockResolvedValue('123456');
      const progress = vi.fn();
      const result = runDirectLogin(
        settings,
        { login: { email: 'user@example.com', password: 'fixture-password' } },
        '测试窗口',
        new AbortController().signal,
        { progress, code }
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect((await result).status).toBe('session_ready');
      expect(actions.filter((action) => action === kind)).toHaveLength(2);
      expect(actions.filter((action) => action === 'submit')).toHaveLength(2);
      expect(code).toHaveBeenCalledTimes(kind === 'code' ? 1 : 0);
      expect(progress).toHaveBeenCalledWith('verification_required', {
        user_action_required: true
      });
    }
  );

  it('同一未就绪表单超时后保持人工处理，不循环重置自动等待预算', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['email'], Infinity);
    const controller = new AbortController();
    const result = runDirectLogin(
      {
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionWaitMinutes: 1 }
      },
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      controller.signal,
      { progress: vi.fn(), code: vi.fn() }
    );
    const cancelled = expect(result).rejects.toThrow('已停止');
    await vi.advanceTimersByTimeAsync(70_000);
    const count = actions.filter((action) => action === 'submit').length;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(actions.filter((action) => action === 'submit')).toHaveLength(count);
    controller.abort();
    await cancelled;
  });
});
