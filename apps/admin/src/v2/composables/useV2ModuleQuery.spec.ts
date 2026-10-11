import { createRenderer, h, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import {
  clearV2QueryCache,
  createV2QueryKey,
  fetchV2Query,
  getV2QueryData,
  invalidateV2Queries,
  primeV2Query,
  useV2ModuleQuery
} from './useV2Query';

type TestNode = { children: TestNode[]; parent: TestNode | null };
const node = (): TestNode => ({ children: [], parent: null });
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: () => undefined,
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent)
      child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (child) => child.parent,
  nextSibling: () => null
});
afterEach(() => {
  clearV2QueryCache();
  vi.useRealTimers();
});

function mountModuleQuery<T>(options: Parameters<typeof useV2ModuleQuery<T>>[0]) {
  let query!: ReturnType<typeof useV2ModuleQuery<T>>;
  const app = renderer.createApp({
    setup() {
      query = useV2ModuleQuery({ ...options, trackRouteData: false });
      return () => h('div');
    }
  });
  app.mount(node());
  return { app, query };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it('shares module-aware prime, get and fetch while preserving independent reference caches', async () => {
  const key = 'shared-parameters';
  primeV2Query({ scope: 'auto-recharge', key, data: 'reference' });
  primeV2Query({ moduleKey: 'bank-recharge-cards', scope: 'auto-recharge', key, data: 'cards' });
  const readNames = vi.fn(async () => 'names');
  await fetchV2Query({
    moduleKey: 'auto-recharge-names',
    scope: 'auto-recharge',
    key,
    query: readNames
  });
  const readCachedNames = vi.fn(async () => 'unexpected-network');
  const names = mountModuleQuery({
    moduleKey: 'auto-recharge-names',
    scope: 'auto-recharge',
    key,
    query: readCachedNames
  });
  try {
    await names.query.ensureFresh();
    expect(names.query.data.value).toBe('names');
    expect(readCachedNames).not.toHaveBeenCalled();
    expect(getV2QueryData('auto-recharge', key)).toBe('reference');
    expect(getV2QueryData('auto-recharge', key, { moduleKey: 'bank-recharge-cards' })).toBe(
      'cards'
    );
    expect(getV2QueryData('auto-recharge', key, { moduleKey: 'auto-recharge-names' })).toBe(
      'names'
    );
    primeV2Query({
      moduleKey: 'auto-recharge-names',
      scope: 'auto-recharge',
      key,
      data: 'updated-names'
    });
    expect(names.query.data.value).toBe('updated-names');
    expect(getV2QueryData('auto-recharge', key)).toBe('reference');
    expect(readNames).toHaveBeenCalledTimes(1);
  } finally {
    names.app.unmount();
  }
});

it('refreshes both modules on a shared scope event without invalidating an unrelated scope', async () => {
  vi.useFakeTimers();
  let cardsVersion = 0,
    namesVersion = 0;
  const readCards = vi.fn(async () => `cards-${++cardsVersion}`);
  const readNames = vi.fn(async () => `names-${++namesVersion}`);
  const cards = mountModuleQuery({
    moduleKey: 'bank-recharge-cards',
    scope: 'auto-recharge',
    key: 'page-1',
    query: readCards
  });
  const names = mountModuleQuery({
    moduleKey: 'auto-recharge-names',
    scope: 'auto-recharge',
    key: 'page-1',
    query: readNames
  });
  try {
    await Promise.all([cards.query.ensureFresh(), names.query.ensureFresh()]);
    primeV2Query({ moduleKey: 'customers', scope: 'customers', key: 'page-1', data: 'unrelated' });
    invalidateV2Queries('auto-recharge');
    await vi.advanceTimersByTimeAsync(100);
    expect(readCards).toHaveBeenCalledTimes(2);
    expect(readNames).toHaveBeenCalledTimes(2);
    expect(cards.query.data.value).toBe('cards-2');
    expect(names.query.data.value).toBe('names-2');
    expect(getV2QueryData('customers', 'page-1', { moduleKey: 'customers' })).toBe('unrelated');
  } finally {
    cards.app.unmount();
    names.app.unmount();
  }
});

it('clears both module caches on identity change and rejects previous-identity late responses', async () => {
  const cardsRead = deferred<string>(),
    namesRead = deferred<string>();
  const readCards = vi.fn(() => cardsRead.promise),
    readNames = vi.fn(() => namesRead.promise);
  const key = 'identity-race';
  const cards = mountModuleQuery({
    moduleKey: 'bank-recharge-cards',
    scope: 'auto-recharge',
    key,
    query: readCards
  });
  const names = mountModuleQuery({
    moduleKey: 'auto-recharge-names',
    scope: 'auto-recharge',
    key,
    query: readNames
  });
  try {
    const waits = [cards.query.ensureFresh(), names.query.ensureFresh()];
    await vi.waitFor(() => expect(readNames).toHaveBeenCalledTimes(1));
    sessionCoordinator.clearLocalSession({ reason: 'identity-switched' });
    expect(cards.query.data.value).toBeUndefined();
    expect(names.query.data.value).toBeUndefined();
    primeV2Query({
      moduleKey: 'bank-recharge-cards',
      scope: 'auto-recharge',
      key,
      data: 'current-cards'
    });
    primeV2Query({
      moduleKey: 'auto-recharge-names',
      scope: 'auto-recharge',
      key,
      data: 'current-names'
    });
    namesRead.resolve('old-names');
    cardsRead.resolve('old-cards');
    await Promise.all(waits);
    expect(cards.query.data.value).toBe('current-cards');
    expect(names.query.data.value).toBe('current-names');
    expect(getV2QueryData('auto-recharge', key, { moduleKey: 'auto-recharge-names' })).toBe(
      'current-names'
    );
  } finally {
    cards.app.unmount();
    names.app.unmount();
    cardsRead.resolve('old-cards');
    namesRead.resolve('old-names');
  }
});

it('reads names independently after bank cards cache the same filters and pagination', async () => {
  const key = createV2QueryKey({ page: 1, pageSize: 20, keyword: '', status: '' });
  const cards = mountModuleQuery({
    moduleKey: 'bank-recharge-cards',
    scope: 'auto-recharge',
    key,
    query: async () => ({ items: [{ last4: '8000', status: 'disabled' }], total: 7 })
  });
  const readNames = vi.fn(async () => ({
    items: [{ sequence: 1, name: '合成姓名' }],
    total: 1000
  }));
  let names: ReturnType<typeof mountModuleQuery<Awaited<ReturnType<typeof readNames>>>> | undefined;
  try {
    await cards.query.ensureFresh();
    names = mountModuleQuery({
      moduleKey: 'auto-recharge-names',
      scope: 'auto-recharge',
      key,
      query: readNames
    });
    await names.query.ensureFresh();
    expect(readNames).toHaveBeenCalledTimes(1);
    expect(names.query.data.value).toEqual({
      items: [{ sequence: 1, name: '合成姓名' }],
      total: 1000
    });
    expect(cards.query.data.value?.total).toBe(7);
    expect(names.query.requestedKey.value).toBe(key);
    expect(names.query.displayedKey.value).toBe(key);
  } finally {
    names?.app.unmount();
    cards.app.unmount();
  }
});

it('does not deduplicate in-flight reads across modules with identical keys', async () => {
  const cardsRead = deferred<string>(),
    namesRead = deferred<string>();
  const readCards = vi.fn(() => cardsRead.promise),
    readNames = vi.fn(() => namesRead.promise);
  const cards = mountModuleQuery({
    moduleKey: 'bank-recharge-cards',
    scope: 'auto-recharge',
    key: 'same',
    query: readCards
  });
  const names = mountModuleQuery({
    moduleKey: 'auto-recharge-names',
    scope: 'auto-recharge',
    key: 'same',
    query: readNames
  });
  try {
    await vi.waitFor(() => expect(readCards).toHaveBeenCalledTimes(1));
    expect(readNames).toHaveBeenCalledTimes(1);
    namesRead.resolve('names');
    await names.query.ensureFresh();
    expect(names.query.data.value).toBe('names');
    expect(cards.query.data.value).toBeUndefined();
    cardsRead.resolve('cards');
    await cards.query.ensureFresh();
    expect(cards.query.data.value).toBe('cards');
    expect(names.query.data.value).toBe('names');
  } finally {
    cards.app.unmount();
    names.app.unmount();
    cardsRead.resolve('cards');
    namesRead.resolve('names');
  }
});

it('keeps same-module request sharing when one consumer unmounts', async () => {
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const read = vi.fn((context: { signal: AbortSignal }) => {
    signal = context.signal;
    return pending.promise;
  });
  const options = {
    moduleKey: 'auto-recharge-names' as const,
    scope: 'auto-recharge' as const,
    key: 'same',
    query: read
  };
  const first = mountModuleQuery(options),
    second = mountModuleQuery(options);
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    first.app.unmount();
    expect(signal.aborted).toBe(false);
    pending.resolve('names');
    await second.query.ensureFresh();
    expect(second.query.data.value).toBe('names');
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    second.app.unmount();
    pending.resolve('names');
  }
});

