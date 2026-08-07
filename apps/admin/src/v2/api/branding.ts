import type { UpdateV2BrandingSettingsInput, V2BrandingSettings } from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';
import { invalidateV2Queries } from '@/v2/composables/useV2Query';

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
  async update(input: UpdateV2BrandingSettingsInput) {
    const result = await request<V2BrandingSettings>(http.patch('/id-business-v2/branding', input));
    invalidateV2Queries('branding');
    return result;
  }
};
