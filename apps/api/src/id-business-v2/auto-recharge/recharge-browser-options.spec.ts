import { describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { validateBrowserOptions, storedBrowserOptions } from './recharge-browser-options';
import { validateRechargeBitBrowserSettings } from './recharge-settings-validation';
import { RechargeSettingsService } from './recharge-settings.service';

const operator = {
  id: 'fixture-admin',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const base = {
  connectorUrl: 'http://127.0.0.1:55321',
  localApiUrl: 'http://127.0.0.1:54345',
  groupName: '测试分组',
  tagName: '测试标签',
  proxyType: 'http'
};
const staticOptions = {
  ...V2_RECHARGE_BROWSER_DEFAULTS,
  proxyMode: 'static' as const,
  staticHost: 'proxy.example',
  staticPort: 1080,
  os: 'Win32' as const,
  syncCookies: false
};
const credentials = { username: 'fixture-user', password: 'fixture-password' };
function fixture() {
  let row: Record<string, unknown> = {
    ...base,
    updatedAt: new Date(),
    browserOptions: null,
    localApiTokenEncrypted: 'encrypted:fixture-api',
    connectorTokenEncrypted: 'encrypted:fixture-connector',
    dynamicProxyUrlEncrypted: 'encrypted:https://proxy.example/extract',
    staticProxyCredentialsEncrypted: null
  };
  const repository = {
    find: vi.fn(async () => row),
    findInTransaction: vi.fn(async () => row),
    upsert: vi.fn(async (_tx, _id, data) => (row = { ...row, ...data }))
  };
  const encryption = {
    encrypt: vi.fn((v: string) => `encrypted:${v}`),
    decrypt: vi.fn((v?: string) => v?.slice('encrypted:'.length) ?? '')
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn((work) => work({})) };
  const service = new RechargeSettingsService(
    repository as never,
    encryption as never,
    transactions as never,
    audit as never
  );
  return {
    service,
    repository,
    encryption,
    audit,
    changeRow: (data: Record<string, unknown>) => Object.assign(row, data)
  };
}

describe('窗口配置校验', () => {
  it('旧空设置回退原默认值，合法指定设置完整保留', () => {
    expect(storedBrowserOptions(null)).toEqual(V2_RECHARGE_BROWSER_DEFAULTS);
    expect(validateBrowserOptions(staticOptions)).toEqual(staticOptions);
  });
  it('旧 JSON 设置补齐等待与重试默认值', () => {
    const legacy = { ...staticOptions } as Record<string, unknown>;
    delete legacy.sessionWaitMinutes;
    delete legacy.sessionRetryLimit;
    expect(storedBrowserOptions(legacy)).toEqual(staticOptions);
    expect(
      validateBrowserOptions({ ...legacy, sessionWaitMinutes: 10, sessionRetryLimit: 0 })
    ).toMatchObject({ sessionWaitMinutes: 10, sessionRetryLimit: 0 });
  });
  it.each([
    { sessionWaitMinutes: 0 },
    { sessionWaitMinutes: 11 },
    { sessionWaitMinutes: 1.5 },
    { sessionRetryLimit: -1 },
    { sessionRetryLimit: 3 },
    { sessionRetryLimit: true },
    { proxyMode: 'direct' },
    { os: 'Android' },
    { dynamicProvider: 'other' },
    { ipCheckService: 'other' },
    { refreshIp: 'true' },
    { syncCookies: 1 },
    { staticPort: 0 },
    { staticPort: 65536 },
    { staticPort: 1.5 },
    { latitude: 91 },
    { longitude: -181 },
    { accuracy: 0 },
    { timezone: 'Invalid/Zone' },
    { timezone: '+08:00' },
    { language: 'unsafe\nvalue' },
    { staticHost: 'https://user:password@proxy.example/path' },
    { staticHost: '' },
    { userName: 'unexpected' }
  ])('拒绝非法选项 %j', (patch) => {
    expect(() => validateBrowserOptions({ ...staticOptions, ...patch })).toThrow();
  });
  it('拒绝单边凭据和清除替换冲突', () => {
    expect(() =>
      validateRechargeBitBrowserSettings({
        ...base,
        staticProxyCredentials: { username: 'fixture' }
      })
    ).toThrow();
    expect(() =>
      validateRechargeBitBrowserSettings({
        ...base,
        staticProxyCredentials: credentials,
        clearStaticProxyCredentials: true
      })
    ).toThrow();
  });
});

describe('窗口设置持久化与运行时', () => {
  it('固定模式无需动态链接，凭据只加密存储，读取与审计无明文', async () => {
    const f = fixture();
    f.changeRow({ dynamicProxyUrlEncrypted: null });
    const result = await f.service.update(
      { ...base, browserOptions: staticOptions, staticProxyCredentials: credentials },
      operator
    );
    expect(result).toMatchObject({
      browserOptions: staticOptions,
      staticProxyCredentialsConfigured: true
    });
    expect(f.repository.upsert.mock.calls[0]?.[2]).toMatchObject({
      staticProxyCredentialsEncrypted: `encrypted:${JSON.stringify(credentials)}`
    });
    const read = await f.service.get(operator);
    for (const surface of [read, result, f.audit.append.mock.calls]) {
      expect(JSON.stringify(surface)).not.toContain('fixture-password');
      expect(JSON.stringify(surface)).not.toContain('fixture-user');
    }
    const runtime = await f.service.runtime(operator.id);
    expect(runtime).toMatchObject({
      browserOptions: staticOptions,
      dynamicProxyUrl: '',
      staticProxyCredentials: credentials
    });
  });
  it('旧客户端省略窗口参数时保留自定义设置；留空保留凭据，显式清除后运行时不带认证', async () => {
    const f = fixture();
    await f.service.update(
      { ...base, browserOptions: staticOptions, staticProxyCredentials: credentials },
      operator
    );
    const kept = await f.service.update(base, operator);
    expect(kept.browserOptions).toEqual(staticOptions);
    expect(kept.staticProxyCredentialsConfigured).toBe(true);
    await f.service.update({ ...base, clearStaticProxyCredentials: true }, operator);
    expect((await f.service.runtime(operator.id)).staticProxyCredentials).toBeUndefined();
  });
  it('切回动态模式要求链接且不解密固定代理密码', async () => {
    const f = fixture();
    f.changeRow({ dynamicProxyUrlEncrypted: null, browserOptions: staticOptions });
    await expect(
      f.service.update({ ...base, browserOptions: V2_RECHARGE_BROWSER_DEFAULTS }, operator)
    ).rejects.toThrow('当前代理模式');
    expect(f.repository.upsert).not.toHaveBeenCalled();
    await f.service.update(
      {
        ...base,
        browserOptions: V2_RECHARGE_BROWSER_DEFAULTS,
        dynamicProxyUrl: 'https://new.example/extract'
      },
      operator
    );
    f.changeRow({ staticProxyCredentialsEncrypted: 'encrypted:unused' });
    const runtime = await f.service.runtime(operator.id);
    expect(runtime.dynamicProxyUrl).toBe('https://new.example/extract');
    expect(runtime.staticProxyCredentials).toBeUndefined();
    expect(f.encryption.decrypt).not.toHaveBeenCalledWith('encrypted:unused');
  });
});
