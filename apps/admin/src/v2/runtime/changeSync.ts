import { reactive, readonly } from 'vue';
import { V2_DATA_SCOPES, type V2ChangeEvent, type V2DataScope } from '@apple-business/shared';
import { isRequestCanceled } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { idBusinessV2ChangeSyncApi, type V2ChangeStreamEventType } from '@/v2/api/changeSync';
import { invalidateV2Queries } from '@/v2/composables/useV2Query';
import { showV2Warning } from '@/v2/services/feedback';
import {
  establishV2VersionBaseline,
  getChangedV2Scopes,
  parseV2ChangeEvent
} from '@/v2/runtime/changeSyncPayload';
import {
  getV2StreamReconnectDelay,
  shouldReconcileV2OnForeground,
  V2_DEGRADED_RECONCILE_INTERVAL_MS,
  V2_STREAM_STALE_TIMEOUT_MS
} from '@/v2/runtime/changeSyncPolicy';

type ChangeSyncStatus = 'idle' | 'connecting' | 'connected' | 'degraded';

interface ActiveStream {
  controller: AbortController;
  expectedAbort: boolean;
  failureHandled: boolean;
  generation: number;
}

const mutableChangeSyncState = reactive({
  status: 'idle' as ChangeSyncStatus,
  lastActivityAt: null as number | null,
  lastReconciledAt: null as number | null,
  lastConnectedAt: null as number | null
});

export const v2ChangeSyncState = readonly(mutableChangeSyncState);

let started = false;
let syncGeneration = 0;
let reconcilePromise: Promise<void> | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let livenessTimer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;
let reconnectAttempt = 0;
let degradationNotified = false;
let versionBaselineEstablished = false;
let streamConnected = false;
let activeStream: ActiveStream | null = null;
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

function establishEventBaseline(event: V2ChangeEvent) {
  for (const item of event.scopes) {
    const incomingVersion = BigInt(item.version);
    if (incomingVersion > (localVersions.get(item.scope) ?? 0n)) {
      localVersions.set(item.scope, incomingVersion);
    }
  }
  versionBaselineEstablished = true;
}

async function reconcileVersions() {
  if (!started) return;
  if (reconcilePromise) return reconcilePromise;
  const generation = syncGeneration;
  const request = idBusinessV2ChangeSyncApi
    .getVersions()
    .then((result) => {
      if (!started || generation !== syncGeneration) return;
      if (!versionBaselineEstablished) {
        establishV2VersionBaseline(result, localVersions);
        versionBaselineEstablished = true;
      } else {
        const changed = getChangedV2Scopes(result, localVersions);
        applyVersions(
          changed.map((scope) => ({
            scope,
            version: result.versions[scope]!
          }))
        );
      }
      mutableChangeSyncState.lastReconciledAt = Date.now();
      if (!streamConnected) mutableChangeSyncState.status = 'degraded';
    })
    .catch((error: unknown) => {
      if (!started || generation !== syncGeneration || isRequestCanceled(error)) return;
      registerFailure();
    })
    .finally(() => {
      if (reconcilePromise === request) reconcilePromise = null;
      if (started && generation === syncGeneration && !streamConnected) {
        scheduleFallbackReconcile();
      }
    });
  reconcilePromise = request;
  return request;
}

function connectStream() {
  if (!started || activeStream || document.visibilityState === 'hidden' || !navigator.onLine) {
    return;
  }

  clearTimer(reconnectTimer);
  reconnectTimer = undefined;
  const connection: ActiveStream = {
    controller: new AbortController(),
    expectedAbort: false,
    failureHandled: false,
    generation: syncGeneration
  };
  activeStream = connection;
  if (!streamConnected) mutableChangeSyncState.status = 'connecting';

  void idBusinessV2ChangeSyncApi
    .streamEvents({
      signal: connection.controller.signal,
      onOpen: () => handleStreamOpen(connection),
      onActivity: () => handleStreamActivity(connection),
      onEvent: (type, payload) => handleStreamEvent(connection, type, payload)
    })
    .catch((error: unknown) => {
      if (!connection.expectedAbort && !isRequestCanceled(error)) {
        handleStreamFailure(connection);
      }
    })
    .finally(() => {
      if (activeStream === connection) activeStream = null;
      if (connection.expectedAbort) return;
      handleStreamFailure(connection);
    });
}

function handleStreamOpen(connection: ActiveStream) {
  if (!isCurrentConnection(connection)) return;
  streamConnected = true;
  reconnectAttempt = 0;
  consecutiveFailures = 0;
  degradationNotified = false;
  mutableChangeSyncState.status = 'connected';
  mutableChangeSyncState.lastConnectedAt = Date.now();
  clearTimer(fallbackTimer);
  fallbackTimer = undefined;
  handleStreamActivity(connection);
}

