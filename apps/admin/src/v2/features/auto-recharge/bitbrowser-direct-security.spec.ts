import { afterEach, describe, expect, it, vi } from 'vitest';
import { directBrowserApi } from './bitbrowser-direct-api';
afterEach(() => vi.unstubAllGlobals());
describe('比特网页安全连接前置核验', () => {
  it('非安全公网HTTP上下文先阻止，不发任何本机请求', () => {
    vi.stubGlobal('isSecureContext', false);
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    expect(() =>
      directBrowserApi('http://127.0.0.1:54345', 'synthetic-pairing', new AbortController().signal)
    ).toThrow('HTTPS');
    expect(request).not.toHaveBeenCalled();
  });
  it('浏览器确认安全的HTTPS或localhost上下文允许继续本机接口检测', async () => {
    vi.stubGlobal('isSecureContext', true);
    const request = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ success: true, data: {} })
    });
    vi.stubGlobal('fetch', request);
    await directBrowserApi(
      'http://127.0.0.1:54345',
      'synthetic-pairing',
      new AbortController().signal
    ).post('/health');
    expect(request).toHaveBeenCalledOnce();
  });
});
