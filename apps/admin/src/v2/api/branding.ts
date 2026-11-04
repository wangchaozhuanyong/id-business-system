import type { UpdateV2BrandingSettingsInput, V2BrandingSettings } from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';

export const idBusinessV2BrandingApi = {
  getPublic(options: ApiRequestOptions = {}) {
    return request<V2BrandingSettings>(
      http.get('/id-business-v2/branding/public', { signal: options.signal })
    );
  },
  get(options: ApiRequestOptions = {}) {
    return request<V2BrandingSettings>(
      http.get('/id-business-v2/branding', { signal: options.signal })
    );
  },
  async update(input: UpdateV2BrandingSettingsInput & { expectedUpdatedAt: string }) {
    // Resolve write-only code before sending the command: chunk failure must not disguise a committed save.
    const { invalidateV2Queries } = await import('@/v2/composables/useV2Query');
    const result = await request<V2BrandingSettings>(http.patch('/id-business-v2/branding', input));
    invalidateV2Queries('branding');
    return result;
  }
};
