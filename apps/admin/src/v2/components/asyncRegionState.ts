export type V2AsyncRegionState =
  'forbidden' | 'initial-loading' | 'initial-error' | 'empty' | 'content';

interface ResolveV2AsyncRegionStateInput {
  forbidden: boolean;
  resolved: boolean;
  error: string;
  empty: boolean;
}

export function resolveV2AsyncRegionState({
  forbidden,
  resolved,
  error,
  empty
}: ResolveV2AsyncRegionStateInput): V2AsyncRegionState {
  if (forbidden) return 'forbidden';
  if (!resolved) return error ? 'initial-error' : 'initial-loading';
  if (empty) return 'empty';
  return 'content';
}

export function shouldDeferV2RefreshFeedback(loading: boolean, resolved: boolean) {
  return loading && resolved;
}
