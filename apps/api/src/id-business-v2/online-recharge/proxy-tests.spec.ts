import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeWorkerRpcRepository } from './persistence/worker-rpc.repository';
import { proxyConnectionVersion } from '../proxy-pool/public-api';

const proxyId = '123e4567-e89b-42d3-a456-426614174000';
const taskId = '123e4567-e89b-42d3-a456-426614174001';
const aliasId = '123e4567-e89b-42d3-a456-426614174002';
const proxy = {
  id: proxyId,
  active: true,
  urlHash: 'hash',
  protocol: 'socks5',
  connectionMode: 'direct'
};
const operator = { id: 'operator', roles: ['admin'] } as never;
const encryption = {
  encrypt: vi.fn((v) => v ?? null),
  decrypt: vi.fn((v) => v ?? null),
  hash: vi.fn((v) => v ?? null)
};

function fixture() {
  let stored: unknown = null;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    idBusinessV2ProxyAlias: {
      findUnique: vi.fn().mockResolvedValue({ proxyId }),
      findMany: vi.fn().mockResolvedValue([{ oldId: aliasId }])
    },
    idBusinessV2RechargeProxy: { findUnique: vi.fn().mockResolvedValue(proxy) },
    onlineRechargeConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    onlineRechargeTask: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn(async () => stored),
      create: vi.fn(
        async ({ data }) =>
          (stored = {
            ...data,
            id: taskId,
            status: 'queued',
            progress: 0,
            createdAt: new Date(),
            updatedAt: new Date()
          })
      )
    }
  };
  let serial = Promise.resolve();
  const repository = {
    transaction: vi.fn((_key, work) => {
      const next = serial.then(() => work(tx));
      serial = next.catch(() => undefined);
      return next;
    }),
    log: vi.fn()
  };
  const service = new OnlineRechargeTasksRepository(
    repository as never,
    {} as never,
    encryption as never,
    {} as never,
    {} as never
  );
  return { tx, repository, service };
}

