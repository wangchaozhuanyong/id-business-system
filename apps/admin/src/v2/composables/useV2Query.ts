import {
  computed,
  onActivated,
  onMounted,
  onScopeDispose,
  reactive,
  readonly,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref
} from 'vue';
import { getAuthIdentityEpoch } from '@/auth/session';
import { markV2RouteDataError, markV2RouteDataReady } from '@/runtime/performance';
import { abortAllV2Requests } from '@/v2/api/requestControl';
import { getV2ModuleDefinition, type V2ModuleKey } from '@/v2/config/modules';
import type { V2QueryTier } from '@/v2/features/feature';

export type { V2QueryTier } from '@/v2/features/feature';

export interface V2QueryContext {
  signal: AbortSignal;
}

export interface UseV2QueryOptions<T> {
  scope: string;
  key: string | (() => string);
  tier: V2QueryTier;
  query: (context: V2QueryContext) => Promise<T>;
  keepPreviousData?: boolean;
}

export interface PrimeV2QueryOptions<T> {
  scope: string;
  key: string | (() => string);
  data: T;
  updatedAt?: number;
}

export interface UseV2QueryResult<T> {
  data: Ref<T | undefined>;
  hasData: ComputedRef<boolean>;
  hasCurrentData: ComputedRef<boolean>;
  isPlaceholderData: ComputedRef<boolean>;
  isInitialLoading: Ref<boolean>;
  isRefreshing: Ref<boolean>;
  error: Ref<unknown>;
  refreshedAt: Ref<number | null>;
  ensureFresh: () => Promise<T | undefined>;
  refresh: () => Promise<T | undefined>;
  cancel: () => void;
}

type V2QueryListener = (reason?: 'clear') => void;

interface V2QueryEntry<T = unknown> {
  scope: string;
  data?: T;
  hasData: boolean;
  updatedAt: number;
  invalidated: boolean;
  revision: number;
  status: 'idle' | 'pending';
  error: unknown;
  inFlight?: Promise<T>;
  controller?: AbortController;
  listeners: Set<V2QueryListener>;
}

const TIER_FRESHNESS_MS: Record<V2QueryTier, number> = {
  critical: 15_000,
  operational: 60_000,
  reference: 5 * 60_000,
  live: 30_000
};

const queryCache = new Map<string, V2QueryEntry>();
let cacheIdentityEpoch = getAuthIdentityEpoch();
const mutableV2QueryActivity = reactive({
  refreshingCount: 0,
  lastErrorAt: null as number | null,
  refreshedAt: null as number | null
});
export const v2QueryActivity = readonly(mutableV2QueryActivity);

export function createV2QueryKey(value: unknown) {
  return JSON.stringify(normalizeQueryKeyValue(value));
}

function normalizeQueryKeyValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeQueryKeyValue(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeQueryKeyValue(item)])
  );
}

function ensureCacheIdentity() {
  const currentIdentityEpoch = getAuthIdentityEpoch();
  if (currentIdentityEpoch === cacheIdentityEpoch) return;
  resetQueryCache(currentIdentityEpoch);
}

function resolveKey(scope: string, key: string | (() => string)) {
  ensureCacheIdentity();
  const value = typeof key === 'function' ? key() : key;
  return `${cacheIdentityEpoch}:${scope}:${value}`;
}

function getEntry<T>(cacheKey: string, scope: string) {
  const existing = queryCache.get(cacheKey) as V2QueryEntry<T> | undefined;
  if (existing) return existing;

  const entry: V2QueryEntry<T> = {
    scope,
    hasData: false,
    updatedAt: 0,
    invalidated: false,
    revision: 0,
    status: 'idle',
    error: null,
    listeners: new Set()
  };
  queryCache.set(cacheKey, entry);
  return entry;
}

function notify(entry: V2QueryEntry, reason?: 'clear') {
  for (const listener of entry.listeners) listener(reason);
}

function isFresh(entry: V2QueryEntry, tier: V2QueryTier) {
  return (
    entry.hasData && !entry.invalidated && Date.now() - entry.updatedAt < TIER_FRESHNESS_MS[tier]
  );
}

function isCurrentRequest<T>(
  cacheKey: string,
  entry: V2QueryEntry<T>,
  revision: number,
  controller: AbortController
) {
  return (
    !controller.signal.aborted &&
    cacheIdentityEpoch === getAuthIdentityEpoch() &&
    queryCache.get(cacheKey) === entry &&
    entry.revision === revision
  );
}

