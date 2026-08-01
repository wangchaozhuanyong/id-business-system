import { effectScope, type EffectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearV2QueryCache, invalidateV2Queries } from '@/v2/composables/useV2Query';
import { idBusinessV2OrdersApi } from './api';
import type { V2OrderEntryOptions } from './contracts';
import {
  getVisibleOrderEntryCustomers,
  preserveSelectedOrderEntryCustomer,
  useOrderEntryOptionsQuery
} from './useOrderEntryOptionsQuery';

vi.mock('@/api/client', () => ({
  getApiErrorMessage: (error: unknown) => (error instanceof Error ? error.message : '请求失败')
}));

vi.mock('./api', () => ({
  idBusinessV2OrdersApi: {
    getEntryOptions: vi.fn()
  }
}));

const getEntryOptionsMock = vi.mocked(idBusinessV2OrdersApi.getEntryOptions);
const activeScopes: EffectScope[] = [];

function createOptions(label: string): V2OrderEntryOptions {
  return {
    customers: [
      {
        id: label,
        name: label,
        wechat: null,
        qq: null,
        maskedPhone: null,
        maskedWhatsapp: null
      }
    ],
    countries: [],
    settlementPlatforms: [],
    latestFxRates: []
  };
}

function createManualQuery() {
  const scope = effectScope();
  activeScopes.push(scope);
  const query = scope.run(() =>
    useOrderEntryOptionsQuery({
      mode: 'manual',
      freshnessPolicy: 'event-driven'
    })
  );
  if (!query) throw new Error('订单录入选项查询初始化失败');
  return query;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const scope of activeScopes.splice(0)) scope.stop();
  clearV2QueryCache();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useOrderEntryOptionsQuery', () => {
  it('新关键词请求期间隐藏旧结果，只保留当前已选客户', () => {
    const customers = [
      ...createOptions('selected-customer').customers,
      ...createOptions('stale-result').customers
    ];

    expect(getVisibleOrderEntryCustomers(customers, 'selected-customer', true)).toEqual([
      customers[0]
    ]);
    expect(getVisibleOrderEntryCustomers(customers, '', true)).toEqual([]);
    expect(getVisibleOrderEntryCustomers(customers, '', false)).toBe(customers);
  });

  it.each(['订单创建', '订单编辑'])('%s切换关键词时保留当前已选客户', () => {
    const selectedCustomer = createOptions('selected-customer').customers[0];
    const searched = createOptions('search-result');

    const result = preserveSelectedOrderEntryCustomer(searched, selectedCustomer);

    expect(result.customers.map((customer) => customer.id)).toEqual([
      'selected-customer',
      'search-result'
    ]);
    expect(preserveSelectedOrderEntryCustomer(result, selectedCustomer)).toBe(result);
  });

  it('首次加载一次，重复相同关键词直接复用缓存', async () => {
    const initial = createOptions('initial');
    getEntryOptionsMock.mockResolvedValue(initial);
    const query = createManualQuery();

    await query.loadOptions();
    await query.loadOptions('   ');

    expect(getEntryOptionsMock).toHaveBeenCalledTimes(1);
    expect(getEntryOptionsMock).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal)
    });
    expect(query.data.value).toEqual(initial);
    expect(query.resolved.value).toBe(true);
  });

  it('新关键词只请求一次，切回已缓存关键词不再请求', async () => {
    const initial = createOptions('initial');
    const searched = createOptions('customer-a');
    getEntryOptionsMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(searched);
    const query = createManualQuery();

    await query.loadOptions();
    await query.searchCustomers('  customer-a  ');
    await query.searchCustomers('customer-a');
    await query.loadOptions('');

    expect(getEntryOptionsMock).toHaveBeenCalledTimes(2);
    expect(getEntryOptionsMock.mock.calls.map(([keyword]) => keyword)).toEqual([
      undefined,
      'customer-a'
    ]);
    expect(query.customerKeyword.value).toBe('');
    expect(query.data.value).toEqual(initial);
  });

  it('新关键词等待响应时标记为占位数据，避免展示上一关键词结果', async () => {
    const initial = createOptions('initial');
    const searched = createOptions('searched');
    const deferred = createDeferred<V2OrderEntryOptions>();
    getEntryOptionsMock.mockResolvedValueOnce(initial).mockReturnValueOnce(deferred.promise);
    const query = createManualQuery();
    await query.loadOptions();

    const searchRequest = query.searchCustomers('new-keyword');

    expect(query.customerOptionsPending.value).toBe(true);
    expect(query.data.value).toEqual(initial);

    deferred.resolve(searched);
    await searchRequest;

    expect(query.customerOptionsPending.value).toBe(false);
    expect(query.data.value).toEqual(searched);
  });

  it('显式重试会强制刷新当前关键词', async () => {
    const initial = createOptions('before-retry');
    const refreshed = createOptions('after-retry');
    getEntryOptionsMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    const query = createManualQuery();

    await query.loadOptions('customer-a');
    await query.retryOptions();

    expect(getEntryOptionsMock).toHaveBeenCalledTimes(2);
    expect(getEntryOptionsMock.mock.calls.map(([keyword]) => keyword)).toEqual([
      'customer-a',
      'customer-a'
    ]);
    expect(query.data.value).toEqual(refreshed);
  });

  it('scope 失效后只刷新一次，刷新期间保留旧数据', async () => {
    vi.useFakeTimers();
    const initial = createOptions('before-invalidation');
    const refreshed = createOptions('after-invalidation');
    const deferred = createDeferred<V2OrderEntryOptions>();
    getEntryOptionsMock.mockResolvedValueOnce(initial).mockReturnValueOnce(deferred.promise);
    const query = createManualQuery();
    await query.loadOptions();

    invalidateV2Queries('order-entry-options');
    invalidateV2Queries('order-entry-options');
    await vi.advanceTimersByTimeAsync(100);

    expect(getEntryOptionsMock).toHaveBeenCalledTimes(2);
    expect(query.loading.value).toBe(true);
    expect(query.resolved.value).toBe(true);
    expect(query.data.value).toEqual(initial);

    deferred.resolve(refreshed);
    await vi.advanceTimersByTimeAsync(0);

    expect(query.loading.value).toBe(false);
    expect(query.data.value).toEqual(refreshed);
  });

  it('新关键词请求失败时保留旧数据并返回中文错误', async () => {
    const initial = createOptions('last-success');
    getEntryOptionsMock
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('客户资料加载失败'));
    const query = createManualQuery();
    await query.loadOptions();

    await query.searchCustomers('failed-keyword');

    expect(getEntryOptionsMock).toHaveBeenCalledTimes(2);
    expect(query.data.value).toEqual(initial);
    expect(query.resolved.value).toBe(true);
    expect(query.loading.value).toBe(false);
    expect(query.error.value).toBe('客户资料加载失败');
  });
});
