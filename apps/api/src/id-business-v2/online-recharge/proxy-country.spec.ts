import { describe, expect, it, vi } from 'vitest';
import { OnlineProxyPoolRepository, RechargeProxyRepository } from '../proxy-pool/public-api';
import { onlineProxyCountry } from './proxy-input';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';

const proxyId = '123e4567-e89b-42d3-a456-426614174000';
const taskId = '123e4567-e89b-42d3-a456-426614174001';
const operator = { id: 'fixture-operator', roles: ['admin'] } as never;
const encryption = {
  encrypt: (value: string | undefined) => value ?? null,
  decrypt: (value: string | undefined) => value ?? null,
  hash: (value: string | undefined) => value ?? null
};
const session = JSON.stringify({
  accessToken: 'synthetic-fixture-session-value',
  user: { id: 'fixture' }
});

function taskFixture(countryCode: unknown = 'CL') {
  const tx = {
    onlineRechargeConfig: {
      findUnique: vi.fn().mockResolvedValue({ settings: { proxyCountryCode: countryCode } })
    },
    idBusinessV2RechargeProxy: { count: vi.fn().mockResolvedValue(1) },
    onlineRechargeTask: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }) => ({ id: taskId, status: 'queued', ...data }))
    }
  };
  const repository = { transaction: vi.fn((_key, work) => work(tx)), log: vi.fn() };
  const tasks = new OnlineRechargeTasksRepository(
    repository as never,
    {} as never,
    encryption as never,
    {} as never,
    {} as never
  );
  return { tx, repository, tasks };
}

function rpcFixture(
  payload: Record<string, unknown>,
  operation = 'recharge',
  configured: unknown = 'PH'
) {
  const proxies = {
    active: vi
      .fn()
      .mockResolvedValue({ id: proxyId, countryCode: payload.proxyCountryCode ?? configured })
  };
  const row = { id: taskId, operation, payload };
  const tx = { onlineRechargeTask: { update: vi.fn() } };
  const settings = {
    internal: vi.fn().mockResolvedValue({ settings: { proxyCountryCode: configured } })
  };
  const key = 'synthetic-fixture-worker-key-32-chars';
  const rpc = new OnlineRechargeWorkerRpcRepository(
    proxies as never,
    { get: () => key } as never,
    { log: vi.fn() } as never,
    { withLease: vi.fn((_rpc, work) => work(tx, row)) } as never,
    settings as never,
    encryption as never,
    {} as never,
    {} as never
  );
  return {
    proxies,
    tx,
    settings,
    get: (args = {}) => rpc.rpc(key, { method: 'getActiveProxy', taskId, args })
  };
}

