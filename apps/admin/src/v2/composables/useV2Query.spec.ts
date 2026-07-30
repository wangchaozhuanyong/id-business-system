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
  vi.useRealTimers();
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
      scope: 'orders' as const,
      key: 'page-1',
      freshnessPolicy: 'event-driven' as const,
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
        freshnessPolicy: 'event-driven',
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

  it('clears only the canceled consumer loading state while a shared request continues', async () => {
    const deferred = createDeferred<{ items: string[] }>();
    const query = vi.fn(() => deferred.promise);
    const firstScope = effectScope();
    const secondScope = effectScope();
    const options = {
      scope: 'order-entry-matching' as const,
      key: 'candidate-page',
      freshnessPolicy: 'event-driven' as const,
      query
    };
    const first = firstScope.run(() => useV2Query(options));
    const second = secondScope.run(() => useV2Query(options));
    if (!first || !second) return;

    const firstPending = first.ensureFresh();
    const secondPending = second.ensureFresh();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(1);
    expect(first.isInitialLoading.value).toBe(true);
    expect(second.isInitialLoading.value).toBe(true);

    first.cancel();
    expect(first.isInitialLoading.value).toBe(false);
    expect(first.isRefreshing.value).toBe(false);
    expect(second.isInitialLoading.value).toBe(true);

    deferred.resolve({ items: ['candidate-1'] });
    await Promise.all([firstPending, secondPending]);
    expect(first.isInitialLoading.value).toBe(false);
    expect(second.data.value).toEqual({ items: ['candidate-1'] });
    expect(second.isInitialLoading.value).toBe(false);
    firstScope.stop();
    secondScope.stop();
  });

  it('does not let an invalidated in-flight read overwrite the cache after a write', async () => {
    const deferred = createDeferred<string>();
    const pending = fetchV2Query({
      scope: 'renewals',
      key: 'page-1',
      freshnessPolicy: 'event-driven',
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
        freshnessPolicy: 'event-driven',
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
        freshnessPolicy: 'event-driven',
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

  it('keeps a clean cache hit indefinitely instead of expiring after the old TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
    const query = vi.fn(async () => ({ items: ['order-1'] }));
    const options = {
      scope: 'orders' as const,
      key: 'page-1',
      freshnessPolicy: 'event-driven' as const,
      query
    };

    await fetchV2Query(options);
    vi.setSystemTime(new Date('2026-07-29T01:00:00.000Z'));
    await fetchV2Query(options);

    expect(query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('refreshes an active invalidated scope but only marks an inactive scope dirty', async () => {
    vi.useFakeTimers();
    const activeQuery = vi.fn(async () => ({ items: ['active'] }));
    const inactiveQuery = vi.fn(async () => ({ items: ['inactive'] }));
    const scope = effectScope();
    const active = scope.run(() =>
      useV2Query({
        scope: 'orders',
        key: 'active',
        freshnessPolicy: 'event-driven',
        query: activeQuery
      })
    );
    await active?.ensureFresh();
    await fetchV2Query({
      scope: 'customers',
      key: 'inactive',
      freshnessPolicy: 'event-driven',
      query: inactiveQuery
    });

    invalidateV2Queries(['orders', 'customers']);
    await vi.advanceTimersByTimeAsync(100);

    expect(activeQuery).toHaveBeenCalledTimes(2);
    expect(inactiveQuery).toHaveBeenCalledTimes(1);

    await fetchV2Query({
      scope: 'customers',
      key: 'inactive',
      freshnessPolicy: 'event-driven',
      query: inactiveQuery
    });
    expect(inactiveQuery).toHaveBeenCalledTimes(2);
    scope.stop();
    vi.useRealTimers();
  });

  it('invalidates an active deadline query only when revalidateAt arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T00:00:00.000Z'));
    const query = vi.fn(async () => ({
      items: ['renewal'],
      revalidateAt: new Date(Date.now() + 1_000).toISOString()
    }));
    const scope = effectScope();
    const result = scope.run(() =>
      useV2Query({
        scope: 'renewals',
        key: 'deadline',
        freshnessPolicy: 'event-with-deadline',
        getRevalidateAt: (data) => data.revalidateAt,
        query
      })
    );
    await result?.ensureFresh();

    await vi.advanceTimersByTimeAsync(999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);

    scope.stop();
    vi.useRealTimers();
  });

  it('keeps stale data after a refresh failure without entering an automatic retry loop', async () => {
    vi.useFakeTimers();
    primeV2Query({
      scope: 'orders',
      key: 'failed-refresh',
      data: { items: ['last-success'] }
    });
    const query = vi.fn(async () => {
      throw new Error('network failed');
    });
    const scope = effectScope();
    const result = scope.run(() =>
      useV2Query({
        scope: 'orders',
        key: 'failed-refresh',
        freshnessPolicy: 'event-driven',
        query
      })
    );

    invalidateV2Queries('orders');
    await vi.advanceTimersByTimeAsync(500);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result?.data.value).toEqual({ items: ['last-success'] });
    expect(result?.error.value).toBeInstanceOf(Error);
    scope.stop();
    vi.useRealTimers();
  });
});
