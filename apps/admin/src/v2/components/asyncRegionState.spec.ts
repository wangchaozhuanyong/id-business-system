import { describe, expect, it } from 'vitest';
import {
  resolveLegacyV2QueryPhase,
  resolveV2AsyncRegionState,
  shouldDeferV2RefreshFeedback
} from './asyncRegionState';

describe('V2 async region state', () => {
  it.each([
    [{ forbidden: true, phase: 'ready', empty: true }, 'forbidden'],
    [{ forbidden: false, phase: 'initial-loading', empty: false }, 'initial-loading'],
    [{ forbidden: false, phase: 'initial-error', empty: false }, 'initial-error'],
    [{ forbidden: false, phase: 'ready', empty: true }, 'empty'],
    [{ forbidden: false, phase: 'transitioning', empty: true }, 'content'],
    [{ forbidden: false, phase: 'refresh-error', empty: false }, 'content']
  ] as const)('resolves mutually exclusive visual state %#', (input, expected) => {
    expect(resolveV2AsyncRegionState(input)).toBe(expected);
  });

  it('defers refresh feedback only when successful content is already visible', () => {
    expect(shouldDeferV2RefreshFeedback('refreshing')).toBe(true);
    expect(shouldDeferV2RefreshFeedback('transitioning')).toBe(true);
    expect(shouldDeferV2RefreshFeedback('initial-loading')).toBe(false);
    expect(shouldDeferV2RefreshFeedback('ready')).toBe(false);
  });

  it('keeps legacy regions on the same controlled phase model during migration', () => {
    expect(resolveLegacyV2QueryPhase({ loading: true, resolved: false, error: '' })).toBe(
      'initial-loading'
    );
    expect(resolveLegacyV2QueryPhase({ loading: true, resolved: true, error: '' })).toBe(
      'refreshing'
    );
    expect(resolveLegacyV2QueryPhase({ loading: false, resolved: true, error: 'failed' })).toBe(
      'refresh-error'
    );
  });
});
