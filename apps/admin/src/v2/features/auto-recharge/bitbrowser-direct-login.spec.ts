import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectBrowserError } from './bitbrowser-direct-api';
import { runDirectLogin } from './bitbrowser-direct-login';

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
    method === 'Target.getTargets'
      ? { targetInfos: [{ type: 'page', targetId: 'page', url: 'about:blank' }] }
      : method === 'Target.attachToTarget'
        ? { sessionId: 'session' }
        : {}
  );
});
afterEach(() => {
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
