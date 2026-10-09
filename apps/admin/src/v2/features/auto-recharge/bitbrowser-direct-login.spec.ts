import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectBrowserError, type DirectBrowserSettings } from './bitbrowser-direct-api';
import { runDirectLogin } from './bitbrowser-direct-login';
import { inspectLoginPage } from './bitbrowser-login-page';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';

const mock = vi.hoisted(() => ({
  post: vi.fn(),
  evaluate: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
  onEvent: vi.fn(),
  proxy: vi.fn(),
  ui: vi.fn()
}));
vi.mock('./bitbrowser-cdp', () => ({
  BrowserCdp: {
    connect: async () => ({
      command: mock.command,
      evaluate: (_session: string, expression: string, ...args: unknown[]) =>
        expression.includes('/cdn-cgi/trace')
          ? mock.proxy(_session, expression, ...args)
          : expression.includes('accounts-profile-button')
            ? mock.ui(_session, expression, ...args)
            : mock.evaluate(_session, expression, ...args),
      close: mock.close,
      onEvent: mock.onEvent
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
  mock.proxy.mockResolvedValue({ kind: 'proxy_ready' });
  mock.ui.mockResolvedValue({ kind: 'page_ready' });
  mock.onEvent.mockReturnValue(() => {});
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
      : method === 'Network.getCookies'
        ? { cookies: [] }
        : method === 'Target.getTargets'
          ? { targetInfos: [{ type: 'page', targetId: 'page', url: 'about:blank' }] }
          : method === 'Page.getFrameTree'
            ? { frameTree: { frame: { id: 'main-frame' } } }
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
const settings: DirectBrowserSettings = {
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
const isInspection = (expression: string) =>
  expression.slice(expression.lastIndexOf(')(') + 2).startsWith('"inspect"');
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

function pendingCode() {
  let resolve!: (value: string) => void;
  let reject!: (cause: unknown) => void;
  const code = vi.fn(
    () =>
      new Promise<string>((accept, decline) => {
        resolve = accept;
        reject = decline;
      })
  );
  return {
    code,
    resolve: () => resolve('123456'),
    reject: () => reject(new DirectBrowserError('official_login_not_verified'))
  };
}

describe('仅登录窗口失败不会转成长时间的假验证等待', () => {
  it('启动时不打开匿名官网，先装拦截与会话再导航', async () => {
    mock.evaluate.mockResolvedValue(identity);
    await runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
      progress: vi.fn(),
      code: vi.fn()
    });
    const created = mock.post.mock.calls.find(([path]) => path === '/browser/update')![1];
    expect(created).toMatchObject({ platform: '', url: 'about:blank', cookie: '' });
    const methods = mock.command.mock.calls.map(([method]) => method);
    expect(methods.indexOf('Fetch.enable')).toBeLessThan(methods.indexOf('Network.setCookies'));
    expect(methods.indexOf('Network.setCookies')).toBeLessThan(methods.indexOf('Page.navigate'));
    expect(mock.command.mock.calls.find(([method]) => method === 'Page.navigate')![1]).toEqual({
      url: 'https://chatgpt.com/'
    });
  });
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
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('官网持续返回过期令牌时最多观察15秒，不换IP或等待人工验证', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue({ kind: 'expired' });
    const progress = vi.fn();
    const pending = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { progress, code: vi.fn() }
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ reason: 'access_token_expired' });
    expect(
      mock.evaluate.mock.calls.filter(([, expression]) =>
        expression.includes('"refreshSession":true')
      )
    ).toHaveLength(1);
    expect(progress.mock.calls.some(([stage]) => stage === 'verification_required')).toBe(false);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('官网自行刷新后仍须核对有效身份，JSON检查不等待整页加载', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValueOnce({ kind: 'expired' }).mockResolvedValue(identity);
    const pending = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { progress: vi.fn(), code: vi.fn() }
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ account_matched: true, payment_requests_sent: 0 });
    expect(mock.evaluate.mock.calls[0]![1]).toContain('"sessionOnly":true');
    expect(mock.evaluate.mock.calls[0]![1]).toContain('"refreshSession":false');
    expect(mock.evaluate.mock.calls[1]![1]).toContain('"refreshSession":true');
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('过期会话观察期间身份变化立即停止，不能因刷新放宽核验', async () => {
    vi.useFakeTimers();
    mock.evaluate
      .mockResolvedValueOnce({ kind: 'expired' })
      .mockResolvedValue({ ...identity, userId: 'another-user' });
    const pending = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { progress: vi.fn(), code: vi.fn() }
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ reason: 'official_login_email_mismatch' });
  });
  it('取消过期会话观察立即结束', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue({ kind: 'expired' });
    const control = new AbortController();
    const pending = runDirectLogin(settings, credential(), '测试窗口', control.signal, {
      progress: vi.fn(),
      code: vi.fn()
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    control.abort();
    expect(await pending).toMatchObject({ reason: 'bitbrowser_direct_cancelled' });
  });
  it('官网明确刷新失败立即停止，不继续发刷新请求或换IP', async () => {
    mock.evaluate.mockResolvedValue({ kind: 'expired', refreshFailed: true });
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        progress: vi.fn(),
        code: vi.fn()
      })
    ).rejects.toMatchObject({ reason: 'access_token_expired' });
    expect(
      mock.evaluate.mock.calls.filter(([, expression]) =>
        expression.includes('"refreshSession":true')
      )
    ).toHaveLength(0);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('有效身份迟于观察期限返回时不能绕过15秒限制', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValueOnce({ kind: 'expired' }).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 15_000);
      return identity;
    });
    const pending = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { progress: vi.fn(), code: vi.fn() }
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ reason: 'access_token_expired' });
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

