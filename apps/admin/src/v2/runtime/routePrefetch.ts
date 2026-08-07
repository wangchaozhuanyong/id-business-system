import type { V2RoutePrefetchIntent } from '@/runtime/performance';

export const V2_HOVER_PREFETCH_DELAY_MS = 80;
export const V2_FOCUS_PREFETCH_DELAY_MS = 60;

interface V2PrefetchConnection {
  effectiveType?: string;
  saveData?: boolean;
}

interface V2PrefetchDecisionInput {
  intent: V2RoutePrefetchIntent;
  currentPath: string;
  targetPath: string;
  pointerType?: string;
  documentVisible: boolean;
  online: boolean;
  connection?: V2PrefetchConnection;
}

interface V2RoutePrefetchControllerOptions {
  currentPath: () => string;
  load: (path: string, intent: V2RoutePrefetchIntent) => Promise<unknown>;
}

interface V2NavigationFocusPrefetchOptions extends V2RoutePrefetchControllerOptions {
  linkSelector?: string;
}

export function getV2PrefetchDelay(input: V2PrefetchDecisionInput): number | null {
  if (normalizePath(input.currentPath) === normalizePath(input.targetPath)) return null;
  if (!input.documentVisible || !input.online) return null;

  const immediateNavigation = input.intent === 'pointerdown';
  if (!immediateNavigation) {
    if (input.pointerType === 'touch') return null;
    if (input.connection?.saveData) return null;
    if (['slow-2g', '2g'].includes(input.connection?.effectiveType ?? '')) return null;
  }

  if (immediateNavigation) return 0;
  if (input.intent === 'focus') return V2_FOCUS_PREFETCH_DELAY_MS;
  return V2_HOVER_PREFETCH_DELAY_MS;
}

export function createV2RoutePrefetchController(options: V2RoutePrefetchControllerOptions) {
  let timer: number | null = null;
  let pendingPath = '';
  const completedPaths = new Set<string>();
  const inFlightPaths = new Set<string>();

  function schedule(path: string, intent: V2RoutePrefetchIntent, pointerType?: string) {
    const normalizedPath = normalizePath(path);
    if (completedPaths.has(normalizedPath) || inFlightPaths.has(normalizedPath)) return;

    const delay = getV2PrefetchDelay({
      intent,
      currentPath: options.currentPath(),
      targetPath: normalizedPath,
      pointerType,
      documentVisible: document.visibilityState === 'visible',
      online: navigator.onLine,
      connection: getConnection()
    });
    if (delay === null) return;

    cancel();
    if (delay === 0) {
      run(normalizedPath, intent);
      return;
    }

    pendingPath = normalizedPath;
    timer = window.setTimeout(() => {
      timer = null;
      pendingPath = '';
      run(normalizedPath, intent);
    }, delay);
  }

  function cancel(path?: string) {
    if (timer === null || (path && normalizePath(path) !== pendingPath)) return;
    window.clearTimeout(timer);
    timer = null;
    pendingPath = '';
  }

  function run(path: string, intent: V2RoutePrefetchIntent) {
    if (completedPaths.has(path) || inFlightPaths.has(path)) return;
    inFlightPaths.add(path);
    void options
      .load(path, intent)
      .then(() => {
        completedPaths.add(path);
      })
      .catch(() => {
        // An intent request is speculative. A real navigation retries through Vue Router.
      })
      .finally(() => {
        inFlightPaths.delete(path);
      });
  }

  function dispose() {
    cancel();
    completedPaths.clear();
    inFlightPaths.clear();
  }

  return {
    schedule,
    cancel,
    dispose
  };
}

export function installV2NavigationFocusPrefetch(options: V2NavigationFocusPrefetchOptions) {
  const controller = createV2RoutePrefetchController(options);
  const linkSelector = options.linkSelector ?? 'a.v2-navigation__item[href]';

  function getFocusedPath(event: FocusEvent) {
    if (!(event.target instanceof Element)) return null;
    const link = event.target.closest<HTMLAnchorElement>(linkSelector);
    if (!link?.closest('.v2-navigation')) return null;
    return link.getAttribute('href');
  }

  function handleFocus(event: FocusEvent) {
    const path = getFocusedPath(event);
    if (path) controller.schedule(path, 'focus');
  }

  function handleBlur(event: FocusEvent) {
    const path = getFocusedPath(event);
    if (path) controller.cancel(path);
  }

  document.addEventListener('focus', handleFocus, true);
  document.addEventListener('blur', handleBlur, true);

  return () => {
    document.removeEventListener('focus', handleFocus, true);
    document.removeEventListener('blur', handleBlur, true);
    controller.dispose();
  };
}

function getConnection(): V2PrefetchConnection | undefined {
  return (
    navigator as Navigator & {
      connection?: V2PrefetchConnection;
    }
  ).connection;
}

function normalizePath(path: string) {
  return path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
}
