import { describe, expect, it } from 'vitest';
import { createRenderer, h, nextTick, ref, ssrContextKey, type Component } from 'vue';
import {
  normalizeV2RechargeBrowserOptions,
  V2_RECHARGE_BROWSER_DEFAULTS,
  V2_RECHARGE_BROWSER_PROFILE_KEYS,
  type V2RechargeBrowserOptions
} from '@apple-business/shared';
import RechargeWindowOptions from './RechargeWindowOptions.vue';
import {
  directProfileOptions,
  verifyDirectProfileConfiguration,
  type DirectBrowserSettings
} from './bitbrowser-direct-api';
import { browserSettingsSummary } from './recharge-browser-presentation';
import { failureReasonLabel } from './recharge-presentation';

const settings: DirectBrowserSettings = {
  localApiUrl: 'http://127.0.0.1:54345',
  localApiToken: 'fixture-api-token',
  groupName: '分组',
  tagName: '标签',
  proxyType: 'http',
  dynamicProxyUrl: 'https://proxy.example/extract'
};

function mountWindowOptions(initial: V2RechargeBrowserOptions) {
  const model = ref(initial);
  // Exercise the actual component watcher without depending on browser layout.
  const renderer = createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    patchProp: () => {},
    parentNode: () => null,
    nextSibling: () => null
  });
  // Vitest compiles SFCs for SSR; retain the real setup while omitting the layout.
  const component = { ...RechargeWindowOptions, render: () => null } as Component;
  const app = renderer.createApp({ setup: () => () => h(component, { modelValue: model.value }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  return { model, unmount: () => app.unmount() };
}

describe('比特窗口系统、内核与尺寸配置', () => {
  it.each(['10', '11'] as const)(
    '读回已保存的 Windows %s 时不被默认版本覆盖',
    async (osVersion) => {
      const mounted = mountWindowOptions({
        ...V2_RECHARGE_BROWSER_DEFAULTS,
        os: 'MacIntel',
        osVersion: ''
      });
      const saved = { ...V2_RECHARGE_BROWSER_DEFAULTS, osVersion, openWidth: 1800 };
      try {
        mounted.model.value = { ...saved };
        await nextTick();
        expect(mounted.model.value).toEqual(saved);
      } finally {
        mounted.unmount();
      }
    }
  );

  it('手动切换到 Windows 时补默认版本，切换其它系统时清理 Windows 版本', async () => {
    const mounted = mountWindowOptions({
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      os: 'MacIntel',
      osVersion: ''
    });
    try {
      mounted.model.value.os = 'Win32';
      await nextTick();
      expect(mounted.model.value.osVersion).toBe('11');
      mounted.model.value.os = 'Linux x86_64';
      await nextTick();
      expect(mounted.model.value.osVersion).toBe('');
    } finally {
      mounted.unmount();
    }
  });

  it('默认请求 Windows 11、指定内核和大窗口，并由客户端生成匹配的标识', () => {
    const result = directProfileOptions(settings);
    expect(result.browserFingerPrint).toMatchObject({
      coreProduct: 'chrome',
      coreVersion: '152',
      version: '152',
      userAgent: '',
      os: 'Win32',
      osVersion: '11',
      openWidth: 1600,
      openHeight: 1000
    });
    expect(result).toMatchObject({
      syncTabs: false,
      syncCookies: false,
      syncLocalStorage: false,
      syncIndexedDb: false,
      syncAuthorization: false
    });
  });

  it('旧 Mac 配置归一为 Windows，不覆盖代理地区，不修改原始保存对象', () => {
    const legacy = {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      os: 'MacIntel' as const,
      language: 'en-US',
      staticHost: 'proxy.example'
    };
    for (const key of V2_RECHARGE_BROWSER_PROFILE_KEYS)
      delete (legacy as Partial<typeof legacy>)[key];
    const original = { ...legacy };
    const result = normalizeV2RechargeBrowserOptions(legacy);
    expect(result).toMatchObject({
      os: 'Win32',
      osVersion: '11',
      coreVersion: '152',
      openWidth: 1600,
      openHeight: 1000,
      language: 'en-US',
      staticHost: 'proxy.example'
    });
    expect(legacy).toEqual(original);
    expect(
      directProfileOptions({ ...settings, browserOptions: legacy }).browserFingerPrint.os
    ).toBe('Win32');
  });

  it.each(['MacIntel', 'Linux x86_64'] as const)('新版显式选择 %s 和其它尺寸时保留', (os) => {
    const browserOptions = {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      os,
      osVersion: '' as const,
      coreVersion: '150',
      openWidth: 1800,
      openHeight: 1100
    };
    expect(normalizeV2RechargeBrowserOptions(browserOptions)).toEqual(browserOptions);
    expect(directProfileOptions({ ...settings, browserOptions }).browserFingerPrint).toMatchObject({
      os,
      osVersion: '',
      coreVersion: '150',
      version: '150',
      userAgent: '',
      openWidth: 1800,
      openHeight: 1100
    });
    expect(() =>
      verifyDirectProfileConfiguration(
        { browserFingerPrint: { os, osVersion: '14.4' } },
        { ...settings, browserOptions }
      )
    ).not.toThrow();
  });

  it('设置摘要显示归一后的系统、内核和窗口尺寸', () => {
    expect(browserSettingsSummary().profile).toBe('Windows 11 · 内核 152 · 窗口 1600 × 1000');
  });

  it('兼容旧客户端缺少指纹读回字段，但不把缺失作为已确认', () => {
    expect(() => verifyDirectProfileConfiguration({}, settings)).not.toThrow();
    expect(() =>
      verifyDirectProfileConfiguration({ browserFingerPrint: {} }, settings, {})
    ).not.toThrow();
    expect(() =>
      verifyDirectProfileConfiguration(
        { browserFingerPrint: directProfileOptions(settings).browserFingerPrint },
        settings,
        { coreVersion: '152.0.0' }
      )
    ).not.toThrow();
    expect(() =>
      verifyDirectProfileConfiguration(
        { browserFingerPrint: { coreVersion: '152.0.0', version: '152.0.0.0' } },
        settings
      )
    ).not.toThrow();
  });

  it.each([
    { coreVersion: '130' },
    { os: 'MacIntel' },
    { osVersion: '10' },
    { version: '130' },
    { openWidth: 1280 },
    { openHeight: 720 },
    { coreProduct: 'firefox' }
  ])('客户端明确回传不同配置时停止：%j', (browserFingerPrint) => {
    expect(() => verifyDirectProfileConfiguration({ browserFingerPrint }, settings)).toThrow(
      '与所选配置不一致'
    );
  });

  it('打开时客户端回传其它内核会失败，错误通过中文受控文案显示', () => {
    expect(() => verifyDirectProfileConfiguration({}, settings, { coreVersion: '130' })).toThrow(
      '与所选配置不一致'
    );
    expect(failureReasonLabel('bitbrowser_profile_configuration_mismatch')).toContain(
      '与所选配置不一致'
    );
    expect(() =>
      verifyDirectProfileConfiguration(
        { browserFingerPrint: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0' } },
        settings
      )
    ).toThrow('与所选配置不一致');
    expect(failureReasonLabel('bitbrowser_profile_configuration_unverified')).toContain('无法确认');
  });
});
