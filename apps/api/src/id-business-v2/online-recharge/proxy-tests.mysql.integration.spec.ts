import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import {
  OnlineProxyPoolRepository,
  RechargeProxyRepository,
  RechargeProxyService,
  proxyConnectionVersion
} from '../proxy-pool/public-api';
import { OnlineRechargeEphemeralCredentials } from './ephemeral-credentials.service';
import { OnlineRechargeSettingsService } from './settings.service';
import { OnlineRechargeTasksService } from './tasks.service';
import { OnlineRechargeRepository } from './persistence/online-recharge.repository';
import { OnlineRechargeSettingsRepository } from './persistence/settings.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { OnlineRechargeWorkerRepository } from './persistence/worker.repository';
import { OnlineRechargeOrderSyncService } from './order-sync.service';
import { OnlineRechargeOrderSyncRepository } from './persistence/order-sync.repository';

const suite = process.env.ONLINE_RECHARGE_MYSQL_TEST === '1' ? describe : describe.skip;

suite('代理检测闭环隔离 MySQL 验收', () => {
  const db = new PrismaService();
  const config = new ConfigService({
    FIELD_ENCRYPTION_KEY: 'synthetic-proxy-encryption-fixture',
    HASH_SECRET: 'synthetic-proxy-blind-index-fixture'
  });
  const encryption = new FieldEncryptionService(config);
  const transactions = new V2CommandTransactionManager(db);
  const audit = new V2TransactionalAuditService();
  const poolRepository = new RechargeProxyRepository(db);
  const pool = new RechargeProxyService(poolRepository, transactions, audit, encryption);
  const proxies = new OnlineProxyPoolRepository(pool, poolRepository, encryption);
  const repository = new OnlineRechargeRepository(proxies, db, audit, transactions);
  const settings = new OnlineRechargeSettingsService(
    new OnlineRechargeSettingsRepository(repository, encryption)
  );
  const memory = new OnlineRechargeEphemeralCredentials(config);
  const orderSync = new OnlineRechargeOrderSyncService(
    new OnlineRechargeOrderSyncRepository(repository, encryption, {} as never)
  );
  const tasks = new OnlineRechargeTasksService(
    new OnlineRechargeTasksRepository(repository, settings, encryption, memory, orderSync)
  );
  const workers = new OnlineRechargeWorkerRepository(
    repository,
    settings,
    encryption,
    memory,
    orderSync
  );
  let operator: AuthenticatedUser;

  async function createProxy() {
    const { id } = await pool.create(
      {
        url: `socks5://fixture:fixture@gateway-${randomUUID()}.example.test:1080`,
        protocol: 'socks5',
        connectionMode: 'direct',
        countryCode: 'PH',
        kind: 'mobile'
      },
      operator
    );
    const aliasId = randomUUID();
    await db.idBusinessV2ProxyAlias.create({ data: { oldId: aliasId, proxyId: id } });
    return { id, aliasId };
  }

  const start = (proxyId: string, canonical = true) =>
    tasks.start({ proxyId, proxyPoolReference: canonical }, operator, 'proxy_test');

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'mysql://invalid.invalid/invalid');
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/id_business_v2_online_recharge_fixture'
    )
      throw new Error('代理专项验收只允许远端 CI 创建的专属隔离数据库');
    await db.$connect();
    const user = await db.user.create({
      data: {
        username: `proxy-closure-${randomUUID()}`,
        displayName: '代理隔离测试身份',
        passwordHash: 'synthetic-unusable-password-hash'
      }
    });
    operator = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roles: ['admin'],
      permissions: []
    };
  });

  beforeEach(async () => {
    for (const model of [
      db.onlineRechargeOrderSync,
      db.onlineRechargeBill,
      db.onlineRechargeEvent,
      db.onlineRechargeWebhookReceipt,
      db.onlineRechargeTask,
      db.onlineRechargeCode,
      db.onlineRechargeCard,
      db.onlineRechargeProxy,
      db.idBusinessV2ProxyAlias,
      db.idBusinessV2RechargeProxy,
      db.onlineRechargeAddress,
      db.onlineRechargeConfig
    ])
      await (model.deleteMany as () => Promise<unknown>)();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it('真实并发 canonical 与 alias 请求只创建一个当前连接检测', async () => {
    const proxy = await createProxy();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        index % 2 ? start(proxy.aliasId, false) : start(proxy.id)
      )
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(results.filter((row) => row.reused)).toHaveLength(7);
    expect(await db.onlineRechargeTask.count({ where: { operation: 'proxy_test' } })).toBe(1);
    const task = await db.onlineRechargeTask.findUniqueOrThrow({
      where: { id: results[0]!.id }
    });
    const current = await db.idBusinessV2RechargeProxy.findUniqueOrThrow({
      where: { id: proxy.id }
    });
    expect(task.payload).toEqual({
      proxyId: proxy.id,
      proxyPoolReference: true,
      proxyConnectionVersion: proxyConnectionVersion(current)
    });
  });

  it('排队任务阻止连接修改与删除，取消后释放检测锁且保留历史', async () => {
    const proxy = await createProxy();
    const task = await start(proxy.id);
    await expect(pool.delete(proxy.id, operator)).rejects.toThrow('正在检测');
    await expect(
      pool.update(proxy.id, { url: 'socks5://fixture:fixture@changed.example.test:1080' }, operator)
    ).rejects.toThrow('正在检测');
    await tasks.action('jobs', 'cancel', { id: task.id }, operator);
    await pool.update(
      proxy.id,
      { url: 'socks5://fixture:fixture@changed.example.test:1080' },
      operator
    );
    await pool.delete(proxy.id, operator);
    expect(await db.idBusinessV2RechargeProxy.findUnique({ where: { id: proxy.id } })).toBeNull();
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'failed',
      message: '管理员取消待执行任务'
    });
  });

  it('已领取检测不能取消并持续保护代理，执行终态后释放', async () => {
    const proxy = await createProxy();
    const task = await start(proxy.id);
    const claimed = await workers.claim('synthetic-proxy-worker');
    expect(claimed?.id).toBe(task.id);
    if (!claimed) throw new Error('隔离检测任务未被领取');
    await expect(tasks.action('jobs', 'cancel', { id: task.id }, operator)).rejects.toThrow(
      '仅允许取消尚未开始'
    );
    await expect(pool.delete(proxy.id, operator)).rejects.toThrow('正在检测');
    await workers.finish(
      {
        method: 'failJob',
        taskId: claimed.id,
        workerId: claimed.workerId,
        leaseId: claimed.leaseId,
        leaseVersion: claimed.leaseVersion,
        args: {
          status: 'failed',
          result: {
            results: [{ proxyId: proxy.id, ok: false, errorCode: 'connection_timeout' }]
          }
        }
      },
      true
    );
    await pool.delete(proxy.id, operator);
    expect(await db.onlineRechargeTask.findUnique({ where: { id: task.id } })).toMatchObject({
      status: 'failed',
      leaseOwner: null
    });
  });

  it('旧 batch 的 alias 仍保护活动检测，安全替换后保留旧记录并可取消释放', async () => {
    const proxy = await createProxy();
    const legacy = await db.onlineRechargeTask.create({
      data: {
        operation: 'proxy_test',
        payload: { ids: [proxy.aliasId] },
        message: 'synthetic legacy batch'
      }
    });
    await expect(pool.delete(proxy.id, operator)).rejects.toThrow('正在检测');
    await expect(
      pool.update(proxy.id, { url: 'socks5://fixture:fixture@changed.example.test:1080' }, operator)
    ).rejects.toThrow('正在检测');
    const [replacement, competing] = await Promise.all([
      start(proxy.id),
      start(proxy.aliasId, false)
    ]);
    expect(replacement.id).not.toBe(legacy.id);
    expect(competing.id).toBe(replacement.id);
    expect([replacement, competing].filter((row) => row.reused)).toHaveLength(1);
    expect(await db.onlineRechargeTask.findUnique({ where: { id: legacy.id } })).toMatchObject({
      status: 'failed',
      payload: { ids: [proxy.aliasId] },
      result: { ok: false, errorCode: 'legacy_test' }
    });
    expect(await db.onlineRechargeTask.count()).toBe(2);
    await tasks.action('jobs', 'cancel', { id: replacement.id }, operator);
    await pool.delete(proxy.id, operator);
    expect(await db.onlineRechargeTask.count()).toBe(2);
  });

  it('旧 connectionVersion 回执不能覆盖新连接，当前版本才能保存有效出口', async () => {
    const proxy = await createProxy();
    const oldVersion = await repository.transaction('proxy-snapshot-old', async (tx) => {
      const active = await proxies.active(tx, proxy.aliasId);
      expect(
        await proxies.result(
          tx,
          proxy.aliasId,
          { ok: true, ip: '8.8.8.8', latencyMs: 12 },
          false,
          active.connectionVersion
        )
      ).toEqual({ applied: true });
      return active.connectionVersion;
    });
    await pool.update(
      proxy.id,
      { url: 'socks5://fixture:fixture@changed.example.test:1080' },
      operator
    );
    const before = await db.idBusinessV2RechargeProxy.findUniqueOrThrow({
      where: { id: proxy.id }
    });
    expect(before).toMatchObject({ exitIp: null, latencyMs: null, testedAt: null });
    expect(
      await repository.transaction('proxy-result-old', (tx) =>
        proxies.result(
          tx,
          proxy.aliasId,
          { ok: true, ip: '1.1.1.1', latencyMs: 20 },
          false,
          oldVersion
        )
      )
    ).toEqual({ applied: false });
    expect(await db.idBusinessV2RechargeProxy.findUnique({ where: { id: proxy.id } })).toEqual(
      before
    );
    await repository.transaction('proxy-result-current', async (tx) => {
      const active = await proxies.active(tx, proxy.id, true);
      expect(active.connectionVersion).not.toBe(oldVersion);
      expect(
        await proxies.result(
          tx,
          proxy.id,
          { ok: true, ip: '1.1.1.1', latencyMs: 20 },
          true,
          active.connectionVersion
        )
      ).toEqual({ applied: true });
    });
    expect(
      await db.idBusinessV2RechargeProxy.findUnique({ where: { id: proxy.id } })
    ).toMatchObject({
      exitIp: '1.1.1.1',
      latencyMs: 20,
      testMessage: '检测成功'
    });
  });

  it('真实充值历史的旧 batch 引用继续阻止替换与删除', async () => {
    const proxy = await createProxy();
    await db.onlineRechargeTask.create({
      data: {
        operation: 'recharge',
        status: 'succeeded',
        payload: { ids: [proxy.aliasId] },
        message: 'synthetic historical recharge'
      }
    });
    await expect(pool.delete(proxy.id, operator)).rejects.toThrow('已用于充值任务');
    await expect(
      pool.update(proxy.id, { url: 'socks5://fixture:fixture@changed.example.test:1080' }, operator)
    ).rejects.toThrow('已用于充值任务');
  });
});
