import { describe, expect, it, vi } from 'vitest';
import { NavigationFailureType, type Router } from 'vue-router';
import { navigateSafely } from './navigateSafely';

function createRouter(navigate: () => Promise<unknown>) {
  return {
    currentRoute: { value: { fullPath: '/current' } },
    push: navigate,
    replace: navigate,
    resolve: () => ({ fullPath: '/target' })
  } as unknown as Router;
}

describe('navigateSafely', () => {
  it('resolves successful navigation without leaking a promise rejection', async () => {
    await expect(
      navigateSafely(createRouter(vi.fn().mockResolvedValue(undefined)), '/target')
    ).resolves.toBe(true);
  });

  it('consumes expected navigation failures', async () => {
    const failure = Object.assign(new Error('aborted'), {
      type: NavigationFailureType.aborted,
      from: {},
      to: {}
    });
    await expect(
      navigateSafely(createRouter(vi.fn().mockRejectedValue(failure)), '/target')
    ).resolves.toBe(false);
  });

  it('detects navigation failures resolved by Vue Router', async () => {
    const failure = Object.assign(new Error('duplicated'), {
      type: NavigationFailureType.duplicated,
      from: {},
      to: {}
    });

    await expect(
      navigateSafely(createRouter(vi.fn().mockResolvedValue(failure)), '/target', 'replace')
    ).resolves.toBe(false);
  });

  it('routes unexpected loader errors to the route resource boundary', async () => {
    await expect(
      navigateSafely(createRouter(vi.fn().mockRejectedValue(new Error('chunk failed'))), '/target')
    ).resolves.toBe(false);
  });
});
