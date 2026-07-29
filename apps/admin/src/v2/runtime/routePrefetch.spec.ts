import { describe, expect, it } from 'vitest';
import {
  getV2PrefetchDelay,
  V2_FOCUS_PREFETCH_DELAY_MS,
  V2_HOVER_PREFETCH_DELAY_MS
} from './routePrefetch';

const baseInput = {
  currentPath: '/v2/orders',
  targetPath: '/v2/customers',
  documentVisible: true,
  online: true
};

describe('V2 intent prefetch policy', () => {
  it('uses a cancellable delay for hover and keyboard focus intent', () => {
    expect(getV2PrefetchDelay({ ...baseInput, intent: 'hover', pointerType: 'mouse' })).toBe(
      V2_HOVER_PREFETCH_DELAY_MS
    );
    expect(getV2PrefetchDelay({ ...baseInput, intent: 'focus' })).toBe(V2_FOCUS_PREFETCH_DELAY_MS);
  });

  it('starts immediately only when a pointer is committing navigation', () => {
    expect(getV2PrefetchDelay({ ...baseInput, intent: 'pointerdown', pointerType: 'touch' })).toBe(
      0
    );
  });

  it('does not speculate for the current page, hidden tabs, offline or constrained networks', () => {
    expect(
      getV2PrefetchDelay({
        ...baseInput,
        intent: 'hover',
        targetPath: '/v2/orders?tab=all'
      })
    ).toBeNull();
    expect(
      getV2PrefetchDelay({ ...baseInput, intent: 'hover', documentVisible: false })
    ).toBeNull();
    expect(getV2PrefetchDelay({ ...baseInput, intent: 'hover', online: false })).toBeNull();
    expect(
      getV2PrefetchDelay({
        ...baseInput,
        intent: 'hover',
        connection: { saveData: true }
      })
    ).toBeNull();
    expect(
      getV2PrefetchDelay({
        ...baseInput,
        intent: 'focus',
        connection: { effectiveType: '2g' }
      })
    ).toBeNull();
    expect(getV2PrefetchDelay({ ...baseInput, intent: 'hover', pointerType: 'touch' })).toBeNull();
  });
});
