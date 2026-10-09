import { describe, expect, it, vi } from 'vitest';
import { RechargeSettingsService } from './recharge-settings.service';
import {
  V2_RECHARGE_BROWSER_DEFAULTS,
  V2_RECHARGE_BROWSER_PROFILE_KEYS
} from '@apple-business/shared';
const operator = {
  id: 'admin-test',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

function fixture(configured = true) {
  const row = {
    connectorUrl: 'http://127.0.0.1:55321',
    localApiUrl: 'http://127.0.0.1:54345',
    connectorTokenEncrypted: 'connector-ciphertext',
    localApiTokenEncrypted: 'api-ciphertext',
    dynamicProxyUrlEncrypted: 'unused-proxy-ciphertext'
  };
  const repository = { findInTransaction: vi.fn().mockResolvedValue(configured ? row : null) };
  const encryption = { decrypt: vi.fn((value) => (value ? `fixture-${value}` : '')) };
  const tx = {};
  const transactions = { execute: vi.fn((work) => work(tx)) };
  const audit = { append: vi.fn() };
  return {
    repository,
    transactions,
    encryption,
    audit,
    service: new RechargeSettingsService(
      repository as never,
      encryption as never,
      transactions as never,
      audit as never,
      {} as never
    )
  };
}

describe('比特浏览器列表只读连接授权', () => {
  it('网页直连不要求或解密连接器密钥，仍按当前管理员归属并完成审计', async () => {
    const { service, repository, encryption, audit } = fixture();
    repository.findInTransaction.mockResolvedValue({
      connectorUrl: 'http://127.0.0.1:55321',
      localApiUrl: 'http://127.0.0.1:54345',
      localApiTokenEncrypted: 'api-ciphertext'
    });
    const result = await service.catalogAccess(operator, { directMode: true });
    expect(result.connectorToken).toBe('');
    expect(result.localApiToken).toBe('fixture-api-ciphertext');
    expect(encryption.decrypt).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledOnce();
    await expect(service.catalogAccess(operator)).rejects.toThrow('请先填写');
    await expect(service.catalogAccess(operator, { directMode: 'yes' })).rejects.toThrow(
      '连接模式无效'
    );
  });
  it('仅读取当前管理员的连接设置并审计，不解密代理或返回其他设置', async () => {
    const { service, repository, encryption, audit, transactions } = fixture();
    const result = await service.catalogAccess(operator);
    expect(repository.findInTransaction).toHaveBeenCalledWith(expect.anything(), operator.id);
    expect(Object.keys(result).sort()).toEqual([
      'connectorToken',
      'connectorUrl',
      'localApiToken',
      'localApiUrl'
    ]);
    expect(encryption.decrypt).not.toHaveBeenCalledWith('unused-proxy-ciphertext');
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: operator.id,
        objectId: operator.id,
        action: 'id_business_v2.auto_recharge.bitbrowser_catalog.access'
      })
    );
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('ciphertext');
    expect(transactions.execute).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ changedScopes: ['audit-logs'] })
    );
  });
  it('未保存连接密钥时不返回凭据', async () => {
    const { service, audit } = fixture(false);
    await expect(service.catalogAccess(operator)).rejects.toThrow('请先填写比特接口密钥');
    expect(audit.append).not.toHaveBeenCalled();
  });
  it('审计失败时不返回解密凭据', async () => {
    const { service, audit } = fixture();
    audit.append.mockRejectedValue(new Error('audit unavailable'));
    await expect(service.catalogAccess(operator)).rejects.toThrow('audit unavailable');
  });
});

