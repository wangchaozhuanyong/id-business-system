export const V2_DEGRADED_RECONCILE_INTERVAL_MS = 15_000;

const V2_FOREGROUND_RECONCILE_MIN_INTERVAL_MS = 5_000;

export function shouldReconcileV2OnForeground(lastReconciledAt: number | null, now = Date.now()) {
  return (
    lastReconciledAt === null || now - lastReconciledAt >= V2_FOREGROUND_RECONCILE_MIN_INTERVAL_MS
  );
}
