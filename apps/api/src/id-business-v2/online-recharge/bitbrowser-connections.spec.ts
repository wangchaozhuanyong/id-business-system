import { describe, expect, it, vi } from 'vitest';
import { OnlineBitbrowserConnectionsRepository } from './persistence/bitbrowser-connections.repository';
import { ONLINE_RECHARGE_DEFAULTS } from './contracts';
import { deviceConnectionKey } from './bitbrowser-connection';
const deviceId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const encryption = {
    encrypt: (value: string) => 'enc:' + value,
    decrypt: (value: string) => value.slice(4)
  };
  const oldConnection = {
    localApiUrl: 'http://127.0.0.1:54345',
    localApiToken: 'synthetic-original-private-key',
    groupName: 'Mac',
    tagName: '充值'
  };
  const config = {
    settings: { ...ONLINE_RECHARGE_DEFAULTS },
    version: 0,
    secretsEncrypted: encryption.encrypt(
      JSON.stringify({
        bitBrowserApiKey: 'synthetic-legacy-key',
        [deviceConnectionKey(otherId)]: JSON.stringify(oldConnection)
      })
    )
  };
  const db = {
    onlineRechargeBitbrowserDevice: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        slot: 'secondary'
      })
    },
    onlineRechargeConfig: {
      findUnique: async () => ({ ...config }),
      update: vi.fn(async ({ data }) => {
        config.secretsEncrypted = data.secretsEncrypted;
        config.version++;
      })
    }
  };
  const repository = {
    read: async (work: (client: typeof db) => unknown) => work(db),
    transaction: async (_key: string, work: (client: typeof db) => unknown) => work(db),
    log: vi.fn()
  };
  const service = new OnlineBitbrowserConnectionsRepository(
    repository as never,
    encryption as never
  );
  return { service, config, db, repository, encryption, oldConnection };
}
describe('两台电脑的独立比特接口', () => {
  it('只更改目标设备的加密设置，不覆盖另一台或全局密钥', async () => {
    const f = fixture();
    const input = {
      version: 0,
      localApiUrl: 'http://127.0.0.1:54345',
      localApiToken: 'synthetic-windows-private-key',
      groupName: 'Windows',
      tagName: '充值'
    };
    await f.service.save(deviceId, input, {} as never);
    const saved = JSON.parse(f.encryption.decrypt(f.config.secretsEncrypted));
    expect(JSON.parse(saved[deviceConnectionKey(otherId)])).toEqual(f.oldConnection);
    expect(saved.bitBrowserApiKey).toBe('synthetic-legacy-key');
    expect(JSON.stringify(await f.service.read(deviceId))).not.toContain(input.localApiToken);
    expect(JSON.stringify(f.repository.log.mock.calls)).not.toContain(input.localApiToken);
    expect(await f.service.privateConnection(deviceId)).toMatchObject({
      localApiToken: input.localApiToken
    });
    expect(await f.service.privateConnection(otherId)).toMatchObject({
      localApiToken: f.oldConnection.localApiToken
    });
  });
  it('空密钥保留本台已有值，旧版本及非法公网接口不允许覆盖', async () => {
    const f = fixture();
    await f.service.save(
      otherId,
      { ...f.oldConnection, localApiToken: '', version: 0 },
      {} as never
    );
    expect((await f.service.privateConnection(otherId))?.localApiToken).toBe(
      f.oldConnection.localApiToken
    );
    await expect(
      f.service.save(otherId, { ...f.oldConnection, version: 0 }, {} as never)
    ).rejects.toThrow('设置已变化');
    await expect(
      f.service.save(
        otherId,
        { ...f.oldConnection, version: 1, localApiUrl: 'http://example.invalid:54345' },
        {} as never
      )
    ).rejects.toThrow('本机');
  });
});
