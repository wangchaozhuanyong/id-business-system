import { describe, expect, it } from 'vitest';
import { resolveV2AsyncRegionState, shouldDeferV2RefreshFeedback } from './asyncRegionState';

describe('V2 async region state', () => {
  it.each([
    [{ forbidden: true, resolved: true, error: 'ignored', empty: true }, 'forbidden'],
    [{ forbidden: false, resolved: false, error: '', empty: false }, 'initial-loading'],
    [{ forbidden: false, resolved: false, error: 'failed', empty: false }, 'initial-error'],
    [{ forbidden: false, resolved: true, error: '', empty: true }, 'empty'],
    [{ forbidden: false, resolved: true, error: 'refresh failed', empty: false }, 'content']
  ] as const)('resolves mutually exclusive visual state %#', (input, expected) => {
    expect(resolveV2AsyncRegionState(input)).toBe(expected);
  });

  it('defers refresh feedback only when successful content is already visible', () => {
    expect(shouldDeferV2RefreshFeedback(true, true)).toBe(true);
    expect(shouldDeferV2RefreshFeedback(true, false)).toBe(false);
    expect(shouldDeferV2RefreshFeedback(false, true)).toBe(false);
  });
});