function handleStreamActivity(connection: ActiveStream) {
  if (!isCurrentConnection(connection)) return;
  mutableChangeSyncState.lastActivityAt = Date.now();
  clearTimer(livenessTimer);
  livenessTimer = setTimeout(() => {
    if (!isCurrentConnection(connection)) return;
    connection.controller.abort(new DOMException('实时数据连接心跳超时。', 'TimeoutError'));
    handleStreamFailure(connection);
  }, V2_STREAM_STALE_TIMEOUT_MS);
}

function handleStreamEvent(
  connection: ActiveStream,
  type: V2ChangeStreamEventType,
  payload: unknown
) {
  if (!isCurrentConnection(connection) || type === 'heartbeat') return;
  const event = parseV2ChangeEvent(payload);
  if (!event) return;
  if (type === 'snapshot' && !versionBaselineEstablished) {
    establishEventBaseline(event);
    return;
  }
  applyVersions(event.scopes);
}

function handleStreamFailure(connection: ActiveStream) {
  if (
    connection.failureHandled ||
    connection.expectedAbort ||
    !started ||
    connection.generation !== syncGeneration
  ) {
    return;
  }
  connection.failureHandled = true;
  streamConnected = false;
  clearTimer(livenessTimer);
  livenessTimer = undefined;
  registerFailure();
  void reconcileVersions();
  scheduleStreamReconnect();
}

function isCurrentConnection(connection: ActiveStream) {
  return (
    started &&
    activeStream === connection &&
    connection.generation === syncGeneration &&
    !connection.expectedAbort
  );
}

function registerFailure() {
  consecutiveFailures += 1;
  mutableChangeSyncState.status = 'degraded';
  if (consecutiveFailures >= 3 && !degradationNotified) {
    degradationNotified = true;
    showV2Warning('实时数据连接暂时不可用，系统已切换为后台版本检查。');
  }
}

function scheduleFallbackReconcile() {
  clearTimer(fallbackTimer);
  if (!started || streamConnected || document.visibilityState === 'hidden') return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = undefined;
    void reconcileVersions();
  }, V2_DEGRADED_RECONCILE_INTERVAL_MS);
}

function scheduleStreamReconnect() {
  clearTimer(reconnectTimer);
  if (!started || streamConnected || document.visibilityState === 'hidden' || !navigator.onLine) {
    return;
  }
  const delay = getV2StreamReconnectDelay(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectStream();
  }, delay);
}

function abortStream() {
  if (!activeStream) return;
  activeStream.expectedAbort = true;
  activeStream.controller.abort();
  activeStream = null;
  streamConnected = false;
  clearTimer(livenessTimer);
  livenessTimer = undefined;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer !== undefined) clearTimeout(timer);
}

function handleOnline() {
  if (!started) return;
  void reconcileVersions();
  connectStream();
}

function handleForeground() {
  if (!started) return;
  if (shouldReconcileV2OnForeground(mutableChangeSyncState.lastReconciledAt, Date.now())) {
    void reconcileVersions();
  }
  if (!streamConnected) connectStream();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    clearTimer(fallbackTimer);
    fallbackTimer = undefined;
    clearTimer(reconnectTimer);
    reconnectTimer = undefined;
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
  consecutiveFailures = 0;
  reconnectAttempt = 0;
  degradationNotified = false;
  versionBaselineEstablished = false;
  mutableChangeSyncState.status = 'connecting';
  window.addEventListener('online', handleOnline);
  window.addEventListener('focus', handleForeground);
  unsubscribeIdentityChange = sessionCoordinator.subscribeIdentityChange(handleAuthIdentityChanged);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void reconcileVersions();
  connectStream();
}

export function stopV2ChangeSync() {
  if (!started) return;
  started = false;
  syncGeneration += 1;
  abortStream();
  clearTimer(fallbackTimer);
  clearTimer(reconnectTimer);
  clearTimer(livenessTimer);
  fallbackTimer = undefined;
  reconnectTimer = undefined;
  livenessTimer = undefined;
  reconcilePromise = null;
  degradationNotified = false;
  versionBaselineEstablished = false;
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('focus', handleForeground);
  unsubscribeIdentityChange?.();
  unsubscribeIdentityChange = null;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  localVersions.clear();
  for (const scope of V2_DATA_SCOPES) localVersions.set(scope, 0n);
  mutableChangeSyncState.status = 'idle';
}
