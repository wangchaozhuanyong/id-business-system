import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  directBrowserApi,
  directBrowserCatalog,
  directProfileOptions,
  localBrowserUrl
} from './bitbrowser-direct-api';
import { isLoginPaymentWrite, parseDirectCredential } from './bitbrowser-direct-login';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
describe('网页直连比特浏览器的输入和读取边界', () => {
  it('只允许当前电脑的接口和窗口控制地址，不接受外部地址或凭据 URL', () => {
    expect(localBrowserUrl('http://127.0.0.1:54345')).toBe('http://127.0.0.1:54345');
    expect(localBrowserUrl('ws://localhost:9222/devtools/browser/abc-123', true)).toContain(
      'localhost'
    );
    for (const url of [
      'https://example.com',
      'http://192.168.1.1:54345',
      'http://key@localhost:54345',
      'http://localhost:54345/other'
    ])
      expect(() => localBrowserUrl(url)).toThrow();
    for (const url of [
      'ws://example.com:9222/devtools/browser/123',
      'ws://localhost:9222/path',
      'ws://localhost:9222/devtools/browser/abc?token=x'
    ])
      expect(() => localBrowserUrl(url, true)).toThrow();
  });
  it('直接读取接口、分组和标签，分页读取且不调用本机连接器', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            success: true,
            data: url.endsWith('/group/list')
              ? { list: [{ id: 'group-id-1', groupName: '分组' }] }
              : url.endsWith('/browserTag/list')
                ? [{ id: 'a'.repeat(32), tagName: '标签' }]
                : {}
          }),
          { status: 200 }
        );
      })
    );
    expect(
      await directBrowserCatalog('http://127.0.0.1:54345', 'fixture-only-api-key', signal())
    ).toEqual({
      groups: [{ id: 'group-id-1', name: '分组' }],
      tags: [{ id: 'a'.repeat(32), name: '标签' }]
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => url.startsWith('http://127.0.0.1:54345/'))).toBe(true);
  });
  it('重复编号、接口拒绝和网络不可达使用受控错误，不回显任意接口消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, msg: 'fixture-sensitive-response' }), {
          status: 403
        })
      )
    );
    await expect(
      directBrowserApi('http://localhost:54345', 'fixture-only-api-key', signal()).post('/health')
    ).rejects.toThrow('密钥不匹配');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fixture-sensitive-response')));
    await expect(
      directBrowserApi('http://localhost:54345', 'fixture-only-api-key', signal()).post('/health')
    ).rejects.toThrow('无法访问比特浏览器');
  });
  it('创建窗口始终关闭登录态同步，保留已有代理和指纹设置', () => {
    const result = directProfileOptions({
      localApiUrl: 'http://localhost:54345',
      localApiToken: 'fixture',
      groupName: '组',
      tagName: '标签',
      proxyType: 'http',
      dynamicProxyUrl: 'https://example.invalid/proxy'
    });
    expect(result).toMatchObject({
      syncCookies: false,
      syncLocalStorage: false,
      syncTabs: false,
      syncIndexedDb: false,
      syncAuthorization: false,
      proxyMethod: 3
    });
  });
  it('自定义窗口指纹时区按所选地区计算偏移，不使用业务显示时区', () => {
    const result = directProfileOptions({
      localApiUrl: 'http://localhost:54345',
      localApiToken: 'fixture',
      groupName: '组',
      tagName: '标签',
      proxyType: 'http',
      dynamicProxyUrl: '',
      browserOptions: {
        ...V2_RECHARGE_BROWSER_DEFAULTS,
        timezoneFromIp: false,
        timezone: 'Asia/Tokyo'
      }
    });
    expect(result.browserFingerPrint).toMatchObject({
      timeZone: 'Asia/Tokyo',
      timeZoneOffset: 32400
    });
  });
  it('授权 JSON 必须绑定目标用户与账号，冲突或缺失会话资料时拒绝', () => {
    const data = {
      user: { email: 'user@example.com', id: 'user-1' },
      account: { id: 'account-1' },
      sessionToken: 'fixture-session'
    };
    expect(parseDirectCredential({ sessionJson: JSON.stringify(data) })).toMatchObject({
      userId: 'user-1',
      accountId: 'account-1'
    });
    for (const value of [
      { user: { email: 'user@example.com' } },
      { ...data, session_token: 'other-session' },
      { ...data, sessionToken: 'cookie; attr' }
    ])
      expect(() => parseDirectCredential({ sessionJson: JSON.stringify(value) })).toThrow(
        '授权 JSON'
      );
  });
  it('仅登录窗口阻止付款写请求，不拦截官网会话读取或登录提交', () => {
    expect(isLoginPaymentWrite('POST', 'https://chatgpt.com/backend-api/payments/checkout')).toBe(
      true
    );
    expect(isLoginPaymentWrite('POST', 'https://api.stripe.com/v1/payment_intents')).toBe(true);
    expect(isLoginPaymentWrite('GET', 'https://chatgpt.com/api/auth/session')).toBe(false);
    expect(isLoginPaymentWrite('POST', 'https://auth.openai.com/login')).toBe(false);
  });
});