describe('JSON会话核实后同步官网登录界面', () => {
  const run = (signal = new AbortController().signal) =>
    runDirectLogin(settings, credential(), '测试窗口', signal, {
      progress: vi.fn(),
      code: vi.fn()
    });
  it('会话正确但页面匿名时等待10秒，再只刷新原标签一次并重新核对身份', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockResolvedValue({ kind: 'page_loading' });
    const original = mock.command.getMockImplementation()!;
    mock.command.mockImplementation(async (method, ...args) => {
      if (method === 'Page.reload') mock.ui.mockResolvedValue({ kind: 'page_ready' });
      return original(method, ...args);
    });
    let finished = false;
    const result = run().then((value) => {
      finished = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(finished).toBe(false);
    expect(mock.command.mock.calls.filter(([method]) => method === 'Page.reload')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await result).toMatchObject({
      status: 'session_ready',
      account_matched: true,
      payment_requests_sent: 0
    });
    expect(mock.command.mock.calls.filter(([method]) => method === 'Page.reload')).toEqual([
      ['Page.reload', { ignoreCache: true }, 'session', expect.any(Number)]
    ]);
    expect(
      mock.evaluate.mock.calls.filter(([, expression]) => expression.includes('"sessionOnly":true'))
        .length
    ).toBeGreaterThan(1);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('刷新后身份变化立即拒绝，旧账号界面控件不能覆盖账号核验', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockResolvedValue({ kind: 'page_loading' });
    const original = mock.command.getMockImplementation()!;
    mock.command.mockImplementation(async (method, ...args) => {
      if (method === 'Page.reload') {
        mock.ui.mockResolvedValue({ kind: 'page_ready' });
        mock.evaluate.mockResolvedValue({ ...identity, userId: 'another-user' });
      }
      return original(method, ...args);
    });
    const result = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toMatchObject({ reason: 'official_login_email_mismatch' });
  });
  it('页面持续未就绪有限结束，保留窗口，不误判过期、不换IP', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockResolvedValue({ kind: 'page_loading' });
    const result = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await result).toMatchObject({ reason: 'official_login_page_not_ready' });
    expect(mock.command.mock.calls.filter(([method]) => method === 'Page.reload')).toHaveLength(1);
    expect(
      mock.post.mock.calls.some(([path]) => ['/browser/close', '/browser/delete'].includes(path))
    ).toBe(false);
  });
  it('刷新后资源耗时60秒仍沿用原120秒阶段余量，不在20秒提前结束', async () => {
    vi.useFakeTimers();
    const readyAt = Date.now() + 60_000;
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockImplementation(async () => ({
      kind: Date.now() >= readyAt ? 'page_ready' : 'page_loading'
    }));
    const result = run();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    expect(mock.command.mock.calls.filter(([method]) => method === 'Page.reload')).toHaveLength(1);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('普通身份检查跨过原阶段截止后不能接受迟到成功，也不换IP', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockImplementation(async (_session, expression: string) => {
      if (isInspection(expression)) vi.setSystemTime(Date.now() + 120_001);
      return identity;
    });
    await expect(run()).rejects.toMatchObject({ reason: 'official_login_not_verified' });
    expect(mock.ui).not.toHaveBeenCalled();
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('账号控件检查跨过原阶段截止后不能接受迟到就绪', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 120_001);
      return { kind: 'page_ready' };
    });
    await expect(run()).rejects.toMatchObject({ reason: 'official_login_page_not_ready' });
    expect(mock.ui.mock.calls[0]?.[2]).toBe(120_000);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('普通身份和账号控件读取复用原阶段余量，不另给完整读取期限', async () => {
    vi.useFakeTimers();
    let reads = 0;
    mock.evaluate.mockImplementation(async (_session, expression: string) => {
      if (isInspection(expression) && reads++ === 0) {
        vi.setSystemTime(Date.now() + 118_000);
        return { kind: 'loading' };
      }
      return identity;
    });
    const result = run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    const inspections = mock.evaluate.mock.calls.filter(([, expression]) =>
      isInspection(expression)
    );
    expect(inspections[1]?.[1]).toContain('"sessionReadBudgetMs":1000');
    expect(inspections[1]?.[2]).toBe(1000);
    expect(mock.ui.mock.calls[0]?.[2]).toBe(1000);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('等待页面同步可立即取消，未完成前不释放付款拦截', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockResolvedValue({ kind: 'page_loading' });
    const control = new AbortController();
    const result = run(control.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.command.mock.calls.some(([method]) => method === 'Fetch.disable')).toBe(false);
    control.abort();
    expect(await result).toMatchObject({ reason: 'bitbrowser_direct_cancelled' });
    expect(mock.command.mock.calls.some(([method]) => method === 'Page.reload')).toBe(false);
  });
});

describe('API原窗口归属与当前官网身份双核验', () => {
  async function owned() {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account-fixture'));
    return {
      sourceJobId: 'source-job',
      profileId: 'a'.repeat(32),
      accountKey: Array.from(new Uint8Array(hash), (part) =>
        part.toString(16).padStart(2, '0')
      ).join('')
    };
  }
  it('同账号原窗口直接复用，不创建资料或重新注入JSON', async () => {
    mock.evaluate.mockResolvedValue(identity);
    const ownedProfile = await owned();
    const restore = vi.fn().mockResolvedValue({ ownedProfile });
    expect(
      await runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        restore,
        progress: vi.fn(),
        code: vi.fn()
      })
    ).toMatchObject({ status: 'session_ready' });
    expect(restore).toHaveBeenCalledWith(ownedProfile.accountKey);
    expect(
      mock.post.mock.calls.some(([path]) =>
        ['/browser/update', '/browser/delete', '/browserTag/updateRelation'].includes(path)
      )
    ).toBe(false);
    expect(mock.command.mock.calls.some(([method]) => method === 'Network.setCookies')).toBe(false);
    expect(
      mock.command.mock.calls.some(([method]) =>
        ['Network.getCookies', 'Network.deleteCookies'].includes(method)
      )
    ).toBe(false);
  });
  it('原窗口已切换到其他账号时不覆盖会话', async () => {
    mock.evaluate.mockResolvedValue({ ...identity, accountId: 'other-account' });
    const ownedProfile = await owned();
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        restore: async () => ({ ownedProfile }),
        progress: vi.fn(),
        code: vi.fn()
      })
    ).rejects.toMatchObject({ reason: 'official_login_email_mismatch' });
    expect(mock.command.mock.calls.some(([method]) => method === 'Network.setCookies')).toBe(false);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/update')).toBe(false);
  });
  it('归属窗口明确无会话后才注入JSON，后续身份仍严格核对', async () => {
    vi.useFakeTimers();
    const ownedProfile = await owned();
    mock.evaluate.mockResolvedValueOnce({ kind: 'unauthenticated' }).mockResolvedValue(identity);
    const result = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { restore: async () => ({ ownedProfile }), progress: vi.fn(), code: vi.fn() }
    );
    await vi.waitFor(() =>
      expect(mock.command.mock.calls.some(([method]) => method === 'Network.setCookies')).toBe(true)
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ account_matched: true });
    expect(
      mock.command.mock.calls.filter(([method]) => method === 'Network.setCookies')
    ).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/update')).toBe(false);
  });
  it('原窗口被删除明确报错，不回退新建', async () => {
    const ownedProfile = await owned();
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, ...args) =>
      path === '/browser/detail' ? { data: null } : original(path, ...args)
    );
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        restore: async () => ({ ownedProfile }),
        progress: vi.fn(),
        code: vi.fn()
      })
    ).rejects.toMatchObject({ reason: 'bitbrowser_owned_profile_missing' });
    expect(
      mock.post.mock.calls.some(([path]) => ['/browser/update', '/browser/open'].includes(path))
    ).toBe(false);
  });
  it.each([
    {
      oldNames: ['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1'],
      tokenSize: 32,
      chunkCount: 1
    },
    { oldNames: ['__Secure-next-auth.session-token'], tokenSize: 4200, chunkCount: 2 }
  ])(
    '明确匿名后清除旧Auth.js主cookie或chunk，保留其他cookie：$chunkCount段',
    async ({ oldNames, tokenSize, chunkCount }) => {
      vi.useFakeTimers();
      const ownedProfile = await owned();
      const original = mock.command.getMockImplementation()!;
      mock.command.mockImplementation(async (method, ...args) =>
        method === 'Network.getCookies'
          ? {
              cookies: [
                ...oldNames.map((name) => ({
                  name,
                  domain: '.chatgpt.com',
                  path: '/',
                  value: 'fixture-value'
                })),
                { name: 'cf_clearance', domain: '.chatgpt.com', path: '/', value: 'fixture-value' },
                {
                  name: '__Secure-next-auth.session-token.extra',
                  domain: '.chatgpt.com',
                  path: '/',
                  value: 'fixture-value'
                },
                {
                  name: '__Secure-next-auth.session-token.2',
                  domain: 'other.invalid',
                  path: '/',
                  value: 'fixture-value'
                }
              ]
            }
          : original(method, ...args)
      );
      mock.evaluate.mockResolvedValueOnce({ kind: 'unauthenticated' }).mockResolvedValue(identity);
      const input = {
        sessionJson: JSON.stringify({
          sessionToken: 'a'.repeat(tokenSize),
          user: { id: 'user-fixture', email: 'user@example.com' },
          account: { id: 'account-fixture' }
        })
      };
      const result = runDirectLogin(settings, input, '测试窗口', new AbortController().signal, {
        restore: async () => ({ ownedProfile }),
        progress: vi.fn(),
        code: vi.fn()
      });
      await vi.waitFor(() =>
        expect(mock.command.mock.calls.some(([method]) => method === 'Network.setCookies')).toBe(
          true
        )
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ account_matched: true });
      const deletions = mock.command.mock.calls.filter(
        ([method]) => method === 'Network.deleteCookies'
      );
      expect(deletions.map(([, parameters]) => parameters)).toEqual(
        oldNames.map((name) => ({ name, domain: '.chatgpt.com', path: '/' }))
      );
      const set = mock.command.mock.calls.find(([method]) => method === 'Network.setCookies')![1];
      expect(set.cookies).toHaveLength(chunkCount);
      expect(
        mock.command.mock.calls.findIndex(([method]) => method === 'Network.deleteCookies')
      ).toBeLessThan(
        mock.command.mock.calls.findIndex(([method]) => method === 'Network.setCookies')
      );
      expect(input.sessionJson).toBe('');
    }
  );
  it('错误归属证明在任何窗口操作前停止', async () => {
    const ownedProfile = { ...(await owned()), accountKey: 'f'.repeat(64) };
    await expect(
      runDirectLogin(settings, credential(), '测试窗口', new AbortController().signal, {
        restore: async () => ({ ownedProfile }),
        progress: vi.fn(),
        code: vi.fn()
      })
    ).rejects.toMatchObject({ reason: 'bitbrowser_owned_profile_unverified' });
    expect(mock.post).not.toHaveBeenCalled();
  });
  it.each([
    { status: 401, payload: {} },
    { status: 200, payload: { accessToken: 'fixture-partial' } },
    { status: 200, payload: { access_token: 'fixture-partial' } },
    { status: 200, payload: { account: { id: 'other-account' } } },
    { status: 200, payload: { user: null } }
  ])('会话响应不明确时禁止覆盖原窗口cookie：HTTP$status $payload', async ({ status, payload }) => {
    vi.useFakeTimers();
    const ownedProfile = await owned();
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', { readyState: 'loading', title: 'ChatGPT' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response(JSON.stringify(payload), { status }))
    );
    mock.evaluate.mockImplementation(async (_session, expression: string) =>
      expression.includes('"sessionOnly":true')
        ? inspectLoginPage('inspect', '', { sessionOnly: true })
        : { kind: 'cleared' }
    );
    const result = runDirectLogin(
      settings,
      credential(),
      '测试窗口',
      new AbortController().signal,
      { restore: async () => ({ ownedProfile }), progress: vi.fn(), code: vi.fn() }
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(mock.evaluate).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(121_000);
    expect(await result).toMatchObject({ reason: 'official_login_not_verified' });
    expect(
      mock.command.mock.calls.some(([method]) =>
        ['Network.getCookies', 'Network.deleteCookies', 'Network.setCookies'].includes(method)
      )
    ).toBe(false);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
});

