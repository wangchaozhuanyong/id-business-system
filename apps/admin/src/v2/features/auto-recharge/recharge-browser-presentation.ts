import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import type { V2RechargeBitBrowserSettings } from './contracts';
export const rechargeLanguages = [
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁体中文', value: 'zh-TW' },
  { label: '英语（美国）', value: 'en-US' },
  { label: '英语（英国）', value: 'en-GB' },
  { label: '马来语', value: 'ms-MY' },
  { label: '日语', value: 'ja-JP' },
  { label: '韩语', value: 'ko-KR' },
  { label: '德语', value: 'de-DE' },
  { label: '法语', value: 'fr-FR' },
  { label: '西班牙语', value: 'es-ES' }
];
export function browserSettingsSummary(settings?: V2RechargeBitBrowserSettings) {
  const options = settings?.browserOptions ?? V2_RECHARGE_BROWSER_DEFAULTS;
  const language = (fromIp: boolean, value: string) =>
    fromIp
      ? '跟随 IP'
      : (rechargeLanguages.find((item) => item.value === value)?.label ?? '指定语言');
  return {
    proxy: `${options.proxyMode === 'static' ? '固定代理' : '动态提取'} · ${settings?.proxyType.toUpperCase() ?? 'HTTP'} · ${options.proxyMode === 'static' ? `${options.staticHost}:${options.staticPort}` : settings?.dynamicProxyUrlMask || '尚未配置代理链接'}`,
    languages: `浏览器：${language(options.languageFromIp, options.language)} · 界面：${language(options.displayLanguageFromIp, options.displayLanguage)}`
  };
}
