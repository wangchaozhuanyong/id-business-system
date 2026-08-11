import {
  computed,
  onActivated,
  onDeactivated,
  onMounted,
  onScopeDispose,
  reactive,
  readonly,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue';
import { expandV2DataScopes, type V2DataScope } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { markV2RouteDataError, markV2RouteDataReady } from '@/runtime/performance';
import { abortAllV2Requests } from '@/v2/api/requestControl';
import { getV2ModuleDefinition, type V2ModuleKey } from '@/v2/config/modules';
import type { V2FreshnessPolicy } from '@/v2/features/feature';

export type { V2FreshnessPolicy } from '@/v2/features/feature';

export interface V2QueryContext {
  signal: AbortSignal;
}

export interface UseV2QueryOptions<T> {
  scope: V2DataScope;
  key: string | (() => string);
  enabled?: boolean | (() => boolean);
  freshnessPolicy?: V2FreshnessPolicy;
  query: (context: V2QueryContext) => Promise<T>;
  keepPreviousData?: boolean;
  getRevalidateAt?: (data: T) => Date | number | string | null | undefined;
}

export type V2QueryPhase =
  | 'disabled'
  | 'idle'
  | 'initial-loading'
  | 'ready'
  | 'refreshing'
  | 'transitioning'
  | 'initial-error'
  | 'refresh-error';

export interface PrimeV2QueryOptions<T> {
  scope: V2DataScope;
  key: string | (() => string);
  data: T;
  updatedAt?: number;
}

export interface UseV2QueryResult<T> {
  data: Ref<T | undefined>;
  enabled: ComputedRef<boolean>;
  phase: ComputedRef<V2QueryPhase>;
  hasData: ComputedRef<boolean>;
  hasCurrentData: ComputedRef<boolean>;
  isPlaceholderData: ComputedRef<boolean>;
  isParameterTransition: ComputedRef<boolean>;
  requestedKey: Ref<string>;
  displayedKey: Ref<string | null>;
  isInitialLoading: Ref<boolean>;
  isRefreshing: Ref<boolean>;
  error: Ref<unknown>;
  refreshedAt: Ref<number | null>;
  ensureFresh: () => Promise<T | undefined>;
  refresh: () => Promise<T | undefined>;
  cancel: () => void;
}

type V2QueryListener = (reason?: 'clear' | 'invalidate') => void;

interface V2QueryEntry<T = unknown> {
  scope: V2DataScope;
  state: 'clean' | 'dirty' | 'pending';
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
  requested: boolean;
  lastAccessedAt: number;
  revalidateAt: number | null;
  deadlineTimer?: ReturnType<typeof setTimeout>;
}

const queryCache = new Map<string, V2QueryEntry>();
const MAX_INACTIVE_QUERY_ENTRIES = 200;
const INVALIDATION_COALESCE_MS = 100;

function getAuthIdentityEpoch() {
  return sessionCoordinator.identityEpoch.value;
}
let invalidationTimer: ReturnType<typeof setTimeout> | undefined;
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

function resolveKeyValue(key: string | (() => string)) {
  return typeof key === 'function' ? key() : key;
}

function resolveKey(scope: V2DataScope, key: string | (() => string)) {
  ensureCacheIdentity();
  const value = resolveKeyValue(key);
  return `${cacheIdentityEpoch}:${scope}:${value}`;
}

function getEntry<T>(cacheKey: string, scope: V2DataScope) {
  const existing = queryCache.get(cacheKey) as V2QueryEntry<T> | undefined;
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const entry: V2QueryEntry<T> = {
    scope,
    state: 'dirty',
    hasData: false,
    updatedAt: 0,
    invalidated: false,
    revision: 0,
    status: 'idle',
    error: null,
    listeners: new Set(),
    requested: false,
    lastAccessedAt: Date.now(),
    revalidateAt: null
  };
  queryCache.set(cacheKey, entry);
  trimInactiveQueryCache();
  return entry;
}

function notify(entry: V2QueryEntry, reason?: 'clear' | 'invalidate') {
  for (const listener of entry.listeners) listener(reason);
}

function isFresh(entry: V2QueryEntry) {
  return (
    entry.hasData &&
    !entry.invalidated &&
    (entry.revalidateAt === null || Date.now() < entry.revalidateAt)
  );
}

function trimInactiveQueryCache() {
  if (queryCache.size <= MAX_INACTIVE_QUERY_ENTRIES) return;
  const removable = [...queryCache.entries()]
    .filter(([, entry]) => entry.listeners.size === 0 && entry.status !== 'pending')
    .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);
  for (const [cacheKey, entry] of removable) {
    if (queryCache.size <= MAX_INACTIVE_QUERY_ENTRIES) break;
    clearEntryDeadline(entry);
    queryCache.delete(cacheKey);
  }
}

