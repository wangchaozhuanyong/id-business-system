import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeLifecycleRepository } from './persistence/bank-recharge-lifecycle.repository';

// 沿用远端 CI 的专用隔离实例，不接受生产或普通开发库；本机无此变量时显式跳过。
const url = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !/^\/id_business_v2_(financial|rollback)_integrity_\d+$/.test(parsed.pathname)
  )
    throw new Error('出售状态测试仅允许 CI 专用隔离数据库');
}
const describeMysql = url ? describe : describe.skip;
describeMysql('ChatGPT 出售状态 MySQL 事务', () => {
  let prisma: PrismaService, service: BankRechargeAccountService;
  let operator: AuthenticatedUser, repository: BankRechargeRepository;
  const ids: string[] = [];
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    const user = await prisma.user.create({
      data: {
        username: `sale-fixture-${randomUUID()}`,
        displayName: '出售状态隔离验收',
        passwordHash: 'isolated-test-only'
      }
    });
    operator = { id: user.id, roles: ['admin'], permissions: [] } as unknown as AuthenticatedUser;
    repository = new BankRechargeRepository(prisma);
    service = new BankRechargeAccountService(
      repository,
      new V2CommandTransactionManager(prisma),
      new V2TransactionalAuditService(),
      { decrypt: () => null } as never
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    // 仅清理专用隔离库中本文件生成的精确账号编号，审计记录随实例保留。
    await prisma.idBusinessV2ChatgptAccount.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });
  async function account(registered = true) {
    const id = randomUUID();
    ids.push(id);
    return prisma.idBusinessV2ChatgptAccount.create({
      data: {
        id,
        registered,
        emailEncrypted: 'fixture-encrypted',
        emailHash: createHash('sha256').update(id).digest('hex'),
        emailMasked: `${id.slice(0, 4)}***@example.invalid`,
        updatedAt: new Date('2026-01-01T00:00:00Z')
      }
    });
  }
  const read = (id: string) =>
    prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id } });

  it('数据库默认未出售，未注册请求被拒绝且不留出售审计', async () => {
    const a = await account(false);
    expect(a.saleStatus).toBe('unsold');
    expect(a.soldAt).toBeNull();
    await expect(
      service.updateAccount(
        a.id,
        { saleStatus: 'sold', expectedUpdatedAt: a.updatedAt.toISOString() },
        operator
      )
    ).rejects.toThrow('只有已标记注册');
    expect((await read(a.id)).saleStatus).toBe('unsold');
    expect(await prisma.auditLog.count({ where: { objectId: a.id } })).toBe(0);
  });
  it('双向切换及重复确认保留时间，凭据和续费资格不变，审计记录原值', async () => {
    const a = await account();
    await service.updateAccount(
      a.id,
      { saleStatus: 'sold', expectedUpdatedAt: a.updatedAt.toISOString() },
      operator
    );
    const sold = await read(a.id);
    expect(sold.soldAt).toBeInstanceOf(Date);
    expect(sold.emailEncrypted).toBe(a.emailEncrypted);
    await expect(
      prisma.$transaction((tx) => service.requireActive(tx, a.id))
    ).resolves.toMatchObject({ saleStatus: 'sold' });
    await service.updateAccount(
      a.id,
      { saleStatus: 'sold', expectedUpdatedAt: sold.updatedAt.toISOString() },
      operator
    );
    const repeated = await read(a.id);
    expect(repeated.soldAt).toEqual(sold.soldAt);
    await service.updateAccount(
      a.id,
      { saleStatus: 'unsold', expectedUpdatedAt: repeated.updatedAt.toISOString() },
      operator
    );
    expect(await read(a.id)).toMatchObject({ saleStatus: 'unsold', soldAt: null });
    const audits = await prisma.auditLog.findMany({
      where: { objectId: a.id },
      orderBy: { createdAt: 'desc' }
    });
    expect(
      audits.some(
        (log) =>
          (log.beforeData as Record<string, unknown>)?.saleStatus === 'sold' &&
          (log.afterData as Record<string, unknown>)?.saleStatus === 'unsold'
      )
    ).toBe(true);
  });
  it('审计失败时真实回滚出售状态、时间和账号版本', async () => {
    const a = await account();
    const broken = new BankRechargeAccountService(
      repository,
      new V2CommandTransactionManager(prisma),
      {
        append: async () => {
          throw new Error('出售审计失败');
        }
      } as never,
      {} as never
    );
    await expect(
      broken.updateAccount(
        a.id,
        { saleStatus: 'sold', expectedUpdatedAt: a.updatedAt.toISOString() },
        operator
      )
    ).rejects.toThrow('出售审计失败');
    expect(await read(a.id)).toMatchObject({
      saleStatus: 'unsold',
      soldAt: null,
      updatedAt: a.updatedAt
    });
  });
  it('两个同版本请求只能有一个成功，旧版本不覆盖新状态', async () => {
    const a = await account();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.updateAccount(
          a.id,
          { saleStatus: 'sold', expectedUpdatedAt: a.updatedAt.toISOString() },
          operator
        )
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { objectId: a.id } })).toBe(1);
    await expect(
      service.updateAccount(
        a.id,
        { saleStatus: 'unsold', expectedUpdatedAt: a.updatedAt.toISOString() },
        operator
      )
    ).rejects.toThrow('已变化');
    expect((await read(a.id)).saleStatus).toBe('sold');
  });
  it('原生命周期仓储的删除和恢复保留出售状态及标记时间', async () => {
    const a = await account();
    await service.updateAccount(
      a.id,
      { saleStatus: 'sold', expectedUpdatedAt: a.updatedAt.toISOString() },
      operator
    );
    const sold = await read(a.id);
    const lifecycle = new BankRechargeLifecycleRepository(prisma);
    await prisma.$transaction((tx) => lifecycle.updateAccount(tx, a.id, new Date(), operator.id));
    expect(await read(a.id)).toMatchObject({ saleStatus: 'sold', soldAt: sold.soldAt });
    await prisma.$transaction((tx) => lifecycle.updateAccount(tx, a.id, null, operator.id));
    expect(await read(a.id)).toMatchObject({
      saleStatus: 'sold',
      soldAt: sold.soldAt,
      status: 'disabled'
    });
  });
});
