import { reactive, readonly } from 'vue';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { V2_DATA_SCOPES, type V2DataScope } from '@apple-business/shared';
import {
  removeSupabaseRealtimeChannel,
  refreshSupabaseRealtimeAuth,
  subscribeSupabasePrivateBroadcast,
  type SupabaseRealtimeStatus
} from '@/auth/supabase';
import { isSupabaseAuthConfigured } from '@/auth/supabase-config';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { idBusinessV2ChangeSyncApi } from '@/v2/api/changeSync';
import { invalidateV2Queries } from '@/v2/composables/useV2Query';
import { showV2Warning } from '@/v2/services/feedback';
import { shouldEnableV2RealtimeChanges } from '@/v2/runtime/changeSyncConfig';
import { getChangedV2Scopes, parseV2ChangeEvent } from '@/v2/runtime/changeSyncPayload';
import {
  shouldReconcileV2OnForeground,
  V2_DEGRADED_RECONCILE_INTERVAL_MS
} from '@/v2/runtime/changeSyncPolicy';

const REALTIME_TOPIC = 'id-business-v2:changes';
const REALTIME_EVENT = 'change';
const HEALTHY_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RECONNECT_DELAY_MS = 60 * 1000;
const REALTIME_ENABLED = shouldEnableV2RealtimeChanges(
  import.meta.env.VITE_V2_REALTIME_CHANGES_ENABLED,
  isSupabaseAuthConfigured()
);

type ChangeSyncStatus = 'idle' | 'connecting' | 'connected' | 'degraded';

const mutableChangeSyncState = reactive({
  status: 'idle' as ChangeSyncStatus,
  lastReconciledAt: null as number | null,
  lastConnectedAt: null as number | null
});

export const v2ChangeSyncState = readonly(mutableChangeSyncState);

let started = false;
let syncGeneration = 0;
let channel: RealtimeChannel | null = null;
let reconcilePromise: Promise<void> | null = null;
let connectPromise: Promise<void> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let consecutiveFailures = 0;
let degradationNotified = false;
let realtimeSubscribed = false;
let unsubscribeIdentityChange: (() => void) | null = null;
const localVersions = new Map<V2DataScope, bigint>(V2_DATA_SCOPES.map((scope) => [scope, 0n]));

function applyVersions(scopes: readonly { scope: V2DataScope; version: string }[]) {
  const changed: V2DataScope[] = [];
  for (const item of scopes) {
    const incomingVersion = BigInt(item.version);
    if (incomingVersion <= (localVersions.get(item.scope) ?? 0n)) continue;
    localVersions.set(item.scope, incomingVersion);
    changed.push(item.scope);
  }
  if (changed.length) invalidateV2Queries(changed);
}

function handleBroadcast(payload: unknown) {
  const event = parseV2ChangeEvent(payload);
  if (!event) return;
  applyVersions(event.scopes);
}

async function reconcileVersions() {
  if (!started) return;
  if (reconcilePromise) return reconcilePromise;
  const generation = syncGeneration;
  const request = idBusinessV2ChangeSyncApi
    .getVersions()
    .then((result) => {
      if (!started || generation !== syncGeneration) return;
      const changed = getChangedV2Scopes(result, localVersions);
      applyVersions(
        changed.map((scope) => ({
          scope,
          version: result.versions[scope]!
        }))
      );
      mutableChangeSyncState.lastReconciledAt = Date.now();
      consecutiveFailures = 0;
      degradationNotified = false;
      if (realtimeSubscribed) {
        mutableChangeSyncState.status = 'connected';
      }
      if (!REALTIME_ENABLED && mutableChangeSyncState.status !== 'connected') {
        mutableChangeSyncState.status = 'degraded';
      }
    })
    .catch(() => {
      if (!started || generation !== syncGeneration) return;
      registerFailure();
    })
    .finally(() => {
      if (reconcilePromise === request) reconcilePromise = null;
      if (started && generation === syncGeneration) scheduleReconcile();
    });
  reconcilePromise = request;
  return request;
}

function registerFailure() {
  consecutiveFailures += 1;
  mutableChangeSyncState.status = 'degraded';
  if (consecutiveFailures >= 3 && !degradationNotified) {
    degradationNotified = true;
    showV2Warning('实时更新暂时不可用，系统已切换为后台版本校验，不影响页面操作。');
  }
}

