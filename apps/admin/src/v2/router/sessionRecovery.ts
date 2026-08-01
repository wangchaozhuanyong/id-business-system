import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { SessionState } from '@/auth/sessionCoordinator';

export function createSessionRecoveryTracker(onRecovered: () => void) {
  let recoveryPending = false;
  return (kind: SessionState['kind']) => {
    if (kind === 'degraded') {
      recoveryPending = true;
      return;
    }
    if (kind === 'ready' && recoveryPending) {
      recoveryPending = false;
      onRecovered();
      return;
    }
    if (kind === 'anonymous' || kind === 'blocked' || kind === 'cold') {
      recoveryPending = false;
    }
  };
}

export function createVerifiedDegradedFallback(from: RouteLocationNormalizedLoaded) {
  return {
    path: from.path,
    query: from.query,
    hash: from.hash,
    replace: true
  };
}
