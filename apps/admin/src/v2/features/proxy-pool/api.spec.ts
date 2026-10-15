import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  invalidate: vi.fn((promise: Promise<unknown>, scopes: unknown) => {
    void scopes;
    return promise;
  })
}));
vi.mock('@/api/client', () => ({ http: fixtures, request: (promise: unknown) => promise }));
vi.mock('@/v2/composables/useV2Query', () => ({ withV2QueryInvalidation: fixtures.invalidate }));
import { proxyPoolApi, rechargeProxyApi, readActiveRechargeProxies } from './api';
import { protocolForProxyLink } from './options';
beforeEach(() => vi.clearAllMocks());
describe('shared proxy pool transport', () => {
  it('keeps missing metadata visible to managers while excluding it from Bit choices', async () => {
    fixtures.get.mockResolvedValue({ items: [], total: 0 });
    await proxyPoolApi.list({ page: 1, pageSize: 20 });
    expect(fixtures.get).toHaveBeenLastCalledWith(
      '/id-business-v2/proxy-pool',
      expect.objectContaining({ params: { page: 1, pageSize: 20 } })
    );
    await rechargeProxyApi.list({ page: 1, pageSize: 100, status: 'active' });
    expect(fixtures.get).toHaveBeenLastCalledWith(
      '/id-business-v2/proxy-pool',
      expect.objectContaining({ params: expect.objectContaining({ completeOnly: 'true' }) })
    );
  });
  it('loads all available pages and terminates on an empty page', async () => {
    fixtures.get
      .mockResolvedValueOnce({ items: [{ id: 'one' }], total: 2 })
      .mockResolvedValueOnce({ items: [{ id: 'two' }], total: 2 });
    expect((await readActiveRechargeProxies()).items.map((row) => row.id)).toEqual(['one', 'two']);
    expect(fixtures.get).toHaveBeenCalledTimes(2);
    fixtures.get.mockResolvedValueOnce({ items: [], total: 10 });
    expect((await readActiveRechargeProxies()).items).toEqual([]);
  });
  it('invalidates both recharge consumers and marks canonical detection references', async () => {
    fixtures.patch.mockResolvedValue({ id: 'proxy' });
    fixtures.post.mockResolvedValue({ tasks: [] });
    await proxyPoolApi.update('proxy', { remark: 'updated' });
    expect(fixtures.invalidate).toHaveBeenCalledWith(expect.anything(), [
      'auto-recharge',
      'online-recharge'
    ]);
    await proxyPoolApi.test('proxy');
    expect(fixtures.post).toHaveBeenLastCalledWith(
      '/id-business-v2/online-recharge/admin/proxies/test',
      { id: 'proxy', proxyPoolReference: true }
    );
  });
  it('preserves mixed direct protocols while keeping extraction protocol independent', () => {
    expect(protocolForProxyLink('socks5://gateway.example.test:1080', 'direct', 'http')).toBe(
      'socks5'
    );
    expect(protocolForProxyLink('https://gateway.example.test:443', 'direct', 'http')).toBe(
      'https'
    );
    expect(
      protocolForProxyLink('https://gateway.example.test/extract', 'extraction', 'socks5')
    ).toBe('socks5');
    expect(() => protocolForProxyLink('ftp://gateway.example.test', 'direct', 'http')).toThrow(
      '协议'
    );
  });
  it('reads only latest proxy detection tasks with cancellation and server deadlines', async () => {
    const signal = new AbortController().signal;
    fixtures.get
      .mockResolvedValueOnce({
        items: [{ id: 'one' }],
        total: 2,
        revalidateAt: '2026-10-15T00:00:03Z'
      })
      .mockResolvedValueOnce({ items: [{ id: 'two' }], total: 2, revalidateAt: null });
    expect(await proxyPoolApi.testTasks(['proxy-one', 'proxy-two'], { signal })).toEqual({
      items: [{ id: 'one' }, { id: 'two' }],
      revalidateAt: '2026-10-15T00:00:03Z'
    });
    expect(fixtures.get).toHaveBeenLastCalledWith('/id-business-v2/online-recharge/admin/jobs', {
      params: {
        operation: 'proxy_test',
        proxyIds: 'proxy-one,proxy-two',
        latestPerProxy: 'true',
        page: 2,
        pageSize: 100
      },
      signal
    });
  });
  it('keeps visible proxies alongside a full tracked batch without exceeding server ID limits', async () => {
    fixtures.get.mockResolvedValue({ items: [], total: 0, revalidateAt: null });
    const ids = Array.from({ length: 600 }, (_, index) => `proxy-${index}`);
    await proxyPoolApi.testTasks(ids);
    const calls = fixtures.get.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].params.proxyIds.split(',')).toHaveLength(500);
    expect(calls[1][1].params.proxyIds.split(',')).toHaveLength(100);
    expect(calls[1][1].params.proxyIds).toContain('proxy-599');
  });
});
