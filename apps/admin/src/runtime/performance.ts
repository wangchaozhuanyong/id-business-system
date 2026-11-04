export type AppPerformanceMark =
  | 'v2:entry-evaluated'
  | 'v2:app-mounted'
  | 'v2:auth-check-start'
  | 'v2:auth-check-end'
  | 'v2:route-start'
  | 'v2:route-code-ready'
  | 'v2:route-data-ready'
  | 'v2:route-data-error'
  | 'v2:route-paint-ready'
  | 'v2:route-prefetch-start'
  | 'v2:route-prefetch-ready'
  | 'v2:route-prefetch-error';

export type V2RouteDataSource = 'memory-cache' | 'network';
export type V2RoutePrefetchIntent = 'hover' | 'focus' | 'pointerdown' | 'search';

interface V2NavigationPerformanceState {
  id: number;
  path: string;
  moduleKey: string | null;
  codeReady: boolean;
  dataSettled: boolean;
  primaryOwner?: object;
  paintReady?: boolean;
  pendingData?: {
    outcome: 'ready' | 'error';
    source?: V2RouteDataSource;
  };
}

interface V2PerformanceDetail {
  navigationId?: number;
  path?: string;
  moduleKey?: string | null;
  source?: V2RouteDataSource;
  outcome?: 'ready' | 'error';
  intent?: V2RoutePrefetchIntent;
}

// Keep navigation telemetry bounded without copying an ever-growing Performance timeline.
const timelineCounts = new Map<string, number>();
const recordedMarks = new Set<AppPerformanceMark>();
function trimPerformanceTimeline(name: string, kind: 'mark' | 'measure') {
  const count = timelineCounts.get(name) ?? 0;
  if (count >= 120) {
    if (kind === 'mark') performance.clearMarks(name);
    else performance.clearMeasures(name);
  }
  timelineCounts.set(name, count >= 120 ? 1 : count + 1);
}

let navigationSequence = 0;
let activeNavigation: V2NavigationPerformanceState | null = null;
export interface V2RoutePresentation {
  navigationId: number;
  moduleKey: string;
  source: V2RouteDataSource;
}
const presentationListeners = new Set<(event: V2RoutePresentation) => void | Promise<void>>();

export function subscribeV2RoutePresentation(
  listener: (event: V2RoutePresentation) => void | Promise<void>
) {
  presentationListeners.add(listener);
  return () => {
    presentationListeners.delete(listener);
  };
}

export function claimV2RoutePerformance(moduleKey: string, path: string, owner: object) {
  const navigation = activeNavigation;
  if (!navigation || navigation.path !== normalizeRoutePath(path)) return undefined;
  if (navigation.primaryOwner && navigation.primaryOwner !== owner) return undefined;
  navigation.primaryOwner = owner;
  return navigation.id;
}

export function isV2RoutePerformanceCurrent(navigationId: number, moduleKey: string) {
  return activeNavigation?.id === navigationId && activeNavigation.moduleKey === moduleKey;
}

export function markV2RoutePaintReady(event: V2RoutePresentation) {
  const navigation = activeNavigation;
  if (
    !navigation ||
    !isV2RoutePerformanceCurrent(event.navigationId, event.moduleKey) ||
    navigation.paintReady ||
    !navigation.dataSettled
  )
    return false;
  navigation.paintReady = true;
  const detail = { ...navigationDetail(navigation), source: event.source };
  markAppPerformance('v2:route-paint-ready', detail);
  measureAppPerformance(
    'v2:route-paint-duration',
    'v2:route-start',
    'v2:route-paint-ready',
    detail
  );
  measureAppPerformance(
    'v2:route-data-to-paint-duration',
    'v2:route-data-ready',
    'v2:route-paint-ready',
    detail
  );
  return true;
}

export function markAppPerformance(name: AppPerformanceMark, detail?: V2PerformanceDetail) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  try {
    trimPerformanceTimeline(name, 'mark');
    performance.mark(name, detail ? { detail } : undefined);
    recordedMarks.add(name);
  } catch {
    // Performance telemetry must never interrupt application startup or navigation.
  }
}

export function measureAppPerformance(
  name: string,
  startMark: AppPerformanceMark,
  endMark: AppPerformanceMark,
  detail?: V2PerformanceDetail
) {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  if (!recordedMarks.has(startMark) || !recordedMarks.has(endMark)) return;

  try {
    trimPerformanceTimeline(name, 'measure');
    performance.measure(name, {
      start: startMark,
      end: endMark,
      detail
    });
  } catch {
    // Measurements are diagnostic only and cannot become a runtime dependency.
  }
}

