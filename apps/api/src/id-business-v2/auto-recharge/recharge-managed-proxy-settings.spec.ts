import { describe, expect, it, vi } from 'vitest';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { RechargeSettingsService } from './recharge-settings.service';

const proxyId = '33333333-3333-4333-8333-333333333333';
const operator = {
  id: 'fixture-admin',
  username: 'fixture',
  displayName: '测试管理员',
  roles: ['admin'],
  permissions: []
};
function fixture() {
  let row = {
    connectorUrl: 'http://127.0.0.1:55321',
    localApiUrl: 'http://127.0.0.1:54345',
    connectorTokenEncrypted: 'encrypted:fixture-connector',
    localApiTokenEncrypted: 'encrypted:fixture-api',
    dynamicProxyUrlEncrypted: null,
    staticProxyCredentialsEncrypted: null,
    groupName: '注册分组',
    tagName: '注册标签',
    proxyType: 'http',
    browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, accountCopySuffix: '保留备注' },
    updatedAt: new Date()
  };
  const proxy = {
    id: proxyId,
    active: true,
    connectionMode: 'extraction',
    protocol: 'http',
    countryCode: 'US',
    kind: 'dynamic_residential',
    urlEncrypted: 'encrypted:https://proxy.example.test/extract'
  };
  const repository = {
    find: vi.fn(async () => row),
    findInTransaction: vi.fn(async () => row),
    upsert: vi.fn(async (_tx, _owner, input) => {
      row = { ...row, ...input };
      return row;
    })
  };
  const proxies = { find: vi.fn(async () => proxy), findInTransaction: vi.fn(async () => proxy) };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value?: string | null) => value?.replace(/^encrypted:/, '') ?? null)
  };
  const audit = { append: vi.fn() };
  const service = new RechargeSettingsService(
    repository as never,
    encryption as never,
    { execute: (work: (tx: unknown) => unknown) => work({}) } as never,
    audit as never,
    proxies as never
  );
  const input = (mode: 'dynamic' | 'static' = 'dynamic', protocol = 'http') => ({
    proxyId,
    connectorUrl: row.connectorUrl,
    localApiUrl: row.localApiUrl,
    groupName: row.groupName,
    tagName: row.tagName,
    proxyType: protocol,
    browserOptions: { ...V2_RECHARGE_BROWSER_DEFAULTS, proxyMode: mode, staticHost: '' }
  });
  return { service, repository, proxies, encryption, audit, proxy, input, row };
}

describe('代理目录共用默认代理', () => {
  it('网页直连使用目录默认代理且不需要本机连接器密钥，本机执行仍要求连接器', async () => {
    const f = fixture();
    f.row.connectorTokenEncrypted = '';
    expect(await f.service.update({ ...f.input(), directMode: true }, operator)).toMatchObject({
      proxyId,
      connectorTokenConfigured: false
    });
    f.encryption.decrypt.mockClear();
    expect(await f.service.runtime(operator.id, false, true)).toMatchObject({
      connectorToken: '',
      localApiToken: 'fixture-api',
      dynamicProxyUrl: 'https://proxy.example.test/extract'
    });
    expect(f.encryption.decrypt).not.toHaveBeenCalledWith('');
    await expect(f.service.runtime(operator.id)).rejects.toThrow('请先完成比特浏览器设置');
  });
  it('保存引用而不复制代理秘密，并与服务器默认选择共用', async () => {
    const f = fixture();
    expect(await f.service.update(f.input(), operator)).toMatchObject({
      proxyId,
      dynamicProxyUrlConfigured: false
    });
    const saved = f.repository.upsert.mock.calls[0][2];
    expect(saved.browserOptions).toMatchObject({
      serverDefaultProxyId: proxyId,
      accountCopySuffix: '保留备注'
    });
    expect(saved.dynamicProxyUrlEncrypted).toBeNull();
    expect(saved.staticProxyCredentialsEncrypted).toBeNull();
    expect(f.encryption.encrypt).not.toHaveBeenCalled();
    expect(await f.service.getServerProxySettings(operator)).toMatchObject({ proxyId });
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('https://proxy.example.test');
  });
  it('拒绝停用条目与不匹配的模式或协议，失败不写设置', async () => {
    const f = fixture();
    f.proxy.active = false;
    await expect(f.service.update(f.input(), operator)).rejects.toThrow('启用代理');
    f.proxy.active = true;
    await expect(f.service.update(f.input('static'), operator)).rejects.toThrow('已变化');
    await expect(f.service.update(f.input('dynamic', 'socks5'), operator)).rejects.toThrow(
      '已变化'
    );
    expect(f.repository.upsert).not.toHaveBeenCalled();
  });
  it('执行时实时读取代理资料，更新链接与协议无需重新保存窗口设置', async () => {
    const f = fixture();
    await f.service.update(f.input(), operator);
    f.proxy.urlEncrypted = 'encrypted:https://proxy.example.test/new-extract';
    f.proxy.protocol = 'socks5';
    expect(await f.service.runtime(operator.id)).toMatchObject({
      proxyType: 'socks5',
      dynamicProxyUrl: 'https://proxy.example.test/new-extract'
    });
    f.proxy.active = false;
    await expect(f.service.runtime(operator.id)).rejects.toThrow('已停用或不存在');
    // 显式任务代理不受默认代理停用影响，由任务自己的代理校验处理。
    expect(await f.service.runtime(operator.id, true)).toMatchObject({
      localApiToken: 'fixture-api'
    });
  });
  it('固定代理的主机和凭据来自目录，不读取历史代理凭据', async () => {
    const f = fixture();
    f.proxy.connectionMode = 'direct';
    f.proxy.protocol = 'socks5';
    f.proxy.urlEncrypted = 'encrypted:socks5://fixture-user:fixture-pass@proxy.example.test:1080';
    await f.service.update(f.input('static', 'socks5'), operator);
    expect(await f.service.runtime(operator.id)).toMatchObject({
      browserOptions: { proxyMode: 'static', staticHost: 'proxy.example.test', staticPort: 1080 },
      staticProxyCredentials: { username: 'fixture-user', password: 'fixture-pass' },
      dynamicProxyUrl: ''
    });
    expect(f.encryption.decrypt).not.toHaveBeenCalledWith(null);
    f.proxies.find.mockResolvedValueOnce(null as never);
    await expect(f.service.runtime(operator.id)).rejects.toThrow('已停用或不存在');
  });
});
