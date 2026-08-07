const PRELOAD_RELOAD_STORAGE_KEY = 'apple-business:v2-preload-reload-build';

export type V2PreloadRecoveryAction = 'defer-to-router' | 'reload-once' | 'show-degraded';
export type V2PreloadFailureRecoveryResult =
  | V2PreloadRecoveryAction
  | 'not-preload-failure'
  | 'reload-pending';

interface V2PreloadRecoveryDecisionInput {
  buildId: string;
  hasStableRoute: boolean;
  lastReloadedBuildId: string | null;
}

interface InstallV2PreloadRecoveryOptions {
  buildId: string;
  hasStableRoute: () => boolean;
  onRepeatedBootFailure: (error: unknown) => void;
}

interface VitePreloadErrorEvent extends Event {
  payload?: unknown;
}

let pendingReloadBuildId: string | null = null;

export function decideV2PreloadRecovery(
  input: V2PreloadRecoveryDecisionInput
): V2PreloadRecoveryAction {
  if (input.hasStableRoute) return 'defer-to-router';
  return input.lastReloadedBuildId === input.buildId ? 'show-degraded' : 'reload-once';
}

export function recoverV2PreloadFailure(
  error: unknown,
  options: InstallV2PreloadRecoveryOptions
): V2PreloadFailureRecoveryResult {
  if (!isV2PreloadFailure(error)) return 'not-preload-failure';
  return runV2PreloadRecovery(error, options);
}

export function installV2PreloadRecovery(options: InstallV2PreloadRecoveryOptions) {
  const handlePreloadError = (rawEvent: Event) => {
    const event = rawEvent as VitePreloadErrorEvent;
    const error = event.payload ?? new Error('页面资源加载失败。');
    const action = runV2PreloadRecovery(error, options);

    if (action === 'defer-to-router') {
      // Keep the rejection intact: Vue Router owns real navigation errors, while
      // speculative intent prefetch callers swallow their own rejected promise.
      return;
    }

    event.preventDefault();
  };

  window.addEventListener('vite:preloadError', handlePreloadError);
  return () => window.removeEventListener('vite:preloadError', handlePreloadError);
}

function runV2PreloadRecovery(
  error: unknown,
  options: InstallV2PreloadRecoveryOptions
): Exclude<V2PreloadFailureRecoveryResult, 'not-preload-failure'> {
  const lastReloadedBuildId = readReloadedBuildId();
  const action = decideV2PreloadRecovery({
    buildId: options.buildId,
    hasStableRoute: options.hasStableRoute(),
    lastReloadedBuildId
  });

  if (action === 'defer-to-router') return action;
  if (action === 'show-degraded' && pendingReloadBuildId === options.buildId) {
    return 'reload-pending';
  }
  if (action === 'reload-once' && rememberReloadedBuildId(options.buildId)) {
    pendingReloadBuildId = options.buildId;
    window.location.reload();
    return action;
  }

  options.onRepeatedBootFailure(error);
  return 'show-degraded';
}

function isV2PreloadFailure(reason: unknown) {
  const message = getErrorMessage(reason).toLowerCase();
  if (!message) return false;
  return (
    message.includes('failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('importing a module script failed') ||
    message.includes('unable to preload css')
  );
}

function readReloadedBuildId() {
  try {
    return sessionStorage.getItem(PRELOAD_RELOAD_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberReloadedBuildId(buildId: string) {
  try {
    sessionStorage.setItem(PRELOAD_RELOAD_STORAGE_KEY, buildId);
    return true;
  } catch {
    return false;
  }
}

function getErrorMessage(reason: unknown) {
  if (typeof reason === 'string') return reason;
  if (!reason || typeof reason !== 'object' || !('message' in reason)) return '';
  const message = reason.message;
  return typeof message === 'string' ? message : '';
}
