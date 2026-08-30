export const V2_DEGRADED_RECONCILE_INTERVAL_MS = 15_000;
export const V2_STREAM_STALE_TIMEOUT_MS = 60_000;
export const V2_STREAM_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

const V2_FOREGROUND_RECONCILE_MIN_INTERVAL_MS = 5_000;

export function shouldReconcileV2OnForeground(lastReconciledAt: number | null, now = Date.now()) {
  return (
    lastReconciledAt === null || now - lastReconciledAt >= V2_FOREGROUND_RECONCILE_MIN_INTERVAL_MS
  );
}

export function getV2StreamReconnectDelay(attempt: number) {
  const index = Math.min(Math.max(0, attempt), V2_STREAM_RECONNECT_DELAYS_MS.length - 1);
  return V2_STREAM_RECONNECT_DELAYS_MS[index]!;
}
