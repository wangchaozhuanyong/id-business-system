import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { V2_RECHARGE_BROWSER_DEFAULTS } from '@apple-business/shared';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { RechargeProxyRepository } from './persistence/recharge-proxy.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeSettingsService } from './recharge-settings.service';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash } from './recharge-validation';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('员工连接配置与真实 MySQL 并发隔离', () => {
  let prisma: PrismaService;
  let settings: RechargeSettingsService;
  let local: RechargeLocalService;
  let service: RechargeService;
  let repository: RechargeRepository;
  const addressIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  const employees = ['甲', '乙'].map((name) => ({
    id: randomUUID(),
    username: 'fixture-' + randomUUID(),
    displayName: '隔离员工' + name,
    roles: ['admin'],
    permissions: []
  }));
  const base = (index: number) => ({
    connectionProfileId: null,
    connectorUrl: 'http://127.0.0.1:55322',
    localApiUrl: 'http://127.0.0.1:54345',
    localApiToken: 'synthetic-local-api-' + index,
    connectorToken: 'synthetic-connector-' + index,
    groupName: '合成分组' + index,
    tagName: '合成标签' + index,
    proxyType: 'http',
    browserOptions: {
      ...V2_RECHARGE_BROWSER_DEFAULTS,
      proxyMode: 'static',
      staticHost: 'proxy.fixture.invalid',
      staticPort: 8080
    }
  });
  const open = (index: number, extra = {}) =>
    local.startOpen(
      {
        id: randomUUID(),
        windowName: '并发合成验收',
        ...extra
      },
      employees[index]!
    );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname.includes('id_business_v2_employee_connections_')
    )
      throw new Error('仅允许本次自有隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    const transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    const encryption = new FieldEncryptionService(
      new ConfigService({
        FIELD_ENCRYPTION_KEY: 'synthetic-fixture-encryption-only',
        HASH_SECRET: 'synthetic-fixture-hash-only'
      })
    );
    repository = new RechargeRepository(prisma);
    const addresses = new RechargeAddressRepository(prisma);
    settings = new RechargeSettingsService(
      new RechargeSettingsRepository(prisma),
      encryption,
      transactions,
      audit,
      new RechargeProxyRepository(prisma)
    );
    service = new RechargeService(repository, addresses, transactions, audit);
    const accounts = {
      requireRechargeInspection: (tx: PrismaService, id: string) =>
        tx.idBusinessV2ChatgptAccount.findUnique({ where: { id } }),
      requireCurrency: async () => null,
      savedLogin: () => ({
        email: 'synthetic@example.invalid',
        password: 'synthetic-password-only'
      })
    };
    local = new RechargeLocalService(
      repository,
      addresses,
      settings,
      service,
      transactions,
      audit,
      accounts as never
    );
    for (const employee of employees)
      await prisma.user.create({
        data: {
          id: employee.id,
          username: employee.username,
          displayName: employee.displayName,
          passwordHash: 'synthetic-not-a-valid-password'
        }
      });
    for (const [index, employee] of employees.entries()) {
      await prisma.idBusinessV2RechargeAddress.create({
        data: {
          id: addressIds[index]!,
          ownerId: employee.id,
          line1: 'Synthetic Billing Street ' + index
        }
      });
      await prisma.idBusinessV2ChatgptAccount.create({
        data: {
          id: accountIds[index]!,
          emailEncrypted: encryption.encrypt('synthetic-' + index + '@example.invalid')!,
          emailHash: hash('synthetic-account-' + index),
          emailMasked: 'synthetic@example.invalid',
          passwordEncrypted: encryption.encrypt('synthetic-password-only')!,
          officialAccountKey: hash('synthetic-official-' + index)
        }
      });
    }
  });
  beforeEach(async () => {
    // Only synthetic tasks in this newly owned empty database are changed.
    await prisma.idBusinessV2RechargeJob.updateMany({
      where: { ownerId: { in: employees.map((employee) => employee.id) } },
      data: { state: 'finished', leaseUntil: new Date(0) }
    });
    for (const [index, employee] of employees.entries())
      await settings.update(base(index), employee);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('不同员工同时开始，各自执行并且只能读取和取消自己的任务', async () => {
    const launches = await Promise.all([open(0), open(1)]);
    const lists = await Promise.all(employees.map((employee) => service.list(employee)));
    for (const [index, list] of lists.entries()) {
      expect(list.items.some((job) => job.id === launches[index]!.id)).toBe(true);
      expect(list.items.some((job) => job.id === launches[1 - index]!.id)).toBe(false);
      expect(JSON.stringify(list)).not.toContain('connection_snapshot_encrypted');
      expect(JSON.stringify(list)).not.toContain('synthetic-connector');
    }
    await expect(local.cancel(launches[1]!.id, employees[0]!)).rejects.toThrow('无权');
    await expect(local.access(launches[1]!.id, employees[0]!)).rejects.toThrow('本人');
    await local.cancel(launches[0]!.id, employees[0]!);
    expect((await repository.byId(launches[1]!.id)).result).not.toMatchObject({
      status: 'cancelling'
    });
  });
  it.each(['json', 'password'])('两名员工的充值任务可同时开始，登录方式：%s', async (method) => {
    const launches = await Promise.all(
      employees.map((employee, index) =>
        local.start(
          {
            id: randomUUID(),
            plan: 'plus',
            addressId: addressIds[index],
            windowName: '合成充值并发',
            lockedCurrency: 'USD',
            authorizeSinglePayment: true,
            ...(method === 'password'
              ? { chatgptAccountId: accountIds[index], useSavedCredentials: true }
              : {})
          },
          employee
        )
      )
    );
    expect(launches).toHaveLength(2);
    const jobs = await prisma.idBusinessV2RechargeJob.findMany({
      where: { id: { in: launches.map((launch) => launch.id) } }
    });
    expect(jobs.every((job) => job.state === 'running')).toBe(true);
    expect(JSON.stringify(jobs)).not.toContain('synthetic-password-only');
    expect(launches.every((launch) => launch.mode === 'payment')).toBe(true);
  });
  it('同一已保存账号在打开窗口之前即阻止第二笔自动任务', async () => {
    const results = await Promise.allSettled([
      open(0, { chatgptAccountId: accountIds[0] }),
      open(1, { chatgptAccountId: accountIds[0] })
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('同一员工两个同时开始的请求只接受一笔', async () => {
    const results = await Promise.allSettled([open(0), open(0)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('多个员工共用同一本机助手时只接受一笔，回环地址和旧端口别名不能绕过', async () => {
    await settings.update(
      {
        ...base(1),
        connectorToken: base(0).connectorToken,
        connectorUrl: 'http://localhost:55321'
      },
      employees[1]!
    );
    const results = await Promise.allSettled([open(0), open(1)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('官网确认了相同账号后只允许一笔继续，第二笔不能进入结算', async () => {
    const launches = await Promise.all([open(0), open(1)]);
    const accountKey = hash(randomUUID());
    const results = await Promise.allSettled(
      launches.map((launch) =>
        local.callback(launch.id, launch.agentToken, { type: 'restore', accountKey })
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await prisma.idBusinessV2RechargeJob.count({ where: { accountKey, state: 'running' } })
    ).toBe(1);
  });
  it('同一比特窗口不能被两名员工接管，伪造连接摘要不能覆盖任务快照', async () => {
    await settings.update(
      { ...base(1), localApiToken: base(0).localApiToken, localApiUrl: 'http://localhost:54345' },
      employees[1]!
    );
    const launches = await Promise.all([open(0), open(1)]);
    const browserProfileId = 'a'.repeat(32);
    const event = {
      type: 'progress',
      result: {
        stage: 'bitbrowser_open',
        browser_profile_id: browserProfileId,
        connection_api_key: hash('forged-fixture')
      }
    };
    await local.callback(launches[0]!.id, launches[0]!.agentToken, event);
    await expect(local.callback(launches[1]!.id, launches[1]!.agentToken, event)).rejects.toThrow(
      '独立资源'
    );
  });
  it('结束或超时仅释放本人任务，另一员工继续运行', async () => {
    const launches = await Promise.all([open(0, { directMode: true }), open(1)]);
    await local.cancel(launches[0]!.id, employees[0]!);
    const replacement = await open(0);
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: replacement.id },
      data: { leaseUntil: new Date(0) }
    });
    await expect(open(0)).resolves.toHaveProperty('id');
    expect((await repository.byId(launches[1]!.id)).state).toBe('running');
  });
  it('每员工多套配置独立保存，切回原配置保留原密钥，其他员工不可访问', async () => {
    const original = await settings.catalogAccess(employees[0]!);
    const created = await settings.update(
      {
        ...base(0),
        newConnectionProfile: true,
        connectionProfileName: '合成第二套',
        localApiToken: 'synthetic-second-api-token',
        connectorToken: 'synthetic-second-helper-token',
        groupName: '第二分组'
      },
      employees[0]!
    );
    expect(created.connectionProfileId).toBeTruthy();
    expect((await settings.get(employees[0]!)).groupName).toBe('第二分组');
    expect((await settings.get(employees[0]!, null)).groupName).toBe('合成分组0');
    const first = await settings.catalogAccess(employees[0]!, { connectionProfileId: null });
    expect(first.localApiToken).toBe(original.localApiToken);
    expect((await settings.get(employees[1]!)).connectionProfiles).toHaveLength(0);
    await expect(settings.get(employees[1]!, created.connectionProfileId!)).rejects.toThrow('本人');
    await expect(
      settings.catalogAccess(employees[1]!, { connectionProfileId: created.connectionProfileId })
    ).rejects.toThrow('本人');
    const stored = await prisma.idBusinessV2RechargeConnectionProfile.findUniqueOrThrow({
      where: { id: created.connectionProfileId! }
    });
    expect(JSON.stringify(stored)).not.toContain('synthetic-second-api-token');
    expect(JSON.stringify(stored)).not.toContain('synthetic-second-helper-token');
  });
  it('新配置不能继承旧接口秘密，保存失败不改变默认选择', async () => {
    const input = { ...base(0), localApiToken: undefined, connectorToken: undefined };
    await expect(
      settings.update(
        { ...input, newConnectionProfile: true, connectionProfileName: '缺少密钥的合成配置' },
        employees[0]!
      )
    ).rejects.toThrow('连接密钥');
    expect((await settings.get(employees[0]!)).connectionProfileId).toBeNull();
  });
  it('配置修改采用原始版本检查，迟到保存不能覆盖新值', async () => {
    const created = await settings.update(
      { ...base(0), newConnectionProfile: true, connectionProfileName: '并发保存合成配置' },
      employees[0]!
    );
    const update = {
      ...base(0),
      connectionProfileId: created.connectionProfileId,
      expectedUpdatedAt: created.updatedAt,
      connectionProfileName: '并发保存合成配置'
    };
    await settings.update({ ...update, groupName: '最新分组' }, employees[0]!);
    await expect(
      settings.update({ ...update, groupName: '迟到分组' }, employees[0]!)
    ).rejects.toThrow('已被修改');
    expect((await settings.get(employees[0]!)).groupName).toBe('最新分组');
  });
  it.each([false, true])(
    '升级前的未结束任务在修改配置时补齐原助手快照，租约已过期：%s',
    async (expired) => {
      const launch = await open(0);
      const job = await repository.byId(launch.id);
      const legacy = { ...(job.result as Record<string, unknown>) };
      for (const key of Object.keys(legacy)) if (key.startsWith('connection_')) delete legacy[key];
      await prisma.idBusinessV2RechargeJob.update({
        where: { id: launch.id },
        data: { result: legacy as never, ...(expired ? { leaseUntil: new Date(0) } : {}) }
      });
      await settings.update(
        { ...base(0), connectorToken: 'synthetic-new-legacy-helper' },
        employees[0]!
      );
      expect((await local.access(launch.id, employees[0]!)).connectorToken).toBe(
        base(0).connectorToken
      );
    }
  );
  it('超过一页的过期旧任务保留原助手，已有快照、其他员工、已结束及网页直连记录不改动', async () => {
    const launch = await open(0);
    const original = await repository.byId(launch.id);
    const legacy = { ...(original.result as Record<string, unknown>) };
    for (const key of Object.keys(legacy)) if (key.startsWith('connection_')) delete legacy[key];
    const expiredIds = Array.from({ length: 35 }, () => randomUUID());
    const finishedId = randomUUID();
    const directId = randomUUID();
    const otherOwnerId = randomUUID();
    const directResult = { ...legacy, transport: 'web_direct' };
    await prisma.idBusinessV2RechargeJob.createMany({
      data: [
        ...expiredIds.map((id) => ({
          ...original,
          id,
          leaseUntil: new Date(0),
          result: legacy as never
        })),
        { ...original, id: finishedId, state: 'finished', result: legacy as never },
        { ...original, id: directId, result: directResult as never },
        { ...original, id: otherOwnerId, ownerId: employees[1]!.id, result: legacy as never }
      ]
    });
    await settings.update(
      { ...base(0), connectorToken: 'synthetic-new-backlog-helper' },
      employees[0]!
    );
    for (const id of expiredIds) {
      expect((await local.access(id, employees[0]!)).connectorToken).toBe(base(0).connectorToken);
      expect((await repository.byId(id)).leaseUntil.getTime()).toBe(0);
    }
    expect((await repository.byId(launch.id)).result).toEqual(original.result);
    expect((await repository.byId(finishedId)).result).toEqual(legacy);
    expect((await repository.byId(directId)).result).toEqual(directResult);
    expect((await repository.byId(otherOwnerId)).result).toEqual(legacy);
  });
  it('任务启动后切换和修改配置，查询原任务仍连接原助手；API重启后也能恢复', async () => {
    const launch = await open(0);
    await settings.update(
      { ...base(0), connectorToken: 'synthetic-replacement-helper' },
      employees[0]!
    );
    expect((await local.access(launch.id, employees[0]!)).connectorToken).toBe(
      base(0).connectorToken
    );
    const restarted = new RechargeLocalService(
      repository,
      new RechargeAddressRepository(prisma),
      settings,
      service,
      new V2CommandTransactionManager(prisma),
      new V2TransactionalAuditService()
    );
    expect((await restarted.access(launch.id, employees[0]!)).connectorToken).toBe(
      base(0).connectorToken
    );
    const audits = await prisma.auditLog.findMany({
      where: { userId: { in: employees.map((employee) => employee.id) } }
    });
    expect(JSON.stringify(audits)).not.toContain('synthetic-connector');
    expect(JSON.stringify(audits)).not.toContain('connection_snapshot_encrypted');
  });
});