function startRequest<T>(
  cacheKey: string,
  entry: V2QueryEntry<T>,
  query: UseV2QueryOptions<T>['query']
) {
  const controller = new AbortController();
  const requestRevision = entry.revision;
  entry.controller = controller;
  entry.status = 'pending';
  entry.error = null;
  const backgroundActivity = entry.hasData;
  if (backgroundActivity) mutableV2QueryActivity.refreshingCount += 1;
  notify(entry);

  const inFlight = Promise.resolve()
    .then(() => query({ signal: controller.signal }))
    .then((result) => {
      if (isCurrentRequest(cacheKey, entry, requestRevision, controller)) {
        entry.data = result;
        entry.hasData = true;
        entry.updatedAt = Date.now();
        entry.invalidated = false;
        entry.error = null;
        mutableV2QueryActivity.refreshedAt = entry.updatedAt;
        mutableV2QueryActivity.lastErrorAt = null;
      }
      return result;
    })
    .catch((error: unknown) => {
      if (isCurrentRequest(cacheKey, entry, requestRevision, controller)) {
        entry.error = error;
        if (entry.hasData) mutableV2QueryActivity.lastErrorAt = Date.now();
      }
      throw error;
    })
    .finally(() => {
      if (entry.controller === controller) {
        entry.controller = undefined;
        entry.inFlight = undefined;
        entry.status = 'idle';
      }
      if (backgroundActivity) {
        mutableV2QueryActivity.refreshingCount = Math.max(
          0,
          mutableV2QueryActivity.refreshingCount - 1
        );
      }
      notify(entry);
    });

  entry.inFlight = inFlight;
  return inFlight;
}

export function useV2Query<T>(options: UseV2QueryOptions<T>): UseV2QueryResult<T> {
  const data = shallowRef<T>();
  const displayedData = ref(false);
  const currentData = ref(false);
  const placeholderData = ref(false);
  const isInitialLoading = ref(false);
  const isRefreshing = ref(false);
  const error = shallowRef<unknown>(null);
  const refreshedAt = ref<number | null>(null);
  let subscribedEntry: V2QueryEntry<T> | null = null;

  function syncFromEntry(entry: V2QueryEntry<T>, preservePrevious = true) {
    currentData.value = entry.hasData;
    if (entry.hasData) {
      data.value = entry.data;
      displayedData.value = true;
      placeholderData.value = false;
      refreshedAt.value = entry.updatedAt || null;
    } else if (!preservePrevious || options.keepPreviousData !== true || !displayedData.value) {
      data.value = undefined;
      displayedData.value = false;
      placeholderData.value = false;
      refreshedAt.value = null;
    } else {
      placeholderData.value = true;
    }
    error.value = entry.error;
    isInitialLoading.value = entry.status === 'pending' && !displayedData.value;
    isRefreshing.value = entry.status === 'pending' && displayedData.value;
  }

  function syncCurrentEntry(reason?: 'clear') {
    if (subscribedEntry) syncFromEntry(subscribedEntry, reason !== 'clear');
  }

  function unsubscribe(entry: V2QueryEntry<T>) {
    entry.listeners.delete(syncCurrentEntry);
    if (!entry.listeners.size) entry.controller?.abort();
  }

  function subscribe(entry: V2QueryEntry<T>) {
    if (subscribedEntry === entry) return;
    if (subscribedEntry) unsubscribe(subscribedEntry);
    subscribedEntry = entry;
    entry.listeners.add(syncCurrentEntry);
  }

  async function execute(force: boolean) {
    const cacheKey = resolveKey(options.scope, options.key);
    const entry = getEntry<T>(cacheKey, options.scope);
    subscribe(entry);
    syncFromEntry(entry);

    if (!force && isFresh(entry, options.tier)) return entry.data;
    const request =
      entry.inFlight && !entry.controller?.signal.aborted
        ? entry.inFlight
        : startRequest(cacheKey, entry, options.query);
    syncFromEntry(entry);

    try {
      await request;
    } catch {
      // 错误已写入当前查询条目；有旧数据时继续保留旧内容。
    } finally {
      if (subscribedEntry === entry) syncFromEntry(entry);
    }
    return entry.hasData ? entry.data : data.value;
  }

  function cancel() {
    if (!subscribedEntry) return;
    unsubscribe(subscribedEntry);
    subscribedEntry = null;
  }

  const initialCacheKey = resolveKey(options.scope, options.key);
  const initialEntry = getEntry<T>(initialCacheKey, options.scope);
  subscribe(initialEntry);
  syncFromEntry(initialEntry);

  onScopeDispose(cancel);

  return {
    data,
    hasData: computed(() => displayedData.value),
    hasCurrentData: computed(() => currentData.value),
    isPlaceholderData: computed(() => placeholderData.value),
    isInitialLoading,
    isRefreshing,
    error,
    refreshedAt,
    ensureFresh: () => execute(false),
    refresh: () => execute(true),
    cancel
  };
}

export function useV2ActivationRefresh(options: {
  scope: string;
  tier: V2QueryTier;
  load: () => Promise<unknown>;
}) {
  const query = useV2Query({
    scope: options.scope,
    key: 'activation',
    tier: options.tier,
    query: async () => {
      await options.load();
      return true;
    }
  });

  onActivated(() => {
    void query.ensureFresh();
  });

  return {
    hasLoadedOnce: query.hasData,
    isInitialLoading: query.isInitialLoading,
    isRefreshing: query.isRefreshing,
    error: query.error,
    refreshedAt: query.refreshedAt,
    refreshActivationData: query.refresh
  };
}

