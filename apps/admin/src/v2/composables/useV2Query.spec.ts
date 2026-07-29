import { effectScope, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyAuthIdentityChanged } from '@/auth/session';
import {
  clearV2QueryCache,
  createV2QueryKey,
  fetchV2Query,
  getV2QueryData,
  invalidateV2Queries,
  primeV2Query,
  useV2Query
} from './useV2Query';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  clearV2QueryCache();
});

describe('V2 query cache', () => {
  it('creates a stable key independent of object field order and undefined values', () => {
    expect(createV2QueryKey({ page: 1, keyword: undefined, filters: { b: 2, a: 1 } })).toBe(
      createV2QueryKey({ filters: { a: 1, b: 2 }, page: 1 })
    );
  });

  it('deduplicates concurrent requests for the same identity, scope and key', async () => {
    const deferred = createDeferred<{ items: string[] }>();
    const query = vi.fn(() => deferred.promise);
    const options = {
      scope: 'orders',
      key: 'page-1',
      tier: 'critical' as const,
      query
    };

    const first = fetchV2Query(options);
    const second = fetchV2Query(options);
    await Promise.resolve();

    expect(query).toHaveBeenCalledTimes(1);
    deferred.resolve({ items: ['order-1'] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { items: ['order-1'] },
      { items: ['order-1'] }
    ]);
  });

  it('keeps the last successful payload while a new key loads or fails', async () => {
    const scope = effectScope();
    const key = ref('page-1');
    const nextPage = createDeferred<{ items: string[] }>();
    const query = vi.fn(({ signal }: { signal: AbortSignal }) => {
      if (key.value === 'page-1') return Promise.resolve({ items: ['order-1'] });
      signal.addEventListener('abort', () => undefined);
      return nextPage.promise;
    });
    const result = scope.run(() =>
      useV2Query({
        scope: 'orders',
        key: () => key.value,
        tier: 'critical',
        query,
        keepPreviousData: true
      })
    );
    expect(result).toBeDefined();
    if (!result) return;

    await result.ensureFresh();
    expect(result.data.value).toEqual({ items: ['order-1'] });

    key.value = 'page-2';
    const pending = result.ensureFresh();
    expect(result.data.value).toEqual({ items: ['order-1'] });
    expect(result.isPlaceholderData.value).toBe(true);
    expect(result.isRefreshing.value).toBe(true);

    nextPage.reject(new Error('network failed'));
    await pending;
    expect(result.data.value).toEqual({ items: ['order-1'] });
    expect(result.hasCurrentData.value).toBe(false);
    expect(result.error.value).toBeInstanceOf(Error);
    scope.stop();
  });

  it('does not let an invalidated in-flight read overwrite the cache after a write', async () => {
    const deferred = createDeferred<string>();
    const pending = fetchV2Query({
      scope: 'renewals',
      key: 'page-1',
      tier: 'critical',
      query: () => deferred.promise
    });
    await Promise.resolve();

    invalidateV2Queries('renewals');
    deferred.resolve('stale-result');
    await expect(pending).resolves.toBe('stale-result');
    expect(getV2QueryData('renewals', 'page-1')).toBeUndefined();

    await expect(
      fetchV2Query({
        scope: 'renewals',
        key: 'page-1',
        tier: 'critical',
        query: async () => 'fresh-result'
      })
    ).resolves.toBe('fresh-result');
    expect(getV2QueryData('renewals', 'page-1')).toBe('fresh-result');
  });

  it('does not expose invalidated reference data as a reusable cache hit', () => {
    primeV2Query({
      scope: 'orders-options',
      key: 'selectors',
      data: ['service-a']
    });
    invalidateV2Queries('orders-options');

    expect(getV2QueryData('orders-options', 'selectors')).toBeUndefined();
    expect(
      getV2QueryData('orders-options', 'selectors', {
        includeInvalidated: true
      })
    ).toEqual(['service-a']);
  });

  it('hydrates a remounted consumer synchronously without showing initial loading', () => {
    primeV2Query({
      scope: 'customers',
      key: 'page-1',
      data: { items: ['cached-customer'] }
    });
    const query = vi.fn(async () => ({ items: ['network-customer'] }));
    const scope = effectScope();
    const result = scope.run(() =>
      useV2Query({
        scope: 'customers',
        key: 'page-1',
        tier: 'operational',
        query
      })
    );

    expect(result?.data.value).toEqual({ items: ['cached-customer'] });
    expect(result?.hasCurrentData.value).toBe(true);
    expect(result?.isInitialLoading.value).toBe(false);
    expect(query).not.toHaveBeenCalled();
    scope.stop();
  });

  it('never reuses cached data after the authenticated identity changes', () => {
    primeV2Query({
      scope: 'orders',
      key: 'page-1',
      data: { items: ['private-order'] }
    });
    expect(getV2QueryData('orders', 'page-1')).toEqual({ items: ['private-order'] });

    notifyAuthIdentityChanged('identity-switched');

    expect(getV2QueryData('orders', 'page-1')).toBeUndefined();
  });
});
