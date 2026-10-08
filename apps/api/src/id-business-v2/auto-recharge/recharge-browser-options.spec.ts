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
  const proxies = { find: vi.fn(), findInTransaction: vi.fn() };
  const service = new RechargeSettingsService(
    repository as never,
    encryption as never,
    transactions as never,
    audit as never,
    proxies as never
  );
  return {
    service,
    repository,
    encryption,
    audit,
    proxies,
    changeRow: (data: Record<string, unknown>) => Object.assign(row, data)
  };
}

describe('窗口配置校验', () => {
  it('内部复制后缀不进入执行器，修改窗口配置仍保留后缀', async () => {
    const { service, changeRow, repository } = fixture();
    const options = { ...V2_RECHARGE_BROWSER_DEFAULTS, accountCopySuffix: 'fixture suffix' };
    expect(storedBrowserOptions(options)).toEqual(V2_RECHARGE_BROWSER_DEFAULTS);
    changeRow({ browserOptions: options });
    await service.update(
      { ...base, browserOptions: staticOptions, staticProxyCredentials: credentials },
      operator
    );
    expect(repository.upsert.mock.calls.at(-1)?.[2].browserOptions).toMatchObject({
      accountCopySuffix: 'fixture suffix',
      proxyMode: 'static'
    });
  });
  it('旧空设置回退原默认值，合法指定设置完整保留', () => {
    expect(V2_RECHARGE_BROWSER_DEFAULTS.timezone).toBe('Asia/Shanghai');
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
  it('旧 Mac JSON 归一为 Windows 11，保留代理、地区且不修改原记录', () => {
    const legacy = { ...staticOptions, os: 'MacIntel', language: 'en-US' } as Record<
      string,
      unknown
    >;
    for (const key of ['coreVersion', 'osVersion', 'openWidth', 'openHeight']) delete legacy[key];
    const original = { ...legacy };
    expect(storedBrowserOptions(legacy)).toMatchObject({
      os: 'Win32',
      osVersion: '11',
      coreVersion: '152',
      openWidth: 1600,
      openHeight: 1000,
      staticHost: 'proxy.example',
      language: 'en-US'
    });
    expect(legacy).toEqual(original);
  });
  it('新版显式平台、内核与窗口尺寸保留，读取不偷偷写入数据库', () => {
    for (const os of ['MacIntel', 'Linux x86_64']) {
      const options = {
        ...staticOptions,
        os,
        osVersion: '',
        coreVersion: '150',
        openWidth: 1800,
        openHeight: 1100
      };
      expect(storedBrowserOptions(options)).toEqual(options);
    }
  });
  it.each([
    { sessionWaitMinutes: 0 },
    { sessionWaitMinutes: 11 },
    { sessionWaitMinutes: 1.5 },
    { sessionRetryLimit: -1 },
    { sessionRetryLimit: 3 },
    { sessionRetryLimit: true },
    { coreVersion: 'latest' },
    { coreVersion: 152 },
    { coreVersion: '95' },
    { coreVersion: '152.0.0' },
    { osVersion: '11,10' },
    { osVersion: '' },
    { openWidth: 799 },
    { openWidth: 7681 },
    { openWidth: 1600.5 },
    { openWidth: true },
    { openHeight: 599 },
    { openHeight: 4321 },
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
  it('默认代理引用目录，保存保留本机设置及旧密文，读取不解密链接', async () => {
    const f = fixture();
    const proxyId = '123e4567-e89b-42d3-a456-426614174000';
    const proxy = {
      id: proxyId,
      countryCode: 'PH',
      kind: 'mobile',
      protocol: 'socks5',
      connectionMode: 'extraction',
      active: true,
      remark1: '菲律宾代理'
    };
    f.proxies.find.mockResolvedValue(proxy);
    f.proxies.findInTransaction.mockResolvedValue(proxy);
    f.changeRow({ browserOptions: { ...staticOptions, accountCopySuffix: 'fixture suffix' } });
    const result = await f.service.updateServerProxySettings({ proxyId }, operator as never);
    expect(result).toMatchObject({
      proxyId,
      proxy: { protocol: 'socks5', status: 'active' },
      legacyConfigured: true
    });
    expect(f.repository.upsert).toHaveBeenCalledWith(expect.anything(), operator.id, {
      browserOptions: {
        ...staticOptions,
        accountCopySuffix: 'fixture suffix',
        serverDefaultProxyId: proxyId
      }
    });
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
    expect(f.audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ afterData: { proxyId } })
    );
    const options = f.repository.upsert.mock.calls[0]?.[2].browserOptions;
    expect(storedBrowserOptions(options)).toEqual(staticOptions);
    expect(options.accountCopySuffix).toBe('fixture suffix');
    await f.service.update({ ...base, browserOptions: staticOptions }, operator as never);
    expect(f.repository.upsert.mock.calls.at(-1)?.[2].browserOptions.serverDefaultProxyId).toBe(
      proxyId
    );
    f.proxies.find.mockResolvedValue(null);
    await expect(f.service.getServerProxySettings(operator as never)).resolves.toMatchObject({
      proxyId,
      proxy: null
    });
    await f.service.updateServerProxySettings({ proxyId: null }, operator as never);
    expect(
      f.repository.upsert.mock.calls.at(-1)?.[2].browserOptions.serverDefaultProxyId
    ).toBeNull();
    expect(f.repository.upsert.mock.calls.at(-1)?.[2].browserOptions.accountCopySuffix).toBe(
      'fixture suffix'
    );
  });
  it('不存在、停用及格式错误的默认代理不会写入设置', async () => {
    const f = fixture();
    const proxyId = '123e4567-e89b-42d3-a456-426614174000';
    f.proxies.findInTransaction.mockResolvedValue(null);
    await expect(
      f.service.updateServerProxySettings({ proxyId }, operator as never)
    ).rejects.toThrow('启用代理');
    f.proxies.findInTransaction.mockResolvedValue({ active: false });
    await expect(
      f.service.updateServerProxySettings({ proxyId }, operator as never)
    ).rejects.toThrow('启用代理');
    for (const body of [{}, { proxyId: '' }, { proxyId, url: 'secret' }])
      await expect(f.service.updateServerProxySettings(body, operator as never)).rejects.toThrow();
    expect(f.repository.upsert).not.toHaveBeenCalled();
    expect(f.audit.append).not.toHaveBeenCalled();
  });
  it('服务器代理设置不依赖本机密钥，动态提取链接必须是 HTTPS', async () => {
    const f = fixture();
    f.changeRow({ localApiTokenEncrypted: null, connectorTokenEncrypted: null });
    const input = { ...base, serverMode: true, browserOptions: V2_RECHARGE_BROWSER_DEFAULTS };
    await expect(f.service.update(input, operator as never)).resolves.toBeDefined();
    await expect(f.service.serverProxy(operator.id)).resolves.toMatchObject({
      mode: 'dynamic',
      extractionUrl: 'https://proxy.example/extract'
    });
    await expect(
      f.service.update({ ...input, serverMode: false }, operator as never)
    ).rejects.toThrow();
    await expect(
      f.service.update(
        { ...input, dynamicProxyUrl: 'http://proxy.example/extract' },
        operator as never
      )
    ).rejects.toThrow();
  });
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

it('normalizes legacy sync flags to protect session data', () => {
  expect(
    storedBrowserOptions({
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      syncTabs: true,
      syncCookies: true,
      syncLocalStorage: true
    })
  ).toMatchObject({ syncTabs: false, syncCookies: false, syncLocalStorage: false });
});
