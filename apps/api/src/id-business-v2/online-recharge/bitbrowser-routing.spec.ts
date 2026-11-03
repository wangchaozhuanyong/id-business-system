import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineBitbrowserConnectorService } from './bitbrowser-connector.service';
import { OnlineBitbrowserAdminController } from './bitbrowser.controller';
import { PERMISSIONS_KEY } from '../../auth/auth.decorators';
import { queueBitbrowserRecheck } from './persistence/bitbrowser-task-actions';
const deviceId = '11111111-1111-4111-8111-111111111111';
function workerFixture() {
  const rows = [
    {
      id: 'bit',
      provider: 'bitbrowser',
      operation: 'recharge',
      leaseVersion: 0,
      payload: { bitBrowserPolicy: { deviceId } }
    },
    { id: 'server', provider: 'local', leaseVersion: 0, payload: {} }
  ];
  const db = {
    onlineRechargeEvent: { upsert: vi.fn(async ({ create }) => create) },
    onlineRechargeConfig: { findUnique: vi.fn(async () => null) },
    onlineRechargeTask: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findFirst: vi.fn(
        async ({ where }) =>
          rows.find((row) =>
            typeof where.provider === 'string'
              ? row.provider === where.provider &&
                row.payload.bitBrowserPolicy?.deviceId === where.payload.equals
              : where.provider.in.includes(row.provider)
          ) ?? null
      ),
      update: vi.fn(async ({ where, data }) => ({
        ...rows.find((row) => row.id === where.id),
        ...data
      }))
    }
  };
  const repository = {
    transaction: async (_key: string, work: (client: typeof db) => unknown) => work(db),
    log: vi.fn()
  };
  return {
    db,
    workers: new OnlineRechargeWorkerRepository(
      repository as never,
      {} as never,
      { decrypt: () => null } as never,
      {} as never,
      {} as never
    )
  };
}
describe('比特任务通道隔离', () => {
  it('配对、停用、付款确认和继续执行均要求读取及管理权限', () => {
    for (const method of ['pairing', 'revoke', 'confirm', 'resume', 'saveConnection'] as const)
      expect(
        Reflect.getMetadata(PERMISSIONS_KEY, OnlineBitbrowserAdminController.prototype[method])
      ).toEqual(['id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage']);
  });
  it('电脑只能读取自身连接配置，不能通过参数指定另一台电脑', async () => {
    const privateConnection = vi.fn(async () => ({ localApiUrl: 'http://127.0.0.1:54345' }));
    const service = new OnlineBitbrowserConnectorService(
      {} as never,
      { authorize: async () => ({ id: deviceId }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { privateConnection } as never
    );
    await service.rpc('synthetic-device-key', {
      deviceId,
      method: 'connection',
      args: { deviceId: '22222222-2222-4222-8222-222222222222' }
    });
    expect(privateConnection).toHaveBeenCalledExactlyOnceWith(deviceId);
  });
  it('待核对任务保留原编号、付款事实及策略，重复核对不产生第二个任务', async () => {
    const row = {
      id: deviceId,
      provider: 'bitbrowser',
      status: 'awaiting_review',
      paymentStarted: true,
      payload: { bitBrowserPolicy: { deviceId } }
    };
    const tx = {
      onlineRechargeTask: {
        findUnique: async () => structuredClone(row),
        update: vi.fn(async ({ data }) => Object.assign(row, data))
      }
    };
    const repository = {
      transaction: async (_key: string, work: (db: typeof tx) => unknown) => work(tx),
      log: vi.fn()
    };
    expect(await queueBitbrowserRecheck(repository as never, deviceId, {} as never)).toMatchObject({
      id: deviceId,
      paymentStarted: true,
      status: 'queued',
      payload: { bitBrowserCheckOnly: true, bitBrowserPolicy: { deviceId } }
    });
    await expect(
      queueBitbrowserRecheck(repository as never, deviceId, {} as never)
    ).rejects.toThrow('待核对');
    expect(tx.onlineRechargeTask.update).toHaveBeenCalledTimes(1);
  });
  it('服务器执行器跳过先入队的比特任务', async () => {
    const f = workerFixture();
    expect((await f.workers.claim('server-worker'))?.id).toBe('server');
    expect(f.db.onlineRechargeTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: { in: ['local', 'third_party'] } })
      })
    );
  });
  it('比特电脑仅领取绑定给自己的比特充值，不能领取服务器任务', async () => {
    const f = workerFixture();
    expect((await f.workers.claim(`bitbrowser:${deviceId}`, deviceId))?.id).toBe('bit');
    expect(await f.workers.claim('wrong-device', 'other-device')).toBeNull();
  });
  it('比特一次仅执行一笔，不受服务器并发设置影响', async () => {
    const f = workerFixture();
    f.db.onlineRechargeTask.count.mockResolvedValue(1);
    expect(await f.workers.claim(`bitbrowser:${deviceId}`, deviceId)).toBeNull();
    expect(f.db.onlineRechargeTask.findFirst).not.toHaveBeenCalled();
  });
  it('客户不能指定卡片、通道、套餐或付款策略，拒绝时不预约兑换码', async () => {
    const transaction = vi.fn();
    const service = new OnlineRechargeTasksRepository(
      { transaction } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    for (const key of ['cardId', 'provider', 'plan', 'bitBrowserPolicy'])
      await expect(
        service.start(
          { code: 'synthetic', session: '{}', [key]: 'arbitrary' },
          undefined,
          'recharge',
          true
        )
      ).rejects.toThrow('只接收');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('满额或暂停接单在预约兑换码前拒绝，配置上限按比特队列计算', async () => {
    for (const paused of [false, true]) {
      const update = vi.fn(),
        create = vi.fn();
      const db = {
        onlineRechargeConfig: {
          findUnique: async () => ({
            settings: {
              executionChannel: 'bitbrowser',
              acceptingNewTasks: !paused,
              bitBrowserQueueLimit: 100
            }
          })
        },
        onlineRechargeCode: {
          findUnique: async () => ({ id: deviceId, status: 'available', plan: 'plus' }),
          update
        },
        onlineRechargeTask: { count: vi.fn(async () => 100), create }
      };
      const repository = {
        transaction: async (_key: string, work: (tx: typeof db) => unknown) => work(db)
      };
      const service = new OnlineRechargeTasksRepository(
        repository as never,
        {} as never,
        { hash: () => 'fixture-hash' } as never,
        {} as never,
        {} as never
      );
      await expect(
        service.start(
          {
            code: 'synthetic-code',
            session: JSON.stringify({
              accessToken: 'synthetic-session-at-least-twenty',
              user: { id: 'fixture', email: 'fixture@example.test' }
            })
          },
          undefined,
          'recharge',
          true
        )
      ).rejects.toThrow(paused ? '暂停' : '名额');
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });
  it('离线、未就绪或本机占用时不领取，队列不会被客户端移除', async () => {
    for (const override of [{ ready: false }, { busy: true }, { lastSeenAt: new Date(0) }]) {
      const claim = vi.fn();
      const device = {
        id: deviceId,
        enabled: true,
        ready: true,
        busy: false,
        protocol: 1,
        lastSeenAt: new Date(),
        ...override
      };
      const service = new OnlineBitbrowserConnectorService(
        {} as never,
        { authorize: async () => device } as never,
        {} as never,
        {} as never,
        { claim } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
      );
      expect(await service.rpc('synthetic-device-key', { deviceId, method: 'claim' })).toBeNull();
      expect(claim).not.toHaveBeenCalled();
    }
  });
  it('设备接口没有任意 worker RPC 权限，也不能借用其他电脑的租约', async () => {
    const authorize = vi.fn(async () => ({ id: deviceId }));
    const withLease = vi.fn(async () => {
      throw new Error('租约不属于该电脑');
    });
    const dispatch = vi.fn();
    const service = new OnlineBitbrowserConnectorService(
      {} as never,
      { authorize } as never,
      {} as never,
      {} as never,
      { withLease } as never,
      { dispatch } as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      service.rpc('fixture-device-key', {
        deviceId,
        method: 'getRuntimeConfig',
        taskId: deviceId,
        leaseId: deviceId,
        leaseVersion: 1
      })
    ).rejects.toThrow('租约');
    expect(dispatch).not.toHaveBeenCalled();
    withLease.mockImplementation(async () => undefined as never);
    await expect(
      service.rpc('fixture-device-key', {
        deviceId,
        method: 'getRuntimeConfig',
        taskId: deviceId,
        leaseId: deviceId,
        leaseVersion: 1
      })
    ).rejects.toThrow('未授权');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
