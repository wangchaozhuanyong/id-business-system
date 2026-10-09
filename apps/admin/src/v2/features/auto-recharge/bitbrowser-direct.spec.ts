import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  directBrowserApi,
  directBrowserCatalog,
  directProfileOptions,
  localBrowserUrl
} from './bitbrowser-direct-api';
import { isLoginPaymentWrite, parseDirectCredential } from './bitbrowser-direct-login';
import {
  inspectLoginPage,
  inspectLoggedInPage,
  inspectOfficialProxy
} from './bitbrowser-login-page';

const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
describe('直连验证码只用于明确的身份验证器挑战', () => {
  function challenge(path: string, text: string) {
    const click = vi.fn();
    const form = {
      innerText: text,
      checkValidity: () => true,
      querySelectorAll: (selector: string) =>
        selector.includes('button')
          ? [{ form, click, getClientRects: () => [{}], getAttribute: () => null }]
          : []
    };
    class Input {
      private text = '';
      form = form;
      get value() {
        return this.text;
      }
      set value(value: string) {
        this.text = value;
      }
      getClientRects = () => [{}];
      dispatchEvent = vi.fn();
      focus = vi.fn();
    }
    const input = new Input();
    vi.stubGlobal('HTMLInputElement', Input);
    vi.stubGlobal('location', {
      protocol: 'https:',
      hostname: 'auth.openai.com',
      pathname: path
    });
    vi.stubGlobal('document', {
      readyState: 'complete',
      title: 'Log in',
      querySelectorAll: (selector: string) => (selector.includes('one-time-code') ? [input] : [])
    });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    return { input, form, click };
  }
  it.each([
    ['/u/mfa-otp-challenge', 'Enter a code'],
    ['/u/challenge', 'Use your authenticator app'],
    ['/u/challenge', '请输入身份验证应用的验证码']
  ])('明确 TOTP 挑战可以获取、填入并提交当前验证码：%s', async (path, text) => {
    const { input, click } = challenge(path, text);
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'code' });
    expect(await inspectLoginPage('code', '123456')).toEqual({ kind: 'filled' });
    expect(input.value).toBe('123456');
    expect(await inspectLoginPage('submit', '123456', { stage: 'code' })).toEqual({
      kind: 'submitted'
    });
    expect(click).toHaveBeenCalledOnce();
  });
  it.each([
    ['/u/email-verification', 'Check your inbox', 'email'],
    ['/u/challenge', 'Enter the code sent to your email', 'email'],
    ['/u/challenge', '验证码发送到邮箱', 'email'],
    ['/u/mfa-otp-challenge', 'SMS sent to your phone number', 'sms'],
    ['/u/mfa-otp-challenge', 'Check your email for a code', 'email'],
    ['/u/challenge', 'Enter verification code', 'unknown']
  ])('邮箱、短信及不明确挑战保留原窗口人工处理：%s %s', async (path, text, codeType) => {
    const { input, click } = challenge(path, text);
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'manual', codeType });
    expect(await inspectLoginPage('code', '123456')).toEqual({ kind: 'manual', codeType });
    expect(await inspectLoginPage('submit', '123456', { stage: 'code' })).toEqual({
      kind: 'manual',
      codeType
    });
    expect(input.value).toBe('');
    expect(input.dispatchEvent).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
  it('已填入后页面改为邮箱挑战时不点击提交', async () => {
    const { form, click } = challenge('/u/mfa-otp-challenge', 'Use your authenticator app');
    expect(await inspectLoginPage('code', '123456')).toEqual({ kind: 'filled' });
    form.innerText = 'Enter the code sent to your email';
    expect(await inspectLoginPage('submit', '123456', { stage: 'code' })).toEqual({
      kind: 'manual',
      codeType: 'email'
    });
    expect(click).not.toHaveBeenCalled();
  });
});
describe('官网已登录页面与真实代理的独立证据', () => {
  function official(controls: object[] = [], title = 'ChatGPT') {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', { readyState: 'loading', title, querySelectorAll: () => controls });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
  }
  function control(visible = true, disabled = false) {
    return {
      getClientRects: () => (visible ? [{}] : []),
      matches: (selector: string) => (selector.includes(':disabled') ? disabled : true)
    };
  }
  it('观察到的多个个人资料菜单均可作为正向登录态，资源未完成不阻塞', () => {
    official([control(), control()]);
    expect(inspectLoggedInPage()).toEqual({ kind: 'page_ready' });
  });
  it.each([{ controls: [] }, { controls: [control(false)] }, { controls: [control(true, true)] }])(
    '没有可用账号控件不能交付窗口',
    ({ controls }) => {
      official(controls);
      expect(inspectLoggedInPage()).toEqual({ kind: 'page_loading' });
    }
  );
  it('真人验证优先于旧账号控件，且不读取代理', async () => {
    official([control()], 'Just a moment');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(inspectLoggedInPage()).toEqual({ kind: 'manual' });
    expect(await inspectOfficialProxy(20_000)).toEqual({ kind: 'manual' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('在原页面通过代理读取官网trace，只返回分类并核对地区', async () => {
    official();
    const fetch = vi.fn().mockImplementation(async () => new Response('ip=8.8.8.8\nloc=PH\n'));
    vi.stubGlobal('fetch', fetch);
    expect(await inspectOfficialProxy(20_000, 'PH')).toEqual({ kind: 'proxy_ready' });
    expect(await inspectOfficialProxy(20_000, 'US')).toEqual({ kind: 'proxy_unverified' });
    expect(fetch.mock.calls[0]).toEqual([
      '/cdn-cgi/trace',
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
    ]);
  });
  it.each(['ip=127.0.0.1\nloc=PH\n', 'ip=999.1.1.1\nloc=PH\n', 'ip=8.8.8.8\n', 'ip=::1\nloc=PH\n'])(
    '缺少有效公网出口证据不判为可用',
    async (trace) => {
      official();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(trace)));
      expect(await inspectOfficialProxy(20_000)).toEqual({ kind: 'proxy_unverified' });
    }
  );
  it('官网拒绝与网络失败分别归类，授权或验证错误不冒充坏IP', async () => {
    official();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockRejectedValueOnce(new TypeError('fixture-network'));
    vi.stubGlobal('fetch', fetch);
    expect(await inspectOfficialProxy(20_000)).toEqual({ kind: 'manual' });
    expect(await inspectOfficialProxy(20_000)).toEqual({ kind: 'proxy_network_failed' });
  });
});
describe('网页直连比特浏览器的输入和读取边界', () => {
  it('页面加载中不提前核验空会话，真正的人工验证页继续等待', async () => {
    vi.stubGlobal('location', {
      protocol: 'https:',
      hostname: 'chatgpt.com',
      href: 'https://chatgpt.com/'
    });
    const document = { readyState: 'loading', title: 'Just a moment' };
    vi.stubGlobal('document', document);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'loading' });
    document.readyState = 'complete';
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'manual' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([200, 401])('已加载的官网明确没有登录会话时返回失效状态：%s', async (status) => {
    vi.stubGlobal('location', {
      protocol: 'https:',
      hostname: 'chatgpt.com',
      href: 'https://chatgpt.com/'
    });
    vi.stubGlobal('document', {
      readyState: 'complete',
      title: 'ChatGPT',
      querySelectorAll: () => []
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'unauthenticated' });
  });
  it('已接受会话但返回过期令牌时不继续请求套餐，也不回显令牌', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', {
      readyState: 'complete',
      title: 'ChatGPT',
      querySelectorAll: () => []
    });
    const claims = btoa(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) - 60,
        'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' }
      })
    );
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 'fixture-user', email: 'user@example.com' },
          accessToken: `fixture.${claims}.signature`
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLoginPage('inspect')).toEqual({ kind: 'expired' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('JSON只读核验在资源仍加载时读取有效会话和官方套餐，不依赖表单DOM', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    const query = vi.fn(() => {
      throw new Error('JSON verification must not inspect forms');
    });
    vi.stubGlobal('document', { readyState: 'loading', title: 'ChatGPT', querySelectorAll: query });
    const claims = btoa(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' }
      })
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: 'fixture-user', email: 'user@example.com' },
            accessToken: `fixture.${claims}.signature`
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accounts: {
              'fixture-account': { account: { account_id: 'fixture-account', plan_type: 'free' } }
            }
          })
        )
      );
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLoginPage('inspect', '', { sessionOnly: true })).toEqual({
      kind: 'identity',
      email: 'user@example.com',
      userId: 'fixture-user',
      accountId: 'fixture-account',
      plan: 'free'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
    expect(await inspectLoginPage('password', 'fixture', { sessionOnly: true })).toEqual({
      kind: 'loading'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('JSON核验仍停在官网真人验证页，不提前请求会话', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', { readyState: 'loading', title: 'Just a moment' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLoginPage('inspect', '', { sessionOnly: true })).toEqual({
      kind: 'manual'
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('显式刷新只走官网GET，刷新错误不算已登录也不继续请求套餐', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', { readyState: 'loading', title: 'ChatGPT' });
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'RefreshAccessTokenError' })));
    vi.stubGlobal('fetch', fetch);
    expect(
      await inspectLoginPage('inspect', '', { sessionOnly: true, refreshSession: true })
    ).toEqual({ kind: 'expired', refreshFailed: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(
      '/api/auth/session?refresh=true&reason=token_expired&method=GET&path=%2Fapi%2Fauth%2Fsession'
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({ credentials: 'include', cache: 'no-store' });
    expect(fetch.mock.calls[0]![1].method).toBeUndefined();
    expect(fetch.mock.calls[0]![1].body).toBeUndefined();
  });
  it('官网返回其他会话错误也不能凭用户字段核验成功', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'chatgpt.com' });
    vi.stubGlobal('document', { readyState: 'loading', title: 'ChatGPT' });
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'fixture_error',
          user: { id: 'fixture-user' },
          accessToken: 'fixture'
        })
      )
    );
    vi.stubGlobal('fetch', fetch);
    expect(await inspectLoginPage('inspect', '', { sessionOnly: true })).toEqual({
      kind: 'session_error'
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
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