export function beginV2RoutePerformance(path: string) {
  const normalizedPath = normalizeRoutePath(path);
  activeNavigation = {
    id: ++navigationSequence,
    path: normalizedPath,
    moduleKey: null,
    codeReady: false,
    dataSettled: false
  };
  markAppPerformance('v2:route-start', navigationDetail(activeNavigation));
  return activeNavigation.id;
}

export function markV2RouteCodeReady(path: string, moduleKey?: string) {
  const normalizedPath = normalizeRoutePath(path);
  if (!activeNavigation || activeNavigation.path !== normalizedPath) {
    beginV2RoutePerformance(normalizedPath);
  }
  if (!activeNavigation || activeNavigation.codeReady) return false;

  const resolvedModuleKey = moduleKey ?? null;
  if (
    activeNavigation.pendingData &&
    activeNavigation.moduleKey &&
    activeNavigation.moduleKey !== resolvedModuleKey
  ) {
    activeNavigation.pendingData = undefined;
  }
  activeNavigation.moduleKey = resolvedModuleKey;
  activeNavigation.codeReady = true;
  const detail = navigationDetail(activeNavigation);
  markAppPerformance('v2:route-code-ready', detail);
  measureAppPerformance('v2:route-code-duration', 'v2:route-start', 'v2:route-code-ready', detail);
  flushPendingRouteData(activeNavigation);
  return true;
}

export function markV2RouteDataReady(
  moduleKey: string,
  source: V2RouteDataSource,
  navigationId?: number
) {
  const navigation = activeNavigation;
  if (navigationId !== undefined && navigation?.id !== navigationId) return false;
  if (!navigation || navigation.dataSettled) return false;
  if (!navigation.codeReady) return queuePendingRouteData(navigation, moduleKey, 'ready', source);
  if (navigation.moduleKey !== moduleKey) return false;

  return completeRouteDataReady(navigation, source);
}

export function markV2RouteDataError(moduleKey: string, navigationId?: number) {
  const navigation = activeNavigation;
  if (navigationId !== undefined && navigation?.id !== navigationId) return false;
  if (!navigation || navigation.dataSettled) return false;
  if (!navigation.codeReady) return queuePendingRouteData(navigation, moduleKey, 'error');
  if (navigation.moduleKey !== moduleKey) return false;

  return completeRouteDataError(navigation);
}

function queuePendingRouteData(
  navigation: V2NavigationPerformanceState,
  moduleKey: string,
  outcome: 'ready' | 'error',
  source?: V2RouteDataSource
) {
  if (navigation.moduleKey && navigation.moduleKey !== moduleKey) return false;
  navigation.moduleKey = moduleKey;
  navigation.pendingData = { outcome, source };
  return true;
}

function flushPendingRouteData(navigation: V2NavigationPerformanceState) {
  const pending = navigation.pendingData;
  navigation.pendingData = undefined;
  if (!pending || navigation.dataSettled) return;
  if (pending.outcome === 'ready' && pending.source) {
    completeRouteDataReady(navigation, pending.source);
    return;
  }
  if (pending.outcome === 'error') completeRouteDataError(navigation);
}

function completeRouteDataReady(
  navigation: V2NavigationPerformanceState,
  source: V2RouteDataSource
) {
  navigation.dataSettled = true;
  const detail = {
    ...navigationDetail(navigation),
    source,
    outcome: 'ready' as const
  };
  markAppPerformance('v2:route-data-ready', detail);
  measureAppPerformance('v2:route-data-duration', 'v2:route-start', 'v2:route-data-ready', detail);
  measureAppPerformance(
    'v2:route-code-to-data-duration',
    'v2:route-code-ready',
    'v2:route-data-ready',
    detail
  );
  for (const listener of presentationListeners) {
    try {
      void Promise.resolve(
        listener({ navigationId: navigation.id, moduleKey: navigation.moduleKey!, source })
      ).catch(() => undefined);
    } catch {
      /* Diagnostics must not affect navigation. */
    }
  }
  return true;
}

function completeRouteDataError(navigation: V2NavigationPerformanceState) {
  navigation.dataSettled = true;
  const detail = {
    ...navigationDetail(navigation),
    outcome: 'error' as const
  };
  markAppPerformance('v2:route-data-error', detail);
  measureAppPerformance(
    'v2:route-data-error-duration',
    'v2:route-start',
    'v2:route-data-error',
    detail
  );
  return true;
}

export function markV2RoutePrefetch(
  path: string,
  intent: V2RoutePrefetchIntent,
  phase: 'start' | 'ready' | 'error'
) {
  markAppPerformance(`v2:route-prefetch-${phase}`, {
    path: normalizeRoutePath(path),
    intent
  });
}

function navigationDetail(navigation: V2NavigationPerformanceState): V2PerformanceDetail {
  return {
    navigationId: navigation.id,
    path: navigation.path,
    moduleKey: navigation.moduleKey
  };
}

function normalizeRoutePath(path: string) {
  return path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
}
