// Ported from the pinned BitBrowser implementation e51dd9c9. See README.md.
const V2_RECHARGE_BROWSER_DEFAULTS = {
  sessionWaitMinutes: 2,
  sessionRetryLimit: 9,
  proxyMode: 'dynamic',
  staticHost: '',
  staticPort: 8080,
  dynamicProvider: 'common',
  refreshIp: true,
  ipCheckService: 'ip-api',
  os: 'Win32',
  osVersion: '11',
  coreVersion: '152',
  openWidth: 1600,
  openHeight: 1_000,
  languageFromIp: false,
  language: 'zh-CN',
  displayLanguageFromIp: false,
  displayLanguage: 'zh-CN',
  timezoneFromIp: true,
  timezone: 'Asia/Shanghai',
  positionFromIp: true,
  latitude: 0,
  longitude: 0,
  accuracy: 100,
  syncTabs: false,
  syncCookies: false,
  syncLocalStorage: false
};
const V2_RECHARGE_BROWSER_PROFILE_KEYS = ['osVersion', 'coreVersion', 'openWidth', 'openHeight'];
function normalizeV2RechargeBrowserOptions(value) {
  const legacy =
    value && V2_RECHARGE_BROWSER_PROFILE_KEYS.every((key) => !Object.hasOwn(value, key));
  const options = { ...V2_RECHARGE_BROWSER_DEFAULTS, ...value };
  if (legacy) {
    options.os = 'Win32';
    options.osVersion = '11';
  } else if (options.os !== 'Win32') {
    options.osVersion = '';
  }
  return options;
}
export {
  V2_RECHARGE_BROWSER_DEFAULTS,
  V2_RECHARGE_BROWSER_PROFILE_KEYS,
  normalizeV2RechargeBrowserOptions
};
