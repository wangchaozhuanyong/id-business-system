import { describe, expect, it, vi } from 'vitest';
import { selectBitbrowserDevice } from './persistence/bitbrowser-dispatch';
import { deviceConnectionKey, resolveBitbrowserConnection } from './bitbrowser-connection';
import { ONLINE_RECHARGE_DEFAULTS } from './contracts';
const mac = {
  id: '11111111-1111-4111-8111-111111111111',
  slot: 'primary',
  enabled: true,
  tokenHash: 'digest',
  name: 'Mac'
};
const windows = {
  id: '22222222-2222-4222-8222-222222222222',
  slot: 'secondary',
  enabled: true,
  tokenHash: 'digest',
  name: 'Windows'
};
const connection = {
  localApiUrl: 'http://127.0.0.1:54345',
  localApiToken: 'synthetic-windows-api-only',
  groupName: 'Windows分组',
  tagName: 'Windows标签'
};
const settings = { ...ONLINE_RECHARGE_DEFAULTS };
const secrets = {
  bitBrowserApiKey: 'synthetic-mac-api-only',
  [deviceConnectionKey(windows.id)]: JSON.stringify(connection)
};
describe('网站指定充值电脑', () => {
  it('兼容原主电脑，选择 Windows 后只返回 Windows 的连接配置', async () => {
    const tx = {
      onlineRechargeBitbrowserDevice: {
        findUnique: vi.fn(async ({ where }) => (where.id === windows.id ? windows : mac))
      }
    };
    expect(await selectBitbrowserDevice(tx as never, settings, secrets)).toMatchObject({
      device: { id: mac.id },
      connection: { localApiToken: 'synthetic-mac-api-only' }
    });
    const chosen = await selectBitbrowserDevice(
      tx as never,
      { ...settings, bitBrowserDeviceId: windows.id },
      secrets
    );
    expect(chosen).toMatchObject({ device: { id: windows.id }, connection });
    expect(JSON.stringify(chosen)).not.toContain('synthetic-mac-api-only');
  });
  it('指定电脑离线仍分配原电脑；没有私有接口或电脑停用时不回退另一台', async () => {
    const tx = {
      onlineRechargeBitbrowserDevice: {
        findUnique: vi.fn(async () => ({ ...windows, ready: false, lastSeenAt: new Date(0) }))
      }
    };
    const input = { ...settings, bitBrowserDeviceId: windows.id };
    expect((await selectBitbrowserDevice(tx as never, input, secrets)).device.id).toBe(windows.id);
    await expect(selectBitbrowserDevice(tx as never, input, {})).rejects.toThrow('本机接口');
    tx.onlineRechargeBitbrowserDevice.findUnique.mockResolvedValueOnce({
      ...windows,
      enabled: false
    } as never);
    await expect(selectBitbrowserDevice(tx as never, input, secrets)).rejects.toThrow('启用');
  });
  it('普通设备不能继承另一台电脑的全局比特密钥', () => {
    expect(
      resolveBitbrowserConnection(
        settings,
        { bitBrowserApiKey: secrets.bitBrowserApiKey },
        windows.id,
        false
      )
    ).toBeNull();
  });
});