it('refreshes the bank order expiry list at its deadline without a scope event', async () => {
  vi.useFakeTimers();
  const start = Date.parse('2026-10-05T00:00:00Z');
  const expiresAt = start + 1000;
  vi.setSystemTime(start);
  const read = vi.fn(async () => ({
    items: Date.now() >= expiresAt ? ['expired-order'] : [],
    revalidateAt: Date.now() >= expiresAt ? start + 60_000 : expiresAt
  }));
  type ExpiryList = Awaited<ReturnType<typeof read>>;
  let result!: ReturnType<typeof useV2ModuleQuery<ExpiryList>>;
  const app = renderer.createApp({
    setup() {
      result = useV2ModuleQuery({
        moduleKey: 'bank-recharge-orders',
        scope: 'auto-recharge',
        key: 'expired-orders',
        trackRouteData: false,
        getRevalidateAt: (data) => data.revalidateAt,
        query: read
      });
      return () => h('div');
    }
  });
  app.mount(node());
  try {
    await result.ensureFresh();
    expect(result.data.value?.items).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.data.value?.items).toEqual(['expired-order']);
  } finally {
    app.unmount();
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(read).toHaveBeenCalledTimes(2);
});

it('reloads mounted module filters and pagination without clearing successful content', async () => {
  const key = ref('all:1');
  const enabled = ref(true);
  let rejectNext!: (error: Error) => void;
  const pending = new Promise<string>((_, reject) => {
    rejectNext = reject;
  });
  const read = vi.fn(async () => (key.value === 'filtered:2' ? pending : key.value));
  let result!: ReturnType<typeof useV2ModuleQuery<string>>;
  const app = renderer.createApp({
    setup() {
      result = useV2ModuleQuery({
        moduleKey: 'auto-recharge-addresses',
        scope: 'auto-recharge',
        trackRouteData: false,
        key: () => key.value,
        enabled: () => enabled.value,
        query: read
      });
      return () => h('div');
    }
  });
  app.mount(node());
  try {
    await vi.waitFor(() => expect(result.data.value).toBe('all:1'));
    key.value = 'filtered:2';
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(result.data.value).toBe('all:1');
    expect(result.phase.value).toBe('transitioning');
    rejectNext(new Error('read failed'));
    await vi.waitFor(() => expect(result.phase.value).toBe('refresh-error'));
    expect(result.data.value).toBe('all:1');
    key.value = 'filtered:3';
    await vi.waitFor(() => expect(result.data.value).toBe('filtered:3'));
    enabled.value = false;
    key.value = 'disabled:4';
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    app.unmount();
  }
});
