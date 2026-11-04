import { beforeEach, expect, it, vi } from 'vitest';
import { V2_BRANDING_DEFAULTS } from '@apple-business/shared';

const mocks = vi.hoisted(() => ({ patch: vi.fn(), invalidate: vi.fn(), events: [] as string[] }));
vi.mock('@/api/client', () => ({
  http: { patch: mocks.patch },
  request: <T>(promise: Promise<T>) => promise
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.patch.mockImplementation(async () => {
    mocks.events.push('save');
    return V2_BRANDING_DEFAULTS;
  });
});
const input = { ...V2_BRANDING_DEFAULTS, expectedUpdatedAt: 'original-version' };

it('does not send a save if its deferred write dependency cannot load', async () => {
  vi.doMock('@/v2/composables/useV2Query', () => {
    throw new Error('isolated chunk failure');
  });
  const { idBusinessV2BrandingApi } = await import('./branding');
  await expect(idBusinessV2BrandingApi.update(input)).rejects.toThrow();
  expect(mocks.patch).not.toHaveBeenCalled();
});
it('loads the dependency before saving and invalidates only after successful persistence', async () => {
  vi.doMock('@/v2/composables/useV2Query', () => {
    mocks.events.push('load');
    return { invalidateV2Queries: mocks.invalidate };
  });
  const { idBusinessV2BrandingApi } = await import('./branding');
  mocks.patch.mockRejectedValueOnce(new Error('isolated save failure'));
  await expect(idBusinessV2BrandingApi.update(input)).rejects.toThrow('isolated save failure');
  expect(mocks.invalidate).not.toHaveBeenCalled();
  await idBusinessV2BrandingApi.update(input);
  expect(mocks.events).toEqual(['load', 'save']);
  expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('branding');
});
