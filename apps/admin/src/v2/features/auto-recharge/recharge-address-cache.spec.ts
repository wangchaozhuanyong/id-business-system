import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearV2QueryCache, fetchV2Query } from '@/v2/composables/useV2Query';
import { rechargeApi } from './api';

const mock = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock('@/api/client', () => ({
  http: { post: mock.write, patch: mock.write },
  request: (result: Promise<unknown>) => result
}));
vi.mock('./connector-transport', () => ({
  connectorRequest: vi.fn(),
  requireConnectorHealth: vi.fn()
}));
beforeEach(() => mock.write.mockResolvedValue({ ok: true }));
afterEach(() => {
  clearV2QueryCache();
  vi.resetAllMocks();
});

const operations = {
  generate: () => rechargeApi.generateAddresses(1),
  import: () => rechargeApi.importAddresses(['Synthetic Street']),
  status: () => rechargeApi.updateAddressStatus('synthetic-address', 'used'),
  finished: () =>
    rechargeApi.directBrowserCallback('synthetic-job', 'synthetic-token', { type: 'finished' })
};
it.each(Object.keys(operations) as (keyof typeof operations)[])(
  '%s 成功后再次进入充值页会读取新地址，失败不使已验证内容失效',
  async (operation) => {
    const query = vi.fn(async () => ['synthetic-unused-address']);
    const options = { scope: 'auto-recharge' as const, key: 'address-cache-fixture', query };
    await fetchV2Query(options);
    await fetchV2Query(options);
    expect(query).toHaveBeenCalledTimes(1);
    mock.write.mockRejectedValueOnce(new Error('synthetic-write-failed'));
    await expect(operations[operation]()).rejects.toThrow('synthetic-write-failed');
    await fetchV2Query(options);
    expect(query).toHaveBeenCalledTimes(1);
    await operations[operation]();
    await fetchV2Query(options);
    expect(query).toHaveBeenCalledTimes(2);
  }
);

it('普通执行进度不会反复刷新地址与执行中的账单表单', async () => {
  const query = vi.fn(async () => ['synthetic-unused-address']);
  const options = { scope: 'auto-recharge' as const, key: 'address-cache-fixture', query };
  await fetchV2Query(options);
  await rechargeApi.directBrowserCallback('synthetic-job', 'synthetic-token', { type: 'progress' });
  await fetchV2Query(options);
  expect(query).toHaveBeenCalledTimes(1);
});
