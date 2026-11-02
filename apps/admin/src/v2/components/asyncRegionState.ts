import type { V2QueryPhase } from '@/v2/composables/useV2Query';

export type V2AsyncRegionState =
  | 'inactive'
  | 'forbidden'
  | 'initial-loading'
  | 'initial-error'
  | 'empty'
  | 'content';

interface ResolveV2AsyncRegionStateInput {
  forbidden: boolean;
  phase: V2QueryPhase;
  empty: boolean;
}

export function resolveV2AsyncRegionState({
  forbidden,
  phase,
  empty
}: ResolveV2AsyncRegionStateInput): V2AsyncRegionState {
  if (forbidden) return 'forbidden';
  // A query can wait for a dependency, an active tab or an open drawer without lacking access.
  if (phase === 'disabled') return 'inactive';
  if (phase === 'initial-error') return 'initial-error';
  if (phase === 'idle' || phase === 'initial-loading') return 'initial-loading';
  if (empty && phase !== 'transitioning') return 'empty';
  return 'content';
}

export function resolveLegacyV2QueryPhase(input: {
  loading: boolean;
  resolved: boolean;
  error: string;
}): V2QueryPhase {
  if (input.loading) return input.resolved ? 'refreshing' : 'initial-loading';
  if (input.error) return input.resolved ? 'refresh-error' : 'initial-error';
  return input.resolved ? 'ready' : 'idle';
}

export function shouldDeferV2RefreshFeedback(phase: V2QueryPhase) {
  return phase === 'refreshing' || phase === 'transitioning';
}
