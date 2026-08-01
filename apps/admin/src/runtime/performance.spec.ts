import { afterEach, describe, expect, it } from 'vitest';
import {
  beginV2RoutePerformance,
  markV2RouteCodeReady,
  markV2RouteDataError,
  markV2RouteDataReady
} from './performance';

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe('V2 navigation performance lifecycle', () => {
  it('separates route code readiness from successful business data readiness', () => {
    beginV2RoutePerformance('/v2/orders?keyword=private');
    expect(markV2RouteCodeReady('/v2/orders', 'orders')).toBe(true);
    expect(markV2RouteDataReady('orders', 'network')).toBe(true);

    const codeMark = performance.getEntriesByName('v2:route-code-ready').at(-1) as PerformanceMark;
    const dataMark = performance.getEntriesByName('v2:route-data-ready').at(-1) as PerformanceMark;
    expect(codeMark.detail).toMatchObject({ path: '/v2/orders', moduleKey: 'orders' });
    expect(dataMark.detail).toMatchObject({
      path: '/v2/orders',
      moduleKey: 'orders',
      source: 'network',
      outcome: 'ready'
    });
    expect(performance.getEntriesByName('v2:route-code-duration')).toHaveLength(1);
    expect(performance.getEntriesByName('v2:route-data-duration')).toHaveLength(1);
    expect(performance.getEntriesByName('v2:route-code-to-data-duration')).toHaveLength(1);
  });

  it('ignores a late response from the previous route and settles each navigation once', () => {
    beginV2RoutePerformance('/v2/orders');
    markV2RouteCodeReady('/v2/orders', 'orders');
    beginV2RoutePerformance('/v2/customers');
    markV2RouteCodeReady('/v2/customers', 'customers');

    expect(markV2RouteDataReady('orders', 'network')).toBe(false);
    expect(markV2RouteDataReady('customers', 'memory-cache')).toBe(true);
    expect(markV2RouteDataError('customers')).toBe(false);
  });

  it('records an initial data error without reporting the route as data ready', () => {
    beginV2RoutePerformance('/v2/options');
    markV2RouteCodeReady('/v2/options', 'options');

    expect(markV2RouteDataError('options')).toBe(true);
    expect(performance.getEntriesByName('v2:route-data-ready')).toHaveLength(0);
    expect(performance.getEntriesByName('v2:route-data-error')).toHaveLength(1);
  });

  it('flushes data that becomes ready before Vue Router reports code readiness', () => {
    beginV2RoutePerformance('/v2/dashboard');

    expect(markV2RouteDataReady('dashboard', 'network')).toBe(true);
    expect(performance.getEntriesByName('v2:route-data-ready')).toHaveLength(0);
    expect(markV2RouteCodeReady('/v2/dashboard', 'dashboard')).toBe(true);

    const codeMark = performance.getEntriesByName('v2:route-code-ready').at(-1) as
      | PerformanceMark
      | undefined;
    const dataMark = performance.getEntriesByName('v2:route-data-ready').at(-1) as
      | PerformanceMark
      | undefined;
    expect(codeMark).toBeTruthy();
    expect(dataMark).toBeTruthy();
    expect(dataMark?.startTime).toBeGreaterThanOrEqual(codeMark?.startTime ?? 0);
    expect(dataMark?.detail).toMatchObject({
      path: '/v2/dashboard',
      moduleKey: 'dashboard',
      source: 'network',
      outcome: 'ready'
    });
  });
});