describe('线上代充代理国家限制', () => {
  it('新本地充值的恢复版本由服务端固定，调用方不能移除或放宽', async () => {
    for (const checkoutRecoveryVersion of [undefined, null, 0, false, 99]) {
      const f = taskFixture();
      await f.tasks.start({ session, checkoutRecoveryVersion }, operator);
      expect(f.tx.onlineRechargeTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          provider: 'local',
          payload: expect.objectContaining({ checkoutRecoveryVersion: 1 })
        })
      });
    }
  });
  it('国家必须明确选择且只接受两位国家代码', () => {
    expect(onlineProxyCountry(' cl ')).toBe('CL');
    for (const value of [undefined, null, '', 'CL,PH', 'CHL', 1])
      expect(() => onlineProxyCountry(value)).toThrow('代理国家');
  });

  it.each(['recharge', 'debug', 'subscription', 'renewal'] as const)(
    '%s 创建任务时冻结配置国家，忽略调用方伪造的国家',
    async (operation) => {
      const f = taskFixture();
      await f.tasks.start(
        { session, proxyCountryCode: 'US', action: 'check' },
        operator,
        operation
      );
      expect(f.tx.idBusinessV2RechargeProxy.count).toHaveBeenCalledWith({
        where: { active: true, countryCode: 'CL' }
      });
      expect(f.tx.onlineRechargeTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ proxyCountryCode: 'CL' })
        })
      });
    }
  );

  it('没有选择国家或该国没有启用代理时不创建任务', async () => {
    const unset = taskFixture('');
    await expect(unset.tasks.start({ session }, operator)).rejects.toThrow('代理国家');
    expect(unset.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
    const empty = taskFixture();
    empty.tx.idBusinessV2RechargeProxy.count.mockResolvedValue(0);
    await expect(empty.tasks.start({ session }, operator)).rejects.toThrow('暂无启用代理');
    expect(empty.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
    expect(empty.repository.log).not.toHaveBeenCalled();
  });

  it('执行只读取任务国家，不受新配置或执行器参数影响', async () => {
    const f = rpcFixture({ proxyCountryCode: 'CL' });
    await f.get({ proxyCountryCode: 'US' });
    expect(f.settings.internal).not.toHaveBeenCalled();
    expect(f.proxies.active).toHaveBeenCalledWith(f.tx, undefined, false, undefined, 'CL');
    expect(f.tx.onlineRechargeTask.update).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { payload: { proxyCountryCode: 'CL', proxyId, proxyPoolReference: true } }
    });
  });

  it('旧任务按已配置国家筛选并保存，缺少配置时不读取代理凭据', async () => {
    const old = rpcFixture({});
    await old.get();
    expect(old.proxies.active).toHaveBeenCalledWith(old.tx, undefined, false, undefined, 'PH');
    expect(old.tx.onlineRechargeTask.update.mock.calls[0]?.[0].data.payload.proxyCountryCode).toBe(
      'PH'
    );
    const unset = rpcFixture({}, 'recharge', '');
    await expect(unset.get()).rejects.toThrow('代理国家');
    expect(unset.proxies.active).not.toHaveBeenCalled();
  });

  it('指定代理仍受任务国家约束，代理检测独立于业务国家', async () => {
    const business = rpcFixture({ proxyCountryCode: 'CL', proxyId, proxyPoolReference: true });
    await business.get();
    expect(business.proxies.active).toHaveBeenCalledWith(
      business.tx,
      proxyId,
      true,
      undefined,
      'CL'
    );
    const probe = rpcFixture(
      { proxyId, proxyPoolReference: true, proxyConnectionVersion: 'fixture-version' },
      'proxy_test',
      ''
    );
    await probe.get();
    expect(probe.settings.internal).not.toHaveBeenCalled();
    expect(probe.proxies.active).toHaveBeenCalledWith(
      probe.tx,
      proxyId,
      true,
      'fixture-version',
      undefined
    );
  });

  it('混合国家池只返回指定国家的启用代理，指定错误国家也不会回退', async () => {
    const rows = [
      {
        id: proxyId,
        active: true,
        countryCode: 'CL',
        urlEncrypted: 'socks5://fixture:fixture@gateway.example.test:1080',
        protocol: 'socks5',
        connectionMode: 'direct'
      },
      { id: 'other', active: true, countryCode: 'PH' },
      { id: 'disabled', active: false, countryCode: 'CL' },
      { id: 'unknown', active: true, countryCode: null }
    ];
    const tx = {
      idBusinessV2RechargeProxy: {
        findMany: vi.fn(async ({ where }) =>
          rows.filter((row) =>
            Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)
          )
        )
      }
    };
    const repository = new RechargeProxyRepository({} as never);
    vi.spyOn(repository, 'lock').mockResolvedValue(undefined as never);
    const pool = new OnlineProxyPoolRepository({} as never, repository, encryption as never);
    for (let i = 0; i < 10; i++)
      expect(await pool.active(tx as never, undefined, false, undefined, 'CL')).toMatchObject({
        id: proxyId,
        countryCode: 'CL',
        protocol: 'socks5'
      });
    expect(tx.idBusinessV2RechargeProxy.findMany).toHaveBeenCalledWith({
      where: { active: true, countryCode: 'CL' },
      take: 500
    });
    await expect(pool.active(tx as never, undefined, false, undefined, 'US')).rejects.toThrow(
      '不会切换其他国家'
    );
    await expect(pool.active(tx as never, 'other', true, undefined, 'CL')).rejects.toThrow(
      '不属于任务指定国家'
    );
  });

  it('配置按原有版本及审计保存国家，支付地区保持独立', async () => {
    let stored: Record<string, unknown> | null = null;
    const db = {
      onlineRechargeConfig: {
        findUnique: vi.fn(async () => stored),
        upsert: vi.fn(async ({ create, update }) => {
          stored = stored ? { ...stored, ...update } : create;
        })
      },
      onlineRechargeCard: { updateMany: vi.fn() }
    };
    const repository = {
      read: vi.fn((work) => work(db)),
      transaction: vi.fn((_key, work) => work(db)),
      log: vi.fn()
    };
    const settings = new OnlineRechargeSettingsRepository(repository as never, encryption as never);
    expect(await settings.update({ proxyCountryCode: 'cl', version: 0 }, operator)).toMatchObject({
      proxyCountryCode: 'CL',
      paymentRegion: 'PH',
      version: 1
    });
    await expect(settings.update({ proxyCountryCode: 'US', version: 0 }, operator)).rejects.toThrow(
      '设置已变化'
    );
    await expect(
      settings.update({ proxyCountryCode: 'CL,PH', version: 1 }, operator)
    ).rejects.toThrow('代理国家');
    expect(repository.log).toHaveBeenCalledWith(db, 'config.update', operator, undefined, {
      changedKeys: ['proxyCountryCode', 'version']
    });
  });
});
