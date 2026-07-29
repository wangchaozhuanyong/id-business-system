export type AppPerformanceMark =
  | 'v2:entry-evaluated'
  | 'v2:app-mounted'
  | 'v2:auth-check-start'
  | 'v2:auth-check-end'
  | 'v2:route-start'
  | 'v2:route-code-ready'
  | 'v2:route-data-ready'
  | 'v2:route-data-error'
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
}

interface V2PerformanceDetail {
  navigationId?: number;
  path?: string;
  moduleKey?: string | null;
  source?: V2RouteDataSource;
  outcome?: 'ready' | 'error';
  intent?: V2RoutePrefetchIntent;
}

let navigationSequence = 0;
let activeNavigation: V2NavigationPerformanceState | null = null;

export function markAppPerformance(name: AppPerformanceMark, detail?: V2PerformanceDetail) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  try {
    performance.mark(name, detail ? { detail } : undefined);
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
  if (
    !performance.getEntriesByName(startMark).length ||
    !performance.getEntriesByName(endMark).length
  ) {
    return;
  }

  try {
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

  activeNavigation.moduleKey = moduleKey ?? null;
  activeNavigation.codeReady = true;
  const detail = navigationDetail(activeNavigation);
  markAppPerformance('v2:route-code-ready', detail);
  measureAppPerformance('v2:route-code-duration', 'v2:route-start', 'v2:route-code-ready', detail);
  return true;
}

export function markV2RouteDataReady(moduleKey: string, source: V2RouteDataSource) {
  const navigation = activeNavigation;
  if (
    !navigation ||
    !navigation.codeReady ||
    navigation.dataSettled ||
    navigation.moduleKey !== moduleKey
  ) {
    return false;
  }

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
  return true;
}

export function markV2RouteDataError(moduleKey: string) {
  const navigation = activeNavigation;
  if (
    !navigation ||
    !navigation.codeReady ||
    navigation.dataSettled ||
    navigation.moduleKey !== moduleKey
  ) {
    return false;
  }

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