describe('proxy test task lifecycle', () => {
  it('serializes concurrent requests and reuses the same active connection version', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.start({ proxyId: aliasId }, operator, 'proxy_test'),
      f.service.start({ proxyId, proxyPoolReference: true }, operator, 'proxy_test')
    ]);
    expect(f.tx.onlineRechargeTask.create).toHaveBeenCalledTimes(1);
    expect(results.map((row) => row.id)).toEqual([taskId, taskId]);
    expect(results[1]).toMatchObject({ reused: true, proxyId });
    expect(f.repository.transaction.mock.calls.map((call) => call[0])).toEqual([
      'tasks-start',
      'tasks-start'
    ]);
    const lockValue = f.tx.$queryRaw.mock.calls[0]?.[1] ?? f.tx.$executeRaw.mock.calls[0]?.[1];
    expect([
      `proxy-pool:${proxyId}`,
      createHash('sha256').update(`proxy-pool:${proxyId}`).digest('hex')
    ]).toContain(lockValue);
    expect(f.tx.onlineRechargeTask.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: {
            proxyId,
            proxyPoolReference: true,
            proxyConnectionVersion: proxyConnectionVersion(proxy)
          }
        })
      })
    );
  });
  it('rejects missing/disabled proxies before creating a task', async () => {
    const f = fixture();
    f.tx.idBusinessV2RechargeProxy.findUnique.mockResolvedValue(null as never);
    await expect(f.service.start({ proxyId }, operator, 'proxy_test')).rejects.toThrow(
      '已停用或不存在'
    );
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
  });
  it('retires an unclaimed legacy task without inventing its historical connection version', async () => {
    const f = fixture();
    f.tx.onlineRechargeTask.findFirst.mockResolvedValueOnce({
      id: 'legacy',
      operation: 'proxy_test',
      status: 'queued',
      payload: { proxyId }
    } as never);
    const result = await f.service.start(
      { proxyId, proxyPoolReference: true },
      operator,
      'proxy_test'
    );
    expect(result).toMatchObject({ id: taskId, reused: false });
    expect(f.tx.onlineRechargeTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'legacy',
          status: 'queued',
          leaseOwner: null,
          paymentStarted: false,
          confirmedPaid: false
        },
        data: expect.objectContaining({
          status: 'failed',
          result: { ok: false, errorCode: 'legacy_test' }
        })
      })
    );
    expect(f.tx.onlineRechargeTask.create).toHaveBeenCalledTimes(1);
  });
  it('does not take over a legacy task that won a concurrent worker lease', async () => {
    const f = fixture();
    f.tx.onlineRechargeTask.findFirst.mockResolvedValueOnce({
      id: 'legacy',
      operation: 'proxy_test',
      status: 'queued',
      payload: { proxyId }
    } as never);
    f.tx.onlineRechargeTask.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(
      await f.service.start({ proxyId, proxyPoolReference: true }, operator, 'proxy_test')
    ).toMatchObject({ id: 'legacy', reused: true });
    expect(f.tx.onlineRechargeTask.create).not.toHaveBeenCalled();
  });
  it('stops legacy claimed tasks before fetching proxy credentials', async () => {
    const proxies = { active: vi.fn() };
    const workers = {
      withLease: vi.fn(async (_rpc, work) =>
        work({}, { id: taskId, operation: 'proxy_test', payload: { proxyId } })
      )
    };
    const key = 'a'.repeat(32);
    const rpc = new OnlineRechargeWorkerRpcRepository(
      proxies as never,
      { get: () => key } as never,
      {} as never,
      workers as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    await expect(
      rpc.rpc(key, { method: 'getActiveProxy', taskId, args: { proxyId } })
    ).rejects.toThrow('旧检测缺少连接版本');
    expect(proxies.active).not.toHaveBeenCalled();
  });
  it('maps only safe fields for failed task results', () => {
    const f = fixture();
    const row = f.service.map({
      id: taskId,
      operation: 'proxy_test',
      status: 'failed',
      payload: { proxyId, proxyConnectionVersion: proxyConnectionVersion(proxy) },
      message: 'http://secret:password@proxy.test',
      result: {
        results: [{ proxyId, ok: false, errorCode: 'connection_timeout', error: 'token=secret' }]
      }
    } as never);
    expect(row.message).toContain('连接超时');
    expect(JSON.stringify(row)).not.toMatch(/secret|password/);
  });
  it('maps a legacy successful task as requiring detection without rewriting its history', () => {
    const original = {
      id: taskId,
      operation: 'proxy_test',
      status: 'succeeded',
      payload: { proxyId },
      result: { ok: true, ip: '8.8.8.8' }
    };
    expect(fixture().service.map(original as never)).toMatchObject({
      status: 'failed',
      requiresResubmission: true,
      connectionChanged: false,
      message: '旧检测缺少连接版本，请重新检测',
      result: {
        ok: false,
        ip: null,
        errorCode: 'legacy_test',
        message: '旧检测缺少连接版本，请重新检测'
      }
    });
    expect(original.status).toBe('succeeded');
    for (const status of ['queued', 'running']) {
      expect(fixture().service.map({ ...original, status } as never)).toMatchObject({
        status,
        requiresResubmission: true
      });
    }
  });
  it('finds one latest result per proxy including legacy aliases', async () => {
    const db = {
      idBusinessV2RechargeProxy: { findMany: vi.fn().mockResolvedValue([proxy]) },
      idBusinessV2ProxyAlias: {
        findMany: vi.fn().mockResolvedValue([{ oldId: aliasId, proxyId }])
      },
      onlineRechargeTask: {
        findFirst: vi.fn().mockResolvedValue({ id: taskId, payload: { proxyId: aliasId } })
      }
    };
    const repository = new OnlineRechargeRepository(
      {} as never,
      db as never,
      {} as never,
      {} as never
    );
    const result = await repository.list('jobs', {
      operation: 'proxy_test',
      proxyIds: proxyId,
      latestPerProxy: 'true'
    });
    expect(result).toMatchObject({ total: 1, items: [{ id: taskId, payload: { proxyId } }] });
    expect(db.idBusinessV2RechargeProxy.findMany).toHaveBeenCalledTimes(1);
    expect(db.onlineRechargeTask.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operation: 'proxy_test',
          deletedAt: null,
          AND: [
            {
              OR: [proxyId, aliasId].flatMap((value) => [
                { payload: { path: '$.proxyId', equals: value } },
                { payload: { path: '$.ids', array_contains: value } }
              ])
            }
          ]
        })
      })
    );
  });
  it('marks historical results when a saved connection changed while preserving current failures', async () => {
    const anotherId = '123e4567-e89b-42d3-a456-426614174003';
    const db = {
      idBusinessV2RechargeProxy: {
        findMany: vi.fn().mockResolvedValue([
          { ...proxy, urlHash: 'changed' },
          { ...proxy, id: anotherId }
        ])
      },
      idBusinessV2ProxyAlias: { findMany: vi.fn().mockResolvedValue([]) },
      onlineRechargeTask: {
        findFirst: vi.fn(async ({ where }) => {
          const selected = where.AND[0].OR[0].payload.equals;
          return {
            id: selected === proxyId ? taskId : 'current-failure',
            operation: 'proxy_test',
            status: selected === proxyId ? 'succeeded' : 'failed',
            payload: { proxyId: selected, proxyConnectionVersion: proxyConnectionVersion(proxy) },
            result:
              selected === proxyId
                ? { ok: true, ip: '8.8.8.8' }
                : { ok: false, errorCode: 'proxy_auth_failed' }
          };
        })
      }
    };
    const repository = new OnlineRechargeRepository(
      {} as never,
      db as never,
      {} as never,
      {} as never
    );
    const result = await repository.list('jobs', {
      operation: 'proxy_test',
      proxyIds: `${proxyId},${anotherId}`,
      latestPerProxy: 'true'
    });
    const service = fixture().service;
    const rows = result.items.map((row) => service.map(row as never));
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      connectionChanged: true,
      message: '连接资料已修改，请重新检测'
    });
    expect(rows[1]).toMatchObject({
      status: 'failed',
      connectionChanged: false,
      message: '检测失败：代理认证失败，请检查账号和密码'
    });
    expect(db.idBusinessV2RechargeProxy.findMany).toHaveBeenCalledTimes(1);
    expect(db.idBusinessV2RechargeProxy.findMany).toHaveBeenCalledWith({
      where: { id: { in: [proxyId, anotherId] } },
      select: { id: true, urlHash: true, protocol: true, connectionMode: true }
    });
  });
  it('does not mark an invalid exit response as succeeded at task completion', async () => {
    const tx = {
      onlineRechargeTask: { update: vi.fn() },
      onlineRechargeCard: { updateMany: vi.fn() }
    };
    const repository = { log: vi.fn() };
    const worker = new OnlineRechargeWorkerRepository(
      repository as never,
      {} as never,
      encryption as never,
      {} as never,
      {} as never
    );
    vi.spyOn(worker, 'withLease').mockImplementation(async (_rpc, work) =>
      work(
        tx as never,
        {
          id: taskId,
          operation: 'proxy_test',
          payload: { proxyId, proxyConnectionVersion: proxyConnectionVersion(proxy) },
          plan: 'plus',
          status: 'running'
        } as never
      )
    );
    await worker.finish(
      {
        args: {
          status: 'succeeded',
          result: { results: [{ proxyId, ok: true, ip: '<html>error</html>' }] }
        }
      } as never,
      false
    );
    expect(tx.onlineRechargeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          result: expect.objectContaining({ ok: false, errorCode: 'invalid_exit_ip' })
        })
      })
    );
  });
  it('finishes legacy tasks as failed even when an old worker reports success', async () => {
    const tx = {
      onlineRechargeTask: { update: vi.fn() },
      onlineRechargeCard: { updateMany: vi.fn() }
    };
    const worker = new OnlineRechargeWorkerRepository(
      { log: vi.fn() } as never,
      {} as never,
      encryption as never,
      {} as never,
      {} as never
    );
    vi.spyOn(worker, 'withLease').mockImplementation(async (_rpc, work) =>
      work(
        tx as never,
        { id: taskId, operation: 'proxy_test', payload: { proxyId }, plan: 'plus' } as never
      )
    );
    await worker.finish(
      { args: { status: 'succeeded', result: { ok: true, ip: '8.8.8.8' } } } as never,
      false
    );
    expect(tx.onlineRechargeTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          progress: 100,
          leaseOwner: null,
          message: '旧检测缺少连接版本，已停止，请重新检测',
          result: expect.objectContaining({ errorCode: 'legacy_test' })
        })
      })
    );
  });
});