export function useV2ModuleRefresh(options: {
  moduleKey: V2ModuleKey;
  scope: string;
  load: () => Promise<unknown>;
}) {
  const moduleDefinition = getV2ModuleDefinition(options.moduleKey);
  if (!moduleDefinition) {
    throw new Error(`未配置的 V2 模块：${options.moduleKey}`);
  }
  return useV2ActivationRefresh({
    scope: options.scope,
    tier: moduleDefinition.loadingTier,
    load: options.load
  });
}

export function useV2ModuleQuery<T>(
  options: Omit<UseV2QueryOptions<T>, 'tier'> & {
    moduleKey: V2ModuleKey;
  }
) {
  const moduleDefinition = getV2ModuleDefinition(options.moduleKey);
  if (!moduleDefinition) {
    throw new Error(`未配置的 V2 模块：${options.moduleKey}`);
  }

  const query = useV2Query({
    scope: options.scope,
    key: options.key,
    tier: moduleDefinition.loadingTier,
    query: options.query,
    keepPreviousData: options.keepPreviousData ?? true
  });
  let mounted = false;

  async function ensureModuleFresh() {
    const hadCurrentData = query.hasCurrentData.value;
    if (hadCurrentData) {
      markV2RouteDataReady(options.moduleKey, 'memory-cache');
    }

    await query.ensureFresh();
    if (query.hasCurrentData.value) {
      markV2RouteDataReady(options.moduleKey, hadCurrentData ? 'memory-cache' : 'network');
    } else if (query.error.value) {
      markV2RouteDataError(options.moduleKey);
    }
  }

  onMounted(() => {
    mounted = true;
    void ensureModuleFresh();
  });
  onActivated(() => {
    if (mounted) void ensureModuleFresh();
  });

  return {
    ...query,
    hasLoadedOnce: query.hasData
  };
}

export function invalidateV2Queries(scopes: string | string[]) {
  ensureCacheIdentity();
  const requestedScopes = new Set(Array.isArray(scopes) ? scopes : [scopes]);
  for (const entry of queryCache.values()) {
    if (!requestedScopes.has(entry.scope)) continue;
    entry.revision += 1;
    entry.invalidated = true;
    entry.controller?.abort();
    notify(entry);
  }
}

export async function withV2QueryInvalidation<T>(request: Promise<T>, scopes: string | string[]) {
  const result = await request;
  invalidateV2Queries(scopes);
  return result;
}

export async function fetchV2Query<T>(
  options: UseV2QueryOptions<T>,
  controls: { force?: boolean } = {}
) {
  const cacheKey = resolveKey(options.scope, options.key);
  const entry = getEntry<T>(cacheKey, options.scope);
  if (!controls.force && isFresh(entry, options.tier)) return entry.data as T;
  if (entry.inFlight && !entry.controller?.signal.aborted) return entry.inFlight;
  return startRequest(cacheKey, entry, options.query);
}

export function getV2QueryData<T>(
  scope: string,
  key: string | (() => string),
  controls: { includeInvalidated?: boolean; tier?: V2QueryTier } = {}
) {
  const cacheKey = resolveKey(scope, key);
  const entry = queryCache.get(cacheKey) as V2QueryEntry<T> | undefined;
  if (!entry?.hasData) return undefined;
  if (!controls.includeInvalidated && entry.invalidated) return undefined;
  if (controls.tier && !isFresh(entry, controls.tier)) return undefined;
  return entry.data;
}

export function primeV2Query<T>(options: PrimeV2QueryOptions<T>) {
  const cacheKey = resolveKey(options.scope, options.key);
  const entry = getEntry<T>(cacheKey, options.scope);
  entry.revision += 1;
  entry.controller?.abort();
  entry.controller = undefined;
  entry.inFlight = undefined;
  entry.data = options.data;
  entry.hasData = true;
  entry.updatedAt = options.updatedAt ?? Date.now();
  entry.invalidated = false;
  entry.error = null;
  entry.status = 'idle';
  notify(entry);
}

function resetQueryCache(identityEpoch: number) {
  abortAllV2Requests();
  for (const entry of queryCache.values()) {
    entry.revision += 1;
    entry.controller?.abort();
    entry.data = undefined;
    entry.hasData = false;
    entry.error = null;
    entry.invalidated = true;
    entry.status = 'idle';
    notify(entry, 'clear');
  }
  queryCache.clear();
  cacheIdentityEpoch = identityEpoch;
  mutableV2QueryActivity.refreshingCount = 0;
  mutableV2QueryActivity.lastErrorAt = null;
  mutableV2QueryActivity.refreshedAt = null;
}

export function clearV2QueryCache() {
  resetQueryCache(getAuthIdentityEpoch());
}
