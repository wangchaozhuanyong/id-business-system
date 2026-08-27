import { reactive, readonly } from 'vue';
import { V2_DATA_SCOPES, type V2DataScope } from '@apple-business/shared';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { idBusinessV2ChangeSyncApi } from '@/v2/api/changeSync';
import { invalidateV2Queries } from '@/v2/composables/useV2Query';
import { showV2Warning } from '@/v2/services/feedback';
import { establishV2VersionBaseline, getChangedV2Scopes } from '@/v2/runtime/changeSyncPayload';
import {
  shouldReconcileV2OnForeground,
  V2_DEGRADED_RECONCILE_INTERVAL_MS
} from '@/v2/runtime/changeSyncPolicy';

const POLL_INTERVAL_MS = V2_DEGRADED_RECONCILE_INTERVAL_MS;

type ChangeSyncStatus = 'idle' | 'connecting' | 'connected' | 'degraded';

const mutableChangeSyncState = reactive({
  status: 'idle' as ChangeSyncStatus,
  lastReconciledAt: null as number | null,
  lastConnectedAt: null as number | null
});

export const v2ChangeSyncState = readonly(mutableChangeSyncState);

let started = false;
let syncGeneration = 0;
let reconcilePromise: Promise<void> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let consecutiveFailures = 0;
let degradationNotified = false;
let versionBaselineEstablished = false;
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
      const reconciledAt = Date.now();
      mutableChangeSyncState.status = 'connected';
      mutableChangeSyncState.lastReconciledAt = reconciledAt;
      mutableChangeSyncState.lastConnectedAt = reconciledAt;
      consecutiveFailures = 0;
      degradationNotified = false;
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
    showV2Warning('数据同步暂时不可用，系统将在后台继续重试，不影响当前页面操作。');
  }
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer !== undefined) clearTimeout(timer);
}

function scheduleReconcile() {
  clearTimer(reconcileTimer);
  if (!started || document.visibilityState === 'hidden') return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    void reconcileVersions();
  }, POLL_INTERVAL_MS);
}

function handleOnline() {
  void reconcileVersions();
}

function handleForeground() {
  if (!started) return;
  if (shouldReconcileV2OnForeground(mutableChangeSyncState.lastReconciledAt, Date.now())) {
    void reconcileVersions();
  } else {
    scheduleReconcile();
  }
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
  consecutiveFailures = 0;
  degradationNotified = false;
  versionBaselineEstablished = false;
  mutableChangeSyncState.status = 'connecting';
  window.addEventListener('online', handleOnline);
  window.addEventListener('focus', handleForeground);
  unsubscribeIdentityChange = sessionCoordinator.subscribeIdentityChange(handleAuthIdentityChanged);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void reconcileVersions();
}

export function stopV2ChangeSync() {
  if (!started) return;
  started = false;
  syncGeneration += 1;
  clearTimer(reconcileTimer);
  reconcileTimer = undefined;
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
