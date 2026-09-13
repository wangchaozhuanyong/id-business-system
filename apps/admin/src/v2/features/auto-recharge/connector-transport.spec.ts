import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorRequest, requireConnectorHealth } from './connector-transport';

const health = {
  ok: true,
  service: 'id-business-v2-auto-recharge-connector',
  version: 2,
  originAllowed: true,
  busy: false,
  capabilities: [
    'browser-catalog',
    'browser-options',
    'session-load-retry',
    'payment-unknown-resolution'
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
  it('区分旧连接器、来源未允许和占用状态', () => {
    expect(requireConnectorHealth(health)).toBe(health);
    expect(() => requireConnectorHealth({ ok: true, version: 1 })).toThrow('版本过旧');
    expect(() => requireConnectorHealth({ ...health, originAllowed: false })).toThrow('网站来源');
    expect(() => requireConnectorHealth({ ...health, busy: true })).toThrow('任务未结束');
    expect(() => requireConnectorHealth({ ...health, capabilities: [] })).toThrow('版本过旧');
    expect(() =>
      requireConnectorHealth({ ...health, capabilities: ['browser-catalog', 'browser-options'] })
    ).toThrow('版本过旧');
  });
  it('取消检测不会报成服务不可达', async () => {
    const control = new AbortController();
    control.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    await expect(
      connectorRequest('http://127.0.0.1:55321', '/health', { signal: control.signal })
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});