function clearEntryDeadline(entry: V2QueryEntry) {
  if (entry.deadlineTimer === undefined) return;
  clearTimeout(entry.deadlineTimer);
  entry.deadlineTimer = undefined;
}

function resolveRevalidateAt<T>(
  policy: V2FreshnessPolicy,
  resolver: UseV2QueryOptions<T>['getRevalidateAt'],
  data: T
) {
  if (policy !== 'event-with-deadline' || !resolver) return null;
  const value = resolver(data);
  if (value === null || value === undefined || value === '') return null;
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function markEntryInvalidated(entry: V2QueryEntry) {
  entry.revision += 1;
  entry.invalidated = true;
  entry.state = 'dirty';
  entry.controller?.abort();
  clearEntryDeadline(entry);
  notify(entry);
}

function scheduleEntryDeadline(entry: V2QueryEntry) {
  clearEntryDeadline(entry);
  if (entry.revalidateAt === null || entry.invalidated) return;
  const delay = Math.max(0, entry.revalidateAt - Date.now());
  entry.deadlineTimer = setTimeout(
    () => {
      entry.deadlineTimer = undefined;
      if (entry.revalidateAt !== null && Date.now() < entry.revalidateAt) {
        scheduleEntryDeadline(entry);
        return;
      }
      markEntryInvalidated(entry);
      notify(entry, 'invalidate');
    },
    Math.min(delay, 2_147_483_647)
  );
}

function scheduleActiveInvalidationRefresh() {
  if (invalidationTimer !== undefined) return;
  invalidationTimer = setTimeout(() => {
    invalidationTimer = undefined;
    for (const entry of queryCache.values()) {
      if (entry.invalidated && entry.requested && entry.listeners.size) {
        notify(entry, 'invalidate');
      }
    }
  }, INVALIDATION_COALESCE_MS);
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
  query: UseV2QueryOptions<T>['query'],
  freshnessPolicy: V2FreshnessPolicy,
  getRevalidateAt?: UseV2QueryOptions<T>['getRevalidateAt']
) {
  const controller = new AbortController();
  const requestRevision = entry.revision;
  entry.controller = controller;
  entry.requested = true;
  entry.status = 'pending';
  entry.state = 'pending';
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
        entry.state = 'clean';
        entry.revalidateAt = resolveRevalidateAt(freshnessPolicy, getRevalidateAt, result);
        entry.lastAccessedAt = entry.updatedAt;
        entry.error = null;
        mutableV2QueryActivity.refreshedAt = entry.updatedAt;
        mutableV2QueryActivity.lastErrorAt = null;
      }
      scheduleEntryDeadline(entry);
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
        if (entry.state === 'pending') {
          entry.state = entry.hasData && !entry.invalidated ? 'clean' : 'dirty';
        }
      }
      if (backgroundActivity) {
        mutableV2QueryActivity.refreshingCount = Math.max(
          0,
          mutableV2QueryActivity.refreshingCount - 1
        );
      }
      notify(entry);
      if (entry.invalidated && entry.revision !== requestRevision && entry.listeners.size) {
        scheduleActiveInvalidationRefresh();
      }
      trimInactiveQueryCache();
    });

  entry.inFlight = inFlight;
  return inFlight;
}

