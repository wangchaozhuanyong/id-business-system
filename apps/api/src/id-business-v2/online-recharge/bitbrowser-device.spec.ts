import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { OnlineBitbrowserDeviceRepository } from './persistence/bitbrowser-device.repository';
const operator = { id: '11111111-1111-4111-8111-111111111111' } as AuthenticatedUser;
function fixture() {
  const devices = new Map<string, Record<string, unknown>>();
  let running = 0,
    runningDevice = '';
  const db = {
    onlineRechargeTask: {
      count: vi.fn(async ({ where }) =>
        !where.payload || where.payload.equals === runningDevice ? running : 0
      ),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [])
    },
    onlineRechargeBitbrowserDevice: {
      create: vi.fn(async ({ data }) => {
        const device = { enabled: false, tokenHash: null, lastSeenAt: null, ...data };
        devices.set(data.id, device);
        return { ...device };
      }),
      findUnique: vi.fn(async ({ where }) => {
        const value = [...devices.values()].find((device) =>
          Object.entries(where).every(([key, value]) => device[key] === value)
        );
        return value ? { ...value } : null;
      }),
      count: vi.fn(async () => devices.size),
      findMany: vi.fn(async () => [...devices.values()].map((device) => ({ ...device }))),
      update: vi.fn(async ({ where, data }) => {
        const device = { ...devices.get(where.id), ...data };
        devices.set(where.id, device);
        return { ...device };
      })
    }
  };
  let queue = Promise.resolve();
  const repository = {
    read: async (work: (client: typeof db) => unknown) => work(db),
    log: vi.fn(),
    transaction: (_key: string, work: (client: typeof db) => unknown) => {
      const result = queue.then(() => work(db));
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    }
  };
  return {
    service: new OnlineBitbrowserDeviceRepository(repository as never),
    getDevice: (id?: string) => (id ? devices.get(id)! : [...devices.values()][0]!),
    setRunning: (value: number, deviceId?: string) => {
      running = value;
      runningDevice = deviceId ?? String([...devices.values()][0]?.id ?? '');
    },
    repository
  };
}
describe('执行电脑配对', () => {
  it('Mac 和 Windows 独立绑定，新增或停用一台不覆盖另一台的凭据', async () => {
    const f = fixture();
    const macPair = await f.service.pairing({ name: 'Mac' }, operator);
    const mac = await f.service.pair({ pairingToken: macPair.pairingToken });
    const winPair = await f.service.pairing({ name: 'Windows' }, operator);
    const win = await f.service.pair({ pairingToken: winPair.pairingToken });
    expect(mac.deviceId).not.toBe(win.deviceId);
    await expect(f.service.authorize(mac.deviceId, mac.deviceKey)).resolves.toMatchObject({
      name: 'Mac'
    });
    await expect(f.service.authorize(win.deviceId, win.deviceKey)).resolves.toMatchObject({
      name: 'Windows'
    });
    await expect(f.service.authorize(win.deviceId, mac.deviceKey)).rejects.toThrow('凭据');
    expect((await f.service.list()).items).toHaveLength(2);
    expect(JSON.stringify(await f.service.list())).not.toContain(mac.deviceKey);
    await f.service.revoke(operator, win.deviceId);
    await expect(f.service.authorize(mac.deviceId, mac.deviceKey)).resolves.toMatchObject({
      enabled: true
    });
    await expect(f.service.authorize(win.deviceId, win.deviceKey)).rejects.toThrow();
  });
  it('另一台正在执行时仍可新增备用电脑，但不能重绑正在执行的电脑', async () => {
    const f = fixture();
    const mac = await f.service.pairing({ name: 'Mac' }, operator);
    f.setRunning(1, mac.deviceId);
    const win = await f.service.pairing({ name: 'Windows' }, operator);
    await expect(f.service.pair({ pairingToken: win.pairingToken })).resolves.toMatchObject({
      deviceId: win.deviceId
    });
    await expect(
      f.service.pairing({ name: 'Mac', deviceId: mac.deviceId }, operator)
    ).rejects.toThrow('正在运行');
  });
  it('配对仅一次，数据库保存摘要，摘要不会出现在状态查询里', async () => {
    const f = fixture(),
      pairing = await f.service.pairing({ name: '合成电脑' }, operator);
    expect(f.getDevice().pairingHash).not.toBe(pairing.pairingToken);
    const result = await f.service.pair({ pairingToken: pairing.pairingToken });
    expect(f.getDevice().tokenHash).not.toBe(result.deviceKey);
    await expect(f.service.authorize(result.deviceId, result.deviceKey)).resolves.toMatchObject({
      enabled: true
    });
    const summary = await f.service.summary();
    expect(summary).not.toHaveProperty('tokenHash');
    expect(summary).not.toHaveProperty('pairingHash');
    await expect(f.service.pair({ pairingToken: pairing.pairingToken })).rejects.toThrow('配对');
  });
  it('并发兑换同一配对凭据只有一次成功', async () => {
    const f = fixture(),
      pairing = await f.service.pairing({ name: '合成电脑' }, operator);
    const results = await Promise.allSettled([
      f.service.pair({ pairingToken: pairing.pairingToken }),
      f.service.pair({ pairingToken: pairing.pairingToken })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('过期配对凭据、错误设备密钥以及停用后的密钥均被拒绝', async () => {
    const f = fixture(),
      pairing = await f.service.pairing({ name: '合成电脑' }, operator);
    const result = await f.service.pair({ pairingToken: pairing.pairingToken });
    await expect(f.service.authorize(result.deviceId, 'wrong')).rejects.toThrow('凭据');
    await f.service.revoke(operator);
    await expect(f.service.authorize(result.deviceId, result.deviceKey)).rejects.toThrow('凭据');
    const next = await f.service.pairing({ name: '合成电脑' }, operator);
    f.getDevice(next.deviceId).pairingExpiresAt = new Date(0);
    await expect(f.service.pair({ pairingToken: next.pairingToken })).rejects.toThrow('过期');
  });
  it('有运行中任务时拒绝重新配对，不删除任务或设备', async () => {
    const f = fixture();
    const first = await f.service.pairing({ name: '合成电脑' }, operator);
    f.setRunning(1, first.deviceId);
    await expect(
      f.service.pairing({ name: '合成电脑', deviceId: first.deviceId }, operator)
    ).rejects.toThrow('正在运行');
  });
});