describe('网页直连设置与运行凭据', () => {
  const row = {
    connectorUrl: 'http://127.0.0.1:55321',
    localApiUrl: 'http://127.0.0.1:54345',
    localApiTokenEncrypted: 'api-ciphertext',
    dynamicProxyUrlEncrypted: 'proxy-ciphertext',
    groupName: '登录分组',
    tagName: '登录标签',
    proxyType: 'http',
    browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS },
    updatedAt: new Date()
  };
  it('新窗口配置保存在当前管理员的数据库设置，并由新服务实例读取和执行', async () => {
    let saved = { ...row };
    const repository = {
      find: vi.fn().mockImplementation(() => Promise.resolve(saved)),
      findInTransaction: vi.fn().mockImplementation(() => Promise.resolve(saved)),
      upsert: vi
        .fn()
        .mockImplementation((_: unknown, ownerId: string, input: Partial<typeof row>) => {
          expect(ownerId).toBe(operator.id);
          saved = { ...saved, ...input };
          return Promise.resolve(saved);
        })
    };
    const encryption = { decrypt: vi.fn((value) => (value ? `fixture-${value}` : '')) };
    const transactions = { execute: vi.fn((work) => work({})) };
    const audit = { append: vi.fn() };
    const service = new RechargeSettingsService(
      repository as never,
      encryption as never,
      transactions as never,
      audit as never,
      {} as never
    );
    const browserOptions = {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      coreVersion: '150',
      osVersion: '10' as const,
      openWidth: 1800,
      openHeight: 1100
    };
    const input = {
      directMode: true,
      connectorUrl: row.connectorUrl,
      localApiUrl: row.localApiUrl,
      groupName: row.groupName,
      tagName: row.tagName,
      proxyType: row.proxyType,
      browserOptions
    };
    expect((await service.update(input, operator)).browserOptions).toEqual(browserOptions);
    const anotherInstance = new RechargeSettingsService(
      repository as never,
      encryption as never,
      transactions as never,
      audit as never,
      {} as never
    );
    expect((await anotherInstance.get(operator)).browserOptions).toEqual(browserOptions);
    expect((await anotherInstance.runtime(operator.id, false, true)).browserOptions).toEqual(
      browserOptions
    );
    expect(repository.find).toHaveBeenCalledWith(operator.id);
    expect(repository.upsert).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('ciphertext');
  });
  it('读取旧 Mac 设置归一为 Windows 11，但不会悄悄重写旧记录或改代理地区', async () => {
    const legacy = {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      os: 'MacIntel' as const,
      language: 'en-US'
    };
    for (const key of V2_RECHARGE_BROWSER_PROFILE_KEYS)
      delete (legacy as Partial<typeof legacy>)[key];
    const before = { ...legacy };
    const repository = {
      find: vi.fn().mockResolvedValue({ ...row, browserOptions: legacy }),
      upsert: vi.fn()
    };
    const service = new RechargeSettingsService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect((await service.get(operator)).browserOptions).toMatchObject({
      os: 'Win32',
      osVersion: '11',
      coreVersion: '152',
      openWidth: 1600,
      openHeight: 1000,
      language: 'en-US'
    });
    expect(legacy).toEqual(before);
    expect(repository.upsert).not.toHaveBeenCalled();
  });
  it('直连允许首次保存接口密钥而没有连接器密钥，保存仍加密并写审计', async () => {
    const repository = {
      findInTransaction: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation((_, ownerId, input) => ({ ...row, ...input, ownerId }))
    };
    const encryption = { encrypt: vi.fn((value) => `encrypted:${value}`) };
    const audit = { append: vi.fn() };
    const service = new RechargeSettingsService(
      repository as never,
      encryption as never,
      { execute: vi.fn((work) => work({})) } as never,
      audit as never,
      {} as never
    );
    const input = {
      directMode: true,
      connectorUrl: row.connectorUrl,
      localApiUrl: row.localApiUrl,
      localApiToken: 'fixture-only-api-key',
      dynamicProxyUrl: 'https://example.invalid/proxy',
      groupName: row.groupName,
      tagName: row.tagName,
      proxyType: row.proxyType
    };
    const result = await service.update(input, operator);
    expect(result.localApiTokenConfigured).toBe(true);
    expect(result.connectorTokenConfigured).toBe(false);
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.anything(),
      operator.id,
      expect.objectContaining({ localApiTokenEncrypted: 'encrypted:fixture-only-api-key' })
    );
    expect(audit.append).toHaveBeenCalledOnce();
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain('fixture-only-api-key');
    await expect(service.update({ ...input, directMode: false }, operator)).rejects.toThrow(
      '连接密钥'
    );
    await expect(service.update({ ...input, directMode: 'true' }, operator)).rejects.toThrow(
      '直连模式'
    );
    expect(repository.upsert).toHaveBeenCalledOnce();
  });
  it('运行凭据只在显式直连时跳过连接器校验，仍要求接口密钥和有效代理', async () => {
    const repository = { find: vi.fn().mockResolvedValue({ ...row }) };
    const encryption = { decrypt: vi.fn((value) => (value ? `fixture-${value}` : '')) };
    const service = new RechargeSettingsService(
      repository as never,
      encryption as never,
      {} as never,
      {} as never,
      {} as never
    );
    const result = await service.runtime(operator.id, false, true);
    expect(repository.find).toHaveBeenCalledWith(operator.id);
    expect(result.connectorToken).toBe('');
    expect(result.localApiToken).toBe('fixture-api-ciphertext');
    expect(encryption.decrypt).toHaveBeenCalledTimes(2);
    await expect(service.runtime(operator.id)).rejects.toThrow('完成比特浏览器设置');
    repository.find.mockResolvedValue({ ...row, localApiTokenEncrypted: '' });
    await expect(service.runtime(operator.id, false, true)).rejects.toThrow('完成比特浏览器设置');
    repository.find.mockResolvedValue({ ...row, dynamicProxyUrlEncrypted: '' });
    await expect(service.runtime(operator.id, false, true)).rejects.toThrow('完成比特浏览器设置');
  });
});