export function useV2Query<T>(options: UseV2QueryOptions<T>): UseV2QueryResult<T> {
  const freshnessPolicy = options.freshnessPolicy ?? 'event-driven';
  const enabled = computed(() =>
    typeof options.enabled === 'function' ? options.enabled() : options.enabled !== false
  );
  const data = shallowRef<T>();
  const displayedData = ref(false);
  const currentData = ref(false);
  const placeholderData = ref(false);
  const requestedKey = ref(resolveKeyValue(options.key));
  const displayedKey = ref<string | null>(null);
  const isInitialLoading = ref(false);
  const isRefreshing = ref(false);
  const error = shallowRef<unknown>(null);
  const refreshedAt = ref<number | null>(null);
  let subscribedEntry: V2QueryEntry<T> | null = null;
  let subscribedKey = requestedKey.value;

  function syncFromEntry(
    entry: V2QueryEntry<T>,
    preservePrevious = true,
    entryKey = subscribedKey
  ) {
    currentData.value = entry.hasData;
    if (entry.hasData) {
      data.value = entry.data;
      displayedData.value = true;
      placeholderData.value = false;
      displayedKey.value = entryKey;
      refreshedAt.value = entry.updatedAt || null;
    } else if (!preservePrevious || options.keepPreviousData !== true || !displayedData.value) {
      data.value = undefined;
      displayedData.value = false;
      placeholderData.value = false;
      displayedKey.value = null;
      refreshedAt.value = null;
    } else {
      placeholderData.value = true;
    }
    error.value = entry.error;
    isInitialLoading.value = entry.status === 'pending' && !displayedData.value;
    isRefreshing.value = entry.status === 'pending' && displayedData.value;
  }

  function syncCurrentEntry(reason?: 'clear' | 'invalidate') {
    if (!subscribedEntry) return;
    syncFromEntry(subscribedEntry, reason !== 'clear');
    if (reason === 'invalidate' && subscribedEntry.status !== 'pending') {
      void execute(false);
    }
  }

  function unsubscribe(entry: V2QueryEntry<T>) {
    entry.listeners.delete(syncCurrentEntry);
    if (!entry.listeners.size) {
      entry.controller?.abort();
      trimInactiveQueryCache();
    }
  }

  function subscribe(entry: V2QueryEntry<T>, entryKey: string) {
    if (subscribedEntry === entry) {
      subscribedKey = entryKey;
      return;
    }
    if (subscribedEntry) unsubscribe(subscribedEntry);
    subscribedEntry = entry;
    subscribedKey = entryKey;
    entry.listeners.add(syncCurrentEntry);
    entry.lastAccessedAt = Date.now();
    scheduleEntryDeadline(entry);
  }

  async function execute(force: boolean, retryAfterCacheReset = true) {
    const nextKey = resolveKeyValue(options.key);
    requestedKey.value = nextKey;
    if (!enabled.value) return data.value;

    const cacheKey = resolveKey(options.scope, nextKey);
    const entry = getEntry<T>(cacheKey, options.scope);
    subscribe(entry, nextKey);
    syncFromEntry(entry, true, nextKey);

    if (!force && isFresh(entry)) return entry.data;
    const request =
      entry.inFlight && !entry.controller?.signal.aborted
        ? entry.inFlight
        : startRequest(cacheKey, entry, options.query, freshnessPolicy, options.getRevalidateAt);
    syncFromEntry(entry, true, nextKey);

    try {
      await request;
    } catch {
      // 错误已写入当前查询条目；有旧数据时继续保留旧内容。
    } finally {
      if (subscribedEntry === entry) syncFromEntry(entry, true, nextKey);
    }
    if (retryAfterCacheReset && queryCache.get(cacheKey) !== entry) {
      return execute(force, false);
    }
    return entry.hasData ? entry.data : data.value;
  }

  function cancel() {
    if (subscribedEntry) {
      unsubscribe(subscribedEntry);
      subscribedEntry = null;
    }
    isInitialLoading.value = false;
    isRefreshing.value = false;
  }

  function clearDisplayedState() {
    data.value = undefined;
    displayedData.value = false;
    currentData.value = false;
    placeholderData.value = false;
    displayedKey.value = null;
    refreshedAt.value = null;
    error.value = null;
  }

  if (enabled.value) {
    const initialCacheKey = resolveKey(options.scope, requestedKey.value);
    const initialEntry = getEntry<T>(initialCacheKey, options.scope);
    subscribe(initialEntry, requestedKey.value);
    syncFromEntry(initialEntry);
  }

  watch(enabled, (isEnabled) => {
    if (isEnabled) return;
    cancel();
    clearDisplayedState();
  });

  onScopeDispose(cancel);

  const phase = computed<V2QueryPhase>(() => {
    if (!enabled.value) return 'disabled';
    if (error.value && !displayedData.value) return 'initial-error';
    if (error.value && displayedData.value) return 'refresh-error';
    if (isInitialLoading.value) return 'initial-loading';
    if (isRefreshing.value && placeholderData.value) return 'transitioning';
    if (isRefreshing.value) return 'refreshing';
    if (currentData.value || displayedData.value) return 'ready';
    return 'idle';
  });

  return {
    data,
    enabled,
    phase,
    hasData: computed(() => displayedData.value),
    hasCurrentData: computed(() => currentData.value),
    isPlaceholderData: computed(() => placeholderData.value),
    isParameterTransition: computed(() => placeholderData.value),
    requestedKey,
    displayedKey,
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
  scope: V2DataScope;
  freshnessPolicy?: V2FreshnessPolicy;
  load: () => Promise<unknown>;
}) {
  const query = useV2Query({
    scope: options.scope,
    key: 'activation',
    freshnessPolicy: options.freshnessPolicy,
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
  scope: V2DataScope;
  load: () => Promise<unknown>;
}) {
  const moduleDefinition = getV2ModuleDefinition(options.moduleKey);
  if (!moduleDefinition) {
    throw new Error(`未配置的 V2 模块：${options.moduleKey}`);
  }
  return useV2ActivationRefresh({
    scope: options.scope,
    freshnessPolicy: moduleDefinition.freshnessPolicy,
    load: options.load
  });
}

export function useV2ModuleQuery<T>(
  options: Omit<UseV2QueryOptions<T>, 'freshnessPolicy'> & {
    moduleKey: V2ModuleKey;
    trackRouteData?: boolean | (() => boolean);
  }
) {
  const moduleDefinition = getV2ModuleDefinition(options.moduleKey);
  if (!moduleDefinition) {
    throw new Error(`未配置的 V2 模块：${options.moduleKey}`);
  }

  const query = useV2Query({
    scope: options.scope,
    key: options.key,
    enabled: options.enabled,
    freshnessPolicy: moduleDefinition.freshnessPolicy,
    query: options.query,
    keepPreviousData: options.keepPreviousData ?? true,
    getRevalidateAt: options.getRevalidateAt
  });
  const trackRouteData = computed(() =>
    typeof options.trackRouteData === 'function'
      ? options.trackRouteData()
      : options.trackRouteData !== false
  );
  let mounted = false;

  watch([trackRouteData, query.hasCurrentData], ([shouldTrack, hasCurrentData]) => {
    if (shouldTrack && hasCurrentData) markV2RouteDataReady(options.moduleKey, 'network');
  });

  async function ensureModuleFresh() {
    const hadCurrentData = query.hasCurrentData.value;
    if (trackRouteData.value && hadCurrentData) {
      markV2RouteDataReady(options.moduleKey, 'memory-cache');
    }

    await query.ensureFresh();
    if (!trackRouteData.value) return;
    if (query.hasCurrentData.value) {
      markV2RouteDataReady(options.moduleKey, hadCurrentData ? 'memory-cache' : 'network');
    } else if (query.error.value) {
      markV2RouteDataError(options.moduleKey);
    }
  }

  onMounted(() => {
    mounted = true;
    if (query.enabled.value) void ensureModuleFresh();
  });
  onActivated(() => {
    if (mounted && query.enabled.value) void ensureModuleFresh();
  });
  onDeactivated(query.cancel);
  watch(query.enabled, (isEnabled) => {
    if (mounted && isEnabled) void ensureModuleFresh();
  });

  return {
    ...query,
    hasLoadedOnce: query.hasData
  };
}

export function invalidateV2Queries(scopes: V2DataScope | readonly V2DataScope[]) {
  ensureCacheIdentity();
  const requestedScopes = new Set(expandV2DataScopes(Array.isArray(scopes) ? scopes : [scopes]));
  for (const entry of queryCache.values()) {
    if (!requestedScopes.has(entry.scope)) continue;
    markEntryInvalidated(entry);
  }
  scheduleActiveInvalidationRefresh();
}

export async function withV2QueryInvalidation<T>(
  request: Promise<T>,
  scopes: V2DataScope | readonly V2DataScope[]
) {
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
  if (!controls.force && isFresh(entry)) return entry.data as T;
  if (entry.inFlight && !entry.controller?.signal.aborted) return entry.inFlight;
  return startRequest(
    cacheKey,
    entry,
    options.query,
    options.freshnessPolicy ?? 'event-driven',
    options.getRevalidateAt
  );
}

export function getV2QueryData<T>(
  scope: V2DataScope,
  key: string | (() => string),
  controls: { includeInvalidated?: boolean } = {}
) {
  const cacheKey = resolveKey(scope, key);
  const entry = queryCache.get(cacheKey) as V2QueryEntry<T> | undefined;
  if (!entry?.hasData) return undefined;
  if (!controls.includeInvalidated && entry.invalidated) return undefined;
  if (!controls.includeInvalidated && !isFresh(entry)) return undefined;
  return entry.data;
}

export function primeV2Query<T>(options: PrimeV2QueryOptions<T>) {
  const cacheKey = resolveKey(options.scope, options.key);
  const entry = getEntry<T>(cacheKey, options.scope);
  clearEntryDeadline(entry);
  entry.revision += 1;
  entry.controller?.abort();
  entry.controller = undefined;
  entry.inFlight = undefined;
  entry.data = options.data;
  entry.hasData = true;
  entry.updatedAt = options.updatedAt ?? Date.now();
  entry.invalidated = false;
  entry.state = 'clean';
  entry.revalidateAt = null;
  entry.lastAccessedAt = entry.updatedAt;
  entry.error = null;
  entry.status = 'idle';
  entry.requested = true;
  notify(entry);
}

function resetQueryCache(identityEpoch: number) {
  if (invalidationTimer !== undefined) {
    clearTimeout(invalidationTimer);
    invalidationTimer = undefined;
  }
  abortAllV2Requests();
  for (const entry of queryCache.values()) {
    clearEntryDeadline(entry);
    entry.revision += 1;
    entry.controller?.abort();
    entry.data = undefined;
    entry.hasData = false;
    entry.error = null;
    entry.invalidated = true;
    entry.state = 'dirty';
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
  resetQueryCache(sessionCoordinator.identityEpoch.value);
}

sessionCoordinator.subscribeIdentityChange(ensureCacheIdentity);
