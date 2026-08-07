import { computed, readonly, ref } from 'vue';
import {
  V2_BRANDING_DEFAULTS,
  splitV2BrandingHeroTitle,
  type UpdateV2BrandingSettingsInput,
  type V2BrandingSettings
} from '@apple-business/shared';
import type { ApiRequestOptions } from '@/api/client';
import { idBusinessV2BrandingApi } from '@/v2/api/branding';

interface BrandingLoadOptions extends ApiRequestOptions {
  force?: boolean;
}

const brandingState = ref<V2BrandingSettings>(createDefaultBrandingSettings());
const hasLoaded = ref(false);
let loadingPromise: Promise<V2BrandingSettings> | null = null;

export const v2Branding = readonly(brandingState);
export const v2BrandingHeroTitleLines = computed(() =>
  splitV2BrandingHeroTitle(brandingState.value.loginHeroTitle)
);

export function getV2BrandingSnapshot() {
  return brandingState.value;
}

export function formatV2DocumentTitle(pageTitle: unknown) {
  const title = String(pageTitle || '').trim() || '工作台';
  const suffix =
    brandingState.value.documentTitleSuffix.trim() || V2_BRANDING_DEFAULTS.documentTitleSuffix;
  return title === suffix ? suffix : `${title} - ${suffix}`;
}

export async function loadV2Branding(options: BrandingLoadOptions = {}) {
  if (!options.force && hasLoaded.value) return brandingState.value;
  if (loadingPromise) return loadingPromise;

  loadingPromise = idBusinessV2BrandingApi
    .getPublic({ signal: options.signal })
    .then((settings) => {
      setV2Branding(settings);
      hasLoaded.value = true;
      return brandingState.value;
    })
    .finally(() => {
      loadingPromise = null;
    });

  return loadingPromise;
}

export function setV2Branding(settings: V2BrandingSettings) {
  brandingState.value = normalizeBrandingSettings(settings);
}

export function createV2BrandingFormInput(): UpdateV2BrandingSettingsInput {
  const settings = brandingState.value;
  return {
    appName: settings.appName,
    logoText: settings.logoText,
    logoUrl: settings.logoUrl,
    appSubtitle: settings.appSubtitle,
    loginHeroTitle: settings.loginHeroTitle,
    loginNote: settings.loginNote,
    footerText: settings.footerText,
    documentTitleSuffix: settings.documentTitleSuffix
  };
}

export function useV2Branding() {
  return {
    branding: v2Branding,
    heroTitleLines: v2BrandingHeroTitleLines,
    hasLoaded,
    loadBranding: loadV2Branding,
    setBranding: setV2Branding
  };
}

function createDefaultBrandingSettings(): V2BrandingSettings {
  return {
    ...V2_BRANDING_DEFAULTS,
    updatedByUserId: null,
    createdAt: '',
    updatedAt: ''
  };
}

function normalizeBrandingSettings(settings: V2BrandingSettings): V2BrandingSettings {
  const defaults = createDefaultBrandingSettings();
  return {
    appName: normalizeText(settings.appName, defaults.appName),
    logoText: normalizeText(settings.logoText, defaults.logoText),
    logoUrl: normalizeText(settings.logoUrl, defaults.logoUrl),
    appSubtitle: normalizeText(settings.appSubtitle, defaults.appSubtitle),
    loginHeroTitle: normalizeText(settings.loginHeroTitle, defaults.loginHeroTitle),
    loginNote: normalizeText(settings.loginNote, defaults.loginNote),
    footerText: normalizeText(settings.footerText, defaults.footerText),
    documentTitleSuffix: normalizeText(settings.documentTitleSuffix, defaults.documentTitleSuffix),
    updatedByUserId: settings.updatedByUserId ?? null,
    createdAt: settings.createdAt || '',
    updatedAt: settings.updatedAt || ''
  };
}

function normalizeText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}