function registerConnected() {
  clearTimer(reconnectTimer);
  reconnectTimer = undefined;
  reconnectAttempt = 0;
  consecutiveFailures = 0;
  degradationNotified = false;
  realtimeSubscribed = true;
  mutableChangeSyncState.status = 'connected';
  mutableChangeSyncState.lastConnectedAt = Date.now();
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer !== undefined) clearTimeout(timer);
}

function scheduleReconcile() {
  clearTimer(reconcileTimer);
  if (!started || document.visibilityState === 'hidden') return;
  const delay =
    mutableChangeSyncState.status === 'connected'
      ? HEALTHY_RECONCILE_INTERVAL_MS
      : V2_DEGRADED_RECONCILE_INTERVAL_MS;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    void reconcileVersions();
  }, delay);
}

function scheduleReconnect() {
  if (!started || !REALTIME_ENABLED || reconnectTimer !== undefined) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectRealtime();
  }, delay);
}

function handleRealtimeStatus(status: SupabaseRealtimeStatus, generation: number) {
  if (!started || generation !== syncGeneration) return;
  if (status === 'SUBSCRIBED') {
    registerConnected();
    void reconcileVersions();
    return;
  }
  realtimeSubscribed = false;
  registerFailure();
  scheduleReconcile();
  scheduleReconnect();
}

function connectRealtime() {
  if (!started || !REALTIME_ENABLED) return Promise.resolve();
  if (connectPromise) return connectPromise;
  const generation = syncGeneration;
  const request = (async () => {
    mutableChangeSyncState.status = 'connecting';
    await removeSupabaseRealtimeChannel(channel).catch(() => undefined);
    if (!started || generation !== syncGeneration) return;
    channel = null;
    try {
      const authenticated = await refreshSupabaseRealtimeAuth();
      if (!authenticated || !started || generation !== syncGeneration) {
        registerFailure();
        scheduleReconnect();
        return;
      }
      channel = subscribeSupabasePrivateBroadcast(
        REALTIME_TOPIC,
        REALTIME_EVENT,
        (payload) => {
          if (started && generation === syncGeneration) handleBroadcast(payload);
        },
        (status) => handleRealtimeStatus(status, generation)
      );
      if (!channel) {
        registerFailure();
        scheduleReconnect();
      }
    } catch {
      registerFailure();
      scheduleReconnect();
    }
  })().finally(() => {
    if (connectPromise === request) connectPromise = null;
  });
  connectPromise = request;
  return request;
}

function handleOnline() {
  void reconcileVersions();
  if (mutableChangeSyncState.status !== 'connected') void connectRealtime();
}

function handleForeground() {
  if (!started) return;
  if (shouldReconcileV2OnForeground(mutableChangeSyncState.lastReconciledAt, Date.now())) {
    void reconcileVersions();
  } else {
    scheduleReconcile();
  }
  if (mutableChangeSyncState.status !== 'connected') void connectRealtime();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    clearTimer(reconcileTimer);
    reconcileTimer = undefined;
    return;
  }
  handleForeground();
}

function handleAuthIdentityChanged() {
  stopV2ChangeSync();
}

export function startV2ChangeSync() {
  if (started) return;
  started = true;
  syncGeneration += 1;
  reconnectAttempt = 0;
  consecutiveFailures = 0;
  degradationNotified = false;
  realtimeSubscribed = false;
  mutableChangeSyncState.status = REALTIME_ENABLED ? 'connecting' : 'degraded';
  window.addEventListener('online', handleOnline);
  window.addEventListener('focus', handleForeground);
  unsubscribeIdentityChange = sessionCoordinator.subscribeIdentityChange(handleAuthIdentityChanged);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void reconcileVersions();
  if (REALTIME_ENABLED) void connectRealtime();
}

export function stopV2ChangeSync() {
  if (!started) return;
  started = false;
  syncGeneration += 1;
  clearTimer(reconcileTimer);
  clearTimer(reconnectTimer);
  reconcileTimer = undefined;
  reconnectTimer = undefined;
  reconcilePromise = null;
  connectPromise = null;
  degradationNotified = false;
  realtimeSubscribed = false;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('focus', handleForeground);
  unsubscribeIdentityChange?.();
  unsubscribeIdentityChange = null;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  void removeSupabaseRealtimeChannel(channel).catch(() => undefined);
  channel = null;
  localVersions.clear();
  for (const scope of V2_DATA_SCOPES) localVersions.set(scope, 0n);
  mutableChangeSyncState.status = 'idle';
}
