import { effectScope } from 'vue';
import { describe, expect, it } from 'vitest';
import { useV2LatestRequest } from './useV2LatestRequest';

describe('useV2LatestRequest', () => {
  it('aborts the previous request and only accepts the latest request', () => {
    const scope = effectScope();
    const latest = scope.run(useV2LatestRequest);
    if (!latest) return;

    const first = latest.begin();
    const second = latest.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);

    second.finish();
    expect(second.isCurrent()).toBe(false);
    scope.stop();
  });

  it('aborts the active request when its owner scope is disposed', () => {
    const scope = effectScope();
    const latest = scope.run(useV2LatestRequest);
    if (!latest) return;

    const request = latest.begin();
    scope.stop();

    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
  });
});
