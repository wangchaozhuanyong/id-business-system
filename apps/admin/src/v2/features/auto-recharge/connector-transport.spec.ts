import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorRequest, requireConnectorHealth } from './connector-transport';

const health = {
  ok: true,
  service: 'id-business-v2-auto-recharge-connector',
  version: 4,
  role: 'recharge',
  originAllowed: true,
  busy: false,
  capabilities: [
    'manual-payment-confirmation',
    'recharge-process-isolation',
    'browser-catalog',
    'browser-options',
    'browser-profile-v2',
    'session-load-retry',
    'same-profile-proxy-recovery',
    'json-page-ready',
    'same-window-page-refresh',
    'payment-unknown-resolution',
    'prepayment-page-recovery',
    'stale-owned-profile-cleanup',
    'password-login',
    'login-code'
  ]
};
afterEach(() => vi.unstubAllGlobals());

describe('本机连接错误识别', () => {
  it('浏览器拦截与网络不可达保留可操作提示，不断言连接器没启动', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(connectorRequest('http://127.0.0.1:55321', '/health')).rejects.toMatchObject({
      code: 'unreachable'
    });
  });
  it.each([
    [403, 'connector_origin_not_allowed', 'origin'],
    [403, 'connector_token_invalid', 'credentials'],
    [409, 'bitbrowser_local_api_unavailable', 'bitbrowser'],
    [409, 'another_local_job_is_running', 'busy'],
    [409, 'unknown-fixture-secret', 'rejected'],
    [409, 'login_code_expired', 'codeExpired'],
    [404, undefined, 'missing']
  ])('状态 %s 与原因 %s 显示受控说明', async (status, reason, code) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ok: false, reason }), { status: status as number })
        )
    );
    await expect(
      connectorRequest('http://127.0.0.1:55321', '/browser/catalog')
    ).rejects.toMatchObject({ code });
  });
  it('空数据和网页响应不能冒充就绪的连接器', async () => {
    for (const body of ['null', '[]', '<html>wrong service</html>']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      await expect(connectorRequest('http://127.0.0.1:55321', '/health')).rejects.toMatchObject({
        code: 'protocol'
      });
    }
  });
  it('旧助手拒绝验证码期限时提示更新，不删除期限重新发送', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: false, reason: 'invalid_login_code' }), { status: 409 })
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      connectorRequest('http://127.0.0.1:55321', '/jobs/job-fixture/code', {
        body: { code: '123456', expiresAt: new Date(Date.now() + 30_000).toISOString() }
      })
    ).rejects.toMatchObject({
      code: 'codeExpiryUnsupported',
      message: expect.stringContaining('更新本机助手')
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toHaveProperty('expiresAt');
  });
  it('区分旧连接器、来源未允许和占用状态', () => {
    expect(requireConnectorHealth(health)).toBe(health);
    expect(() => requireConnectorHealth({ ...health, version: 3 })).toThrow('版本过旧');
    expect(() => requireConnectorHealth({ ...health, role: 'registration' })).toThrow('版本过旧');
    expect(() => requireConnectorHealth({ ok: true, version: 1 })).toThrow('版本过旧');
    expect(() => requireConnectorHealth({ ...health, originAllowed: false })).toThrow('网站来源');
    expect(() => requireConnectorHealth({ ...health, busy: true })).toThrow('任务未结束');
    expect(() => requireConnectorHealth({ ...health, capabilities: [] })).toThrow('版本过旧');
    expect(() =>
      requireConnectorHealth({ ...health, capabilities: ['browser-catalog', 'browser-options'] })
    ).toThrow('版本过旧');
  });
  it.each(['same-profile-proxy-recovery', 'json-page-ready'])(
    '缺少%s能力时拒绝旧助手，不能回退到删除窗口逻辑',
    (capability) => {
      expect(() =>
        requireConnectorHealth({
          ...health,
          capabilities: health.capabilities.filter((item) => item !== capability)
        })
      ).toThrow('版本过旧');
    }
  );
  it('取消检测不会报成服务不可达', async () => {
    const control = new AbortController();
    control.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    await expect(
      connectorRequest('http://127.0.0.1:55321', '/health', { signal: control.signal })
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
