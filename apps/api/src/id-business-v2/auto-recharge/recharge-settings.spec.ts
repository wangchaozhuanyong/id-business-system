import { describe, expect, it, vi } from 'vitest';
import { RechargeSettingsService } from './recharge-settings.service';
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
      audit as never
    )
  };
}

describe('比特浏览器列表只读连接授权', () => {
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