describe('动态代理网络故障有限恢复同一窗口', () => {
  function networkNavigation(errors: string[]) {
    const original = mock.command.getMockImplementation()!;
    let index = 0;
    mock.command.mockImplementation(async (method, ...args) =>
      method === 'Page.navigate' ? { errorText: errors[index++] } : original(method, ...args)
    );
    mock.evaluate.mockResolvedValue(identity);
  }
  const run = (options = settings, signal = new AbortController().signal) =>
    runDirectLogin(options, credential(), '测试窗口', signal, {
      progress: vi.fn(),
      code: vi.fn()
    });

  it('连接中断后关闭、确认退出、提取新IP重开并保留原JSON会话', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED', '']);
    const result = await run();
    expect(result).toMatchObject({
      account_matched: true,
      payment_attempted: false,
      payment_requests_sent: 0
    });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/update')).toHaveLength(1);
    expect(
      mock.post.mock.calls
        .filter(([path]) => path === '/browser/close')
        .map(([path, body]) => [path, body])
    ).toEqual([['/browser/close', { id: 'a'.repeat(32) }]]);
    expect(
      mock.post.mock.calls
        .filter(([path]) => path === '/browser/pids/alive')
        .map(([path, body]) => [path, body])
    ).toEqual([['/browser/pids/alive', { ids: ['a'.repeat(32)] }]]);
    const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
    expect(opened).toHaveLength(2);
    expect(opened[1]![1]).toMatchObject({ id: 'a'.repeat(32), queue: true, extractIp: true });
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
    expect(
      mock.command.mock.calls.filter(([method]) => method === 'Network.setCookies')
    ).toHaveLength(1);
  });

  it('第二次网络失败停止，不继续关闭重开', async () => {
    networkNavigation(['net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_CONNECTION_CLOSED']);
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 1 }
      })
    ).rejects.toThrow('自动恢复已停止');
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(2);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/close')).toHaveLength(1);
    expect(
      mock.evaluate.mock.calls.some(([, expression]) =>
        expression.slice(expression.lastIndexOf(')(') + 2).startsWith('"inspect"')
      )
    ).toBe(false);
  });
  it('连续坏IP最多尝试10次包含首次，所有打开均使用原ID', async () => {
    networkNavigation(Array(10).fill('net::ERR_CONNECTION_CLOSED'));
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 9 }
      })
    ).rejects.toMatchObject({ reason: 'official_login_network_failed' });
    const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
    expect(opened).toHaveLength(10);
    expect(opened.every(([, body]) => body.id === 'a'.repeat(32))).toBe(true);
    expect(opened.slice(1).every(([, body]) => body.extractIp === true)).toBe(true);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/update')).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
  });
  it('真实trace网络失败采用同一尝试额度，HTTP或地区未知不轮换', async () => {
    networkNavigation(['', '']);
    mock.proxy
      .mockResolvedValueOnce({ kind: 'proxy_network_failed' })
      .mockResolvedValueOnce({ kind: 'proxy_ready' });
    expect(await run()).toMatchObject({ account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(2);
    mock.post.mockClear();
    mock.proxy.mockResolvedValue({ kind: 'proxy_unverified' });
    await expect(run()).rejects.toMatchObject({ reason: 'proxy_probe_unverified' });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('整体10分钟先到期便停止，不继续耗尽10次或接受迟到打开结果', async () => {
    vi.useFakeTimers();
    networkNavigation(Array(10).fill('net::ERR_CONNECTION_CLOSED'));
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, ...args) => {
      if (path === '/browser/open') vi.setSystemTime(Date.now() + 70_000);
      return original(path, ...args);
    });
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 9 }
      })
    ).rejects.toMatchObject({ reason: 'bitbrowser_recovery_timeout' });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(9);
    expect(
      mock.command.mock.calls.filter(([method]) => method === 'Browser.getVersion')
    ).toHaveLength(8);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
  });
  it('超出20秒才返回的代理成功不能绕过预检时限，也不误换IP', async () => {
    vi.useFakeTimers();
    networkNavigation(['']);
    mock.proxy.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_001);
      return { kind: 'proxy_ready' };
    });
    await expect(run()).rejects.toMatchObject({ reason: 'proxy_probe_unverified' });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });
  it('trace403保持验证等待，不能凭另一个成功接口交付窗口或换IP', async () => {
    vi.useFakeTimers();
    networkNavigation(['']);
    mock.proxy.mockResolvedValue({ kind: 'manual' });
    const controller = new AbortController();
    const result = run(settings, controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(
      mock.evaluate.mock.calls.some(([, expression]) => expression.includes('"sessionOnly":true'))
    ).toBe(false);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
    controller.abort();
    expect(await result).toMatchObject({ reason: 'bitbrowser_direct_cancelled' });
  });
  it('真人验证等待超过10分钟暂停自动计时，通过后原窗口继续核验', async () => {
    vi.useFakeTimers();
    networkNavigation(['']);
    mock.proxy.mockResolvedValue({ kind: 'manual' });
    let ended = false;
    const result = run().then((value) => {
      ended = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(ended).toBe(false);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
    mock.proxy.mockResolvedValue({ kind: 'proxy_ready' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });

  it.each(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_BLOCKED_BY_CLIENT'])(
    '非受控网络错误不重开：%s',
    async (error) => {
      networkNavigation([error]);
      await expect(run()).rejects.toThrow('未能确认官网账号登录成功');
      expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
    }
  );

  it('固定代理不自动换IP', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    await expect(
      run({ ...settings, browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, proxyMode: 'static' } })
    ).rejects.toThrow('自动恢复已停止');
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('关闭自动会话重试时保留故障窗口', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 0 }
      })
    ).rejects.toThrow('自动恢复已停止');
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });

  it('无法确认进程退出时不重开', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, body) =>
      path === '/browser/pids/alive' ? { data: { foreign: 123 } } : original(path, body)
    );
    await expect(run()).rejects.toThrow('无法确认失败窗口已关闭');
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('关闭失败时不重开', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, body) => {
      if (path === '/browser/close') throw new DirectBrowserError('bitbrowser_direct_rejected');
      return original(path, body);
    });
    await expect(run()).rejects.toThrow('拒绝');
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('关闭请求与PID确认共用15秒，迟到关闭响应不能再轮询或重开', async () => {
    vi.useFakeTimers();
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, ...args) => {
      if (path === '/browser/close') vi.setSystemTime(Date.now() + 15_001);
      return original(path, ...args);
    });
    await expect(run()).rejects.toMatchObject({ reason: 'bitbrowser_profile_close_unverified' });
    expect(
      mock.post.mock.calls.find(([path]) => path === '/browser/close')![2]
    ).toBeLessThanOrEqual(15_000);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/pids/alive')).toBe(false);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });
  it('PID响应迟于共用关闭期限也不能被空PID判定为恢复成功', async () => {
    vi.useFakeTimers();
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, ...args) => {
      if (path === '/browser/close') vi.setSystemTime(Date.now() + 14_000);
      if (path === '/browser/pids/alive') vi.setSystemTime(Date.now() + 1_001);
      return original(path, ...args);
    });
    await expect(run()).rejects.toMatchObject({ reason: 'bitbrowser_profile_close_unverified' });
    expect(
      mock.post.mock.calls.find(([path]) => path === '/browser/pids/alive')![2]
    ).toBeLessThanOrEqual(1000);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('进程一直存活则在关闭确认期限内停止', async () => {
    vi.useFakeTimers();
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, body) =>
      path === '/browser/pids/alive' ? { data: { ['a'.repeat(32)]: 123 } } : original(path, body)
    );
    const pending = run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await pending).toMatchObject({ reason: 'bitbrowser_profile_close_unverified' });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('停止任务后不再打开窗口', async () => {
    networkNavigation(['net::ERR_CONNECTION_CLOSED']);
    const controller = new AbortController();
    const original = mock.post.getMockImplementation()!;
    mock.post.mockImplementation(async (path, body) => {
      const result = await original(path, body);
      if (path === '/browser/close') controller.abort();
      return result;
    });
    await expect(run(settings, controller.signal)).rejects.toThrow();
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('只依据当前官网主文档的网络错误恢复', async () => {
    let inspections = 0;
    mock.evaluate.mockImplementation(async () => {
      if (inspections++ > 0) return identity;
      const handler = mock.onEvent.mock.calls[0]![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'doc',
          type: 'Document',
          frameId: 'main-frame',
          request: { url: 'https://chatgpt.com/' }
        },
        'session'
      );
      handler(
        'Network.loadingFailed',
        { requestId: 'doc', errorText: 'net::ERR_CONNECTION_RESET' },
        'session'
      );
      return { kind: 'loading' };
    });
    expect(await run()).toMatchObject({ account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(2);
  });

  it.each([
    { type: 'Fetch', path: '/api/auth/session' },
    { type: 'Fetch', path: '/api/auth/session?refresh=true&reason=token_expired' },
    { type: 'XHR', path: '/backend-api/accounts/check/v4-2023-04-27' }
  ])('官网关键GET读取明确断网时恢复原profile：$path', async ({ type, path }) => {
    let inspections = 0;
    mock.evaluate.mockImplementation(async () => {
      if (inspections++ > 0) return identity;
      const handler = mock.onEvent.mock.calls[0]![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'identity-read',
          type,
          frameId: 'main-frame',
          request: { method: 'GET', url: `https://chatgpt.com${path}` }
        },
        'session'
      );
      handler(
        'Network.loadingFailed',
        { requestId: 'identity-read', errorText: 'net::ERR_CONNECTION_CLOSED' },
        'session'
      );
      return { kind: 'loading' };
    });
    expect(await run()).toMatchObject({ account_matched: true, payment_requests_sent: 0 });
    const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
    expect(opened).toHaveLength(2);
    expect(opened.every(([, body]) => body.id === 'a'.repeat(32))).toBe(true);
    expect(opened[1]![1]).toMatchObject({ extractIp: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/update')).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
  });

  it.each(['ready', 'command_failed'])(
    '账号控件检查等待期间关键GET明确断网先恢复原profile，不能直接交付：%s',
    async (outcome) => {
      mock.evaluate.mockResolvedValue(identity);
      let checks = 0;
      mock.ui.mockImplementation(async () => {
        if (checks++ === 0) {
          const handler = mock.onEvent.mock.calls[0]![0];
          handler(
            'Network.requestWillBeSent',
            {
              requestId: 'ui-identity-read',
              type: 'Fetch',
              frameId: 'main-frame',
              request: { method: 'GET', url: 'https://chatgpt.com/api/auth/session' }
            },
            'session'
          );
          handler(
            'Network.loadingFailed',
            { requestId: 'ui-identity-read', errorText: 'net::ERR_CONNECTION_RESET' },
            'session'
          );
          if (outcome === 'command_failed')
            throw new DirectBrowserError('bitbrowser_direct_command_failed');
        }
        return { kind: 'page_ready' };
      });
      expect(await run()).toMatchObject({ status: 'session_ready', account_matched: true });
      const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
      expect(opened).toHaveLength(2);
      expect(opened.every(([, body]) => body.id === 'a'.repeat(32))).toBe(true);
      expect(opened[1]![1]).toMatchObject({ extractIp: true });
      expect(mock.post.mock.calls.filter(([path]) => path === '/browser/close')).toHaveLength(1);
      expect(mock.post.mock.calls.filter(([path]) => path === '/browser/update')).toHaveLength(1);
      expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
      expect(mock.ui).toHaveBeenCalledTimes(2);
      expect(
        mock.evaluate.mock.calls.filter(([, expression]) => isInspection(expression))
      ).toHaveLength(2);
    }
  );

  it('账号控件等待期间每次关键GET均断网时共用10次总额度', async () => {
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockImplementation(async () => {
      const handler = mock.onEvent.mock.calls.at(-1)![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'ui-identity-read',
          type: 'XHR',
          frameId: 'main-frame',
          request: {
            method: 'GET',
            url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'
          }
        },
        'session'
      );
      handler(
        'Network.loadingFailed',
        { requestId: 'ui-identity-read', errorText: 'net::ERR_CONNECTION_CLOSED' },
        'session'
      );
      return { kind: 'page_ready' };
    });
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 9 }
      })
    ).rejects.toMatchObject({ reason: 'official_login_network_failed' });
    const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
    expect(opened).toHaveLength(10);
    expect(opened.every(([, body]) => body.id === 'a'.repeat(32))).toBe(true);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/close')).toHaveLength(9);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/delete')).toBe(false);
  });

  it('账号控件等待期间恢复原窗口仍受原600秒总预算约束', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 70_000);
      const handler = mock.onEvent.mock.calls.at(-1)![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'ui-identity-read',
          type: 'Fetch',
          frameId: 'main-frame',
          request: { method: 'GET', url: 'https://chatgpt.com/api/auth/session' }
        },
        'session'
      );
      handler(
        'Network.loadingFailed',
        { requestId: 'ui-identity-read', errorText: 'net::ERR_CONNECTION_RESET' },
        'session'
      );
      return { kind: 'page_ready' };
    });
    await expect(
      run({
        ...settings,
        browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionRetryLimit: 9 }
      })
    ).rejects.toMatchObject({ reason: 'bitbrowser_recovery_timeout' });
    const opened = mock.post.mock.calls.filter(([path]) => path === '/browser/open');
    expect(opened).toHaveLength(9);
    expect(opened.every(([, body]) => body.id === 'a'.repeat(32))).toBe(true);
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/close')).toHaveLength(8);
  });

  it('账号控件显示人工验证时暂停自动预算，不把同期关键GET错误当坏代理', async () => {
    vi.useFakeTimers();
    mock.evaluate.mockResolvedValue(identity);
    mock.ui.mockResolvedValue({ kind: 'manual' });
    let checks = 0;
    mock.ui.mockImplementation(async () => {
      if (checks++ === 0) {
        const handler = mock.onEvent.mock.calls.at(-1)![0];
        handler(
          'Network.requestWillBeSent',
          {
            requestId: 'ui-identity-read',
            type: 'Fetch',
            frameId: 'main-frame',
            request: { method: 'GET', url: 'https://chatgpt.com/api/auth/session' }
          },
          'session'
        );
        handler(
          'Network.loadingFailed',
          { requestId: 'ui-identity-read', errorText: 'net::ERR_CONNECTION_RESET' },
          'session'
        );
      }
      return { kind: 'manual' };
    });
    let finished = false;
    const result = run().then((value) => {
      finished = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(finished).toBe(false);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
    mock.ui.mockResolvedValue({ kind: 'page_ready' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it.each([
    {
      method: 'POST',
      url: 'https://chatgpt.com/api/auth/session',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'http://chatgpt.com/api/auth/session',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com:444/api/auth/session',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://other.invalid/api/auth/session',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com/api/auth/session',
      type: 'Script',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com/backend-api/me',
      type: 'XHR',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com/asset.js',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com/api/auth/session',
      type: 'Fetch',
      frameId: 'child-frame',
      session: 'session'
    },
    {
      method: 'GET',
      url: 'https://chatgpt.com/api/auth/session',
      type: 'Fetch',
      frameId: 'main-frame',
      session: 'other-session'
    }
  ])('非授权关键读取的资源失败不换IP：$method $url $type $frameId $session', async (request) => {
    mock.evaluate.mockImplementation(async () => {
      const handler = mock.onEvent.mock.calls[0]![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'unrelated',
          type: request.type,
          frameId: request.frameId,
          request: { method: request.method, url: request.url }
        },
        request.session
      );
      handler(
        'Network.loadingFailed',
        { requestId: 'unrelated', errorText: 'net::ERR_CONNECTION_RESET' },
        request.session
      );
      return identity;
    });
    expect(await run()).toMatchObject({ account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
    expect(mock.post.mock.calls.some(([path]) => path === '/browser/close')).toBe(false);
  });

  it.each([
    { errorText: 'net::ERR_ABORTED' },
    { errorText: 'net::ERR_FAILED' },
    { errorText: 'net::ERR_CONNECTION_CLOSED', canceled: true },
    { errorText: 'net::ERR_CONNECTION_CLOSED', blockedReason: 'inspector' },
    { errorText: 'net::ERR_CONNECTION_CLOSED', corsErrorStatus: { corsError: 'DisallowedByMode' } }
  ])('读取被取消、跨域或拦截不冒充坏代理：$errorText', async (failure) => {
    mock.evaluate.mockImplementation(async () => {
      const handler = mock.onEvent.mock.calls[0]![0];
      handler(
        'Network.requestWillBeSent',
        {
          requestId: 'identity-read',
          type: 'Fetch',
          frameId: 'main-frame',
          request: { method: 'GET', url: 'https://chatgpt.com/api/auth/session' }
        },
        'session'
      );
      handler('Network.loadingFailed', { requestId: 'identity-read', ...failure }, 'session');
      return identity;
    });
    expect(await run()).toMatchObject({ account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
  });

  it('无关页面、子框架和资源错误不换IP', async () => {
    mock.evaluate.mockImplementation(async () => {
      const handler = mock.onEvent.mock.calls[0]![0];
      for (const [requestId, sessionId, type, frameId, url] of [
        ['foreign', 'other-session', 'Document', 'main-frame', 'https://chatgpt.com/'],
        ['frame', 'session', 'Document', 'child-frame', 'https://chatgpt.com/'],
        ['asset', 'session', 'Script', 'main-frame', 'https://chatgpt.com/asset.js'],
        ['workbench', 'session', 'Document', 'main-frame', 'https://console.bitbrowser.net/']
      ]) {
        handler(
          'Network.requestWillBeSent',
          { requestId, type, frameId, request: { url } },
          sessionId
        );
        handler(
          'Network.loadingFailed',
          { requestId, errorText: 'net::ERR_CONNECTION_CLOSED' },
          sessionId
        );
      }
      return identity;
    });
    expect(await run()).toMatchObject({ account_matched: true });
    expect(mock.post.mock.calls.filter(([path]) => path === '/browser/open')).toHaveLength(1);
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

describe('等待2FA时持续核对官网与任务截止', () => {
  it('有效期充足的自动2FA只填写并提交一次，再核实同一官网身份', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'identity']);
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      {
        progress: vi.fn(),
        code: vi.fn().mockResolvedValue({
          token: '123456',
          expiresAt: new Date(Date.now() + 30_000).toISOString()
        })
      }
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ status: 'session_ready', account_matched: true });
    expect(actions.filter((action) => action === 'code')).toHaveLength(1);
    expect(actions.filter((action) => action === 'submit')).toHaveLength(1);
  });
  it('临时取码期间挑战改为邮箱时丢弃迟到TOTP，不在后续挑战重新填写', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'manual', 'code', 'identity']);
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.evaluate.mockImplementation(async (...args) => {
      const state = await evaluate(...args);
      return state.kind === 'manual' ? { ...state, codeType: 'email' } : state;
    });
    const pending = pendingCode();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      { progress: vi.fn(), code: pending.code }
    );
    await vi.advanceTimersByTimeAsync(1000);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'code' || action === 'submit')).toHaveLength(0);
    expect(pending.code).toHaveBeenCalledOnce();
  });
  it('已接收的自动2FA临近过期时不填写或提交，保留原窗口人工核验', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'identity']);
    const progress = vi.fn();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      {
        progress,
        code: vi.fn().mockResolvedValue({
          token: '123456',
          expiresAt: new Date(Date.now() + 2000).toISOString()
        })
      }
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'code' || action === 'submit')).toHaveLength(0);
    expect(progress).toHaveBeenCalledWith('verification_required', { user_action_required: true });
  });
  it('填写自动2FA期间有效期耗尽时清空输入，点击前再次拒绝过期码', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'identity']);
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.evaluate.mockImplementation(async (...args) => {
      const state = await evaluate(...args);
      if (actions.at(-1) === 'code') vi.setSystemTime(Date.now() + 5000);
      return state;
    });
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      {
        progress: vi.fn(),
        code: vi.fn().mockResolvedValue({
          token: '123456',
          expiresAt: new Date(Date.now() + 6000).toISOString()
        })
      }
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'code')).toHaveLength(1);
    expect(actions.filter((action) => action === 'submit')).toHaveLength(0);
    expect(actions.filter((action) => action === 'clear').length).toBeGreaterThan(0);
  });
  it('取码尚未完成时继续观察，码到达后只提交一次', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'code', 'identity']);
    const pending = pendingCode();
    const progress = vi.fn();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      { progress, code: pending.code }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(actions.filter((action) => action === 'code')).toHaveLength(0);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'submit')).toHaveLength(1);
    expect(pending.code).toHaveBeenCalledOnce();
    expect(progress.mock.calls.filter(([stage]) => stage === 'login_code_required')).toHaveLength(
      1
    );
    expect(progress.mock.calls.filter(([stage]) => stage === 'login_code_submitted')).toHaveLength(
      1
    );
  });

  it.each(['resolve', 'reject'] as const)(
    '原窗口人工完成登录后识别身份，迟到取码%s不提交或覆盖成功',
    async (completion) => {
      vi.useFakeTimers();
      const actions = automaticLogin(['code', 'identity']);
      const pending = pendingCode();
      const progress = vi.fn();
      const input = { login: { email: 'user@example.com', password: 'fixture-password' } };
      const result = runDirectLogin(settings, input, '测试窗口', new AbortController().signal, {
        progress,
        code: pending.code
      });
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await result;
      expect(outcome).toMatchObject({ status: 'session_ready', account_matched: true });
      pending[completion]();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await result).toBe(outcome);
      expect(actions.filter((action) => action === 'inspect')).toHaveLength(2);
      expect(actions.filter((action) => action === 'code' || action === 'submit')).toHaveLength(0);
      expect(pending.code).toHaveBeenCalledOnce();
      expect(progress.mock.calls.some(([stage]) => stage === 'login_code_submitted')).toBe(false);
      expect(mock.close).toHaveBeenCalledOnce();
      expect(input.login.password).toBe('');
    }
  );

  it.each(['resolve', 'reject'] as const)(
    '无输入时暂停自动恢复预算并保留30分钟人工等待，迟到取码%s不再提交',
    async (completion) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const actions = automaticLogin(['code']);
      const pending = pendingCode();
      const progress = vi.fn();
      const input = { login: { email: 'user@example.com', password: 'fixture-password' } };
      const result = runDirectLogin(
        {
          ...settings,
          browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, sessionWaitMinutes: 1 }
        },
        input,
        '测试窗口',
        new AbortController().signal,
        { progress, code: pending.code }
      );
      const failed = expect(result).rejects.toThrow('未能确认官网账号登录成功');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(
        progress.mock.calls.filter(([stage]) => stage === 'verification_required')
      ).toHaveLength(1);
      expect(actions.filter((action) => action === 'inspect').length).toBeGreaterThan(1);
      expect(pending.code).toHaveBeenCalledOnce();
      vi.setSystemTime(startedAt + 30 * 60_000);
      await vi.advanceTimersByTimeAsync(1000);
      await failed;
      pending[completion]();
      await vi.advanceTimersByTimeAsync(5000);
      expect(actions.filter((action) => action === 'code' || action === 'submit')).toHaveLength(0);
      expect(progress.mock.calls.some(([stage]) => stage === 'login_code_submitted')).toBe(false);
      expect(mock.close).toHaveBeenCalledOnce();
      expect(input.login.password).toBe('');
    }
  );

  it.each(['resolve', 'reject'] as const)(
    '等待2FA期间可立即取消，迟到取码%s不恢复执行',
    async (completion) => {
      vi.useFakeTimers();
      const actions = automaticLogin(['code']);
      const pending = pendingCode();
      const controller = new AbortController();
      const result = runDirectLogin(
        settings,
        { login: { email: 'user@example.com', password: 'fixture-password' } },
        '测试窗口',
        controller.signal,
        { progress: vi.fn(), code: pending.code }
      );
      const cancelled = expect(result).rejects.toThrow('已停止');
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await cancelled;
      pending[completion]();
      await vi.advanceTimersByTimeAsync(5000);
      expect(actions.filter((action) => action === 'code' || action === 'submit')).toHaveLength(0);
      expect(pending.code).toHaveBeenCalledOnce();
      expect(mock.close).toHaveBeenCalledOnce();
    }
  );

  it('取码等待中出现官网挑战，完成后继续原验证码步骤且不再次取码', async () => {
    vi.useFakeTimers();
    const actions = automaticLogin(['code', 'manual', 'code', 'identity']);
    const pending = pendingCode();
    const progress = vi.fn();
    const result = runDirectLogin(
      settings,
      { login: { email: 'user@example.com', password: 'fixture-password' } },
      '测试窗口',
      new AbortController().signal,
      { progress, code: pending.code }
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(progress).toHaveBeenCalledWith('verification_required', { user_action_required: true });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).status).toBe('session_ready');
    expect(actions.filter((action) => action === 'submit')).toHaveLength(1);
    expect(pending.code).toHaveBeenCalledOnce();
  });
});
