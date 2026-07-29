const PRELOAD_RELOAD_STORAGE_KEY = 'apple-business:v2-preload-reload-build';

export type V2PreloadRecoveryAction = 'defer-to-router' | 'reload-once' | 'show-degraded';

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

export function decideV2PreloadRecovery(
  input: V2PreloadRecoveryDecisionInput
): V2PreloadRecoveryAction {
  if (input.hasStableRoute) return 'defer-to-router';
  return input.lastReloadedBuildId === input.buildId ? 'show-degraded' : 'reload-once';
}

export function installV2PreloadRecovery(options: InstallV2PreloadRecoveryOptions) {
  const handlePreloadError = (rawEvent: Event) => {
    const event = rawEvent as VitePreloadErrorEvent;

    const lastReloadedBuildId = readReloadedBuildId();
    const action = decideV2PreloadRecovery({
      buildId: options.buildId,
      hasStableRoute: options.hasStableRoute(),
      lastReloadedBuildId
    });
    const error = event.payload ?? new Error('页面资源加载失败。');

    if (action === 'defer-to-router') {
      // Keep the rejection intact: Vue Router owns real navigation errors, while
      // speculative intent prefetch callers swallow their own rejected promise.
      return;
    }

    event.preventDefault();
    if (action === 'reload-once' && rememberReloadedBuildId(options.buildId)) {
      window.location.reload();
      return;
    }

    options.onRepeatedBootFailure(error);
  };

  window.addEventListener('vite:preloadError', handlePreloadError);
  return () => window.removeEventListener('vite:preloadError', handlePreloadError);
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
