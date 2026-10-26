import { afterEach, describe, expect, it, vi } from 'vitest';
import { directBrowserApi, directBrowserFailure } from './bitbrowser-direct-api';

afterEach(() => vi.unstubAllGlobals());
describe('比特 HTTP200 业务拒绝的受控原因', () => {
  it.each([
    ['请先登录比特浏览器', 'local_api_login_required', '尚未登录'],
    ['登录状态已过期', 'local_api_login_required', '尚未登录'],
    ['permission denied', 'local_api_permission_denied', '无权读取'],
    ['当前账号权限不足', 'local_api_permission_denied', '无权读取'],
    ['unknown private response', undefined, '未返回成功结果']
  ])('将 %s 映射为安全说明，不回显原始响应', async (msg, reason, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              msg: msg + ' PRIVATE-SUFFIX'
            }),
            { status: 200 }
          )
      )
    );
    let failure: unknown;
    try {
      await directBrowserApi(
        'http://127.0.0.1:54345',
        'synthetic-key',
        new AbortController().signal
      ).post('/group/list');
    } catch (error) {
      failure = error;
    }
    const safe = directBrowserFailure(failure);
    expect(safe.reason).toBe('bitbrowser_direct_rejected');
    expect(safe.metadata.httpStatus).toBe(200);
    expect(safe.metadata.apiReason).toBe(reason);
    expect(safe.message).toContain(expected);
    expect(safe.message).not.toContain('PRIVATE-SUFFIX');
  });
});
