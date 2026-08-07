import type { IsoDateTimeString } from './common.js';

export const V2_BRANDING_LIMITS = {
  appName: 80,
  logoText: 12,
  logoUrl: 2048,
  appSubtitle: 120,
  loginHeroTitle: 160,
  loginNote: 180,
  footerText: 160,
  documentTitleSuffix: 80
} as const;

export interface V2BrandingSettings {
  appName: string;
  logoText: string;
  logoUrl: string;
  appSubtitle: string;
  loginHeroTitle: string;
  loginNote: string;
  footerText: string;
  documentTitleSuffix: string;
  updatedByUserId: string | null;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
}

export type UpdateV2BrandingSettingsInput = Pick<
  V2BrandingSettings,
  | 'appName'
  | 'logoText'
  | 'logoUrl'
  | 'appSubtitle'
  | 'loginHeroTitle'
  | 'loginNote'
  | 'footerText'
  | 'documentTitleSuffix'
>;

export const V2_BRANDING_DEFAULTS: UpdateV2BrandingSettingsInput = {
  appName: 'ID 业务管理',
  logoText: 'ID',
  logoUrl: '/brand/default-logo.svg',
  appSubtitle: 'Apple ID 订阅运营',
  loginHeroTitle: '把订单、余额与续费\n收进一条安全动线',
  loginNote: '内部后台仅限授权人员访问，登录后继续处理订单与财务任务。',
  footerText: '© 2026 Apple 内部系统 · 仅限授权人员访问',
  documentTitleSuffix: 'ID 业务管理'
};

export function splitV2BrandingHeroTitle(title: string): string[] {
  const lines = title
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : splitV2BrandingHeroTitle(V2_BRANDING_DEFAULTS.loginHeroTitle);
}
