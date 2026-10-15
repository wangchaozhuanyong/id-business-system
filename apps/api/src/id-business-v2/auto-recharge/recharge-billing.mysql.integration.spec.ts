import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeNameRepository } from './persistence/recharge-name.repository';
import { RechargeService } from './recharge.service';
import { RechargeNameService } from './recharge-name.service';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('比特账单生成真实MySQL事务与归属', () => {
  let prisma: PrismaService;
  const encryption = new FieldEncryptionService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: 'isolated-billing-fixture',
      HASH_SECRET: 'isolated-billing-fixture'
    })
  );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !/^\/id_business_v2_employee_connections_flow_\d+$/.test(parsed.pathname)
    )
      throw new Error('账单生成测试仅允许本次空隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  async function fixture(audit = new V2TransactionalAuditService()) {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        username: 'billing-fixture-' + id,
        displayName: '账单隔离验收',
        passwordHash: 'synthetic-invalid'
      }
    });
    const operator = {
      id,
      username: 'fixture',
      displayName: '隔离验收',
      roles: ['admin'],
      permissions: []
    };
    const tx = new V2CommandTransactionManager(prisma);
    const addresses = new RechargeAddressRepository(prisma);
    const service = new RechargeService({} as never, addresses, tx, audit);
    const names = new RechargeNameService(
      new RechargeNameRepository(prisma),
      tx,
      audit,
      encryption
    );
    return { operator, service, names, addresses };
  }
  it('空地址库批量生成完整明细，仅本操作人可读，审计与提交一起生效', async () => {
    const a = await fixture(),
      b = await fixture();
    const result = await a.service.generateAddresses({ count: 10 }, a.operator);
    expect(result.items).toHaveLength(10);
    expect(new Set(result.items.map((x) => x.id)).size).toBe(10);
    for (const row of result.items)
      expect(row).toMatchObject({ ownerId: a.operator.id, country: 'US', status: 'unused' });
    expect(result.items.every((x) => x.city && x.state && /^\d{5}$/.test(x.postalCode))).toBe(true);
    expect((await a.service.listAddresses({}, a.operator)).total).toBe(10);
    expect((await b.service.listAddresses({}, b.operator)).total).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { userId: a.operator.id, action: 'id_business_v2.auto_recharge.addresses.generate' }
      })
    ).toBe(1);
  });
  it('审计失败时整批地址回滚', async () => {
    class FailingAudit extends V2TransactionalAuditService {
      override append(): never {
        throw new Error('synthetic-audit-failure');
      }
    }
    const f = await fixture(new FailingAudit());
    await expect(f.service.generateAddresses({ count: 10 }, f.operator)).rejects.toThrow(
      'synthetic-audit-failure'
    );
    expect(
      await prisma.idBusinessV2RechargeAddress.count({ where: { ownerId: f.operator.id } })
    ).toBe(0);
  });
  it('两批并发生成各有独立编号，不消费其他操作人或停用的地址', async () => {
    const f = await fixture();
    const old = await prisma.idBusinessV2RechargeAddress.create({
      data: {
        ownerId: f.operator.id,
        line1: 'Synthetic disabled street ' + randomUUID(),
        status: 'disabled'
      }
    });
    const batches = await Promise.all([
      f.service.generateAddresses({ count: 3 }, f.operator),
      f.service.generateAddresses({ count: 3 }, f.operator)
    ]);
    expect(new Set(batches.flatMap((x) => x.items.map((y) => y.id))).size).toBe(6);
    expect(
      (await prisma.idBusinessV2RechargeAddress.findUniqueOrThrow({ where: { id: old.id } })).status
    ).toBe('disabled');
  });
  it('同一卡并发匹配只保留一个加密姓名，不依赖姓名池', async () => {
    const f = await fixture();
    // Published payment-provider test number; used only as an isolated blind-index input.
    const number = '4242424242424242';
    const results = await Promise.all([
      f.names.match({ number }, f.operator),
      f.names.match({ number }, f.operator)
    ]);
    expect(results[0].name).toBe(results[1].name);
    expect(results[0].name).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
    const stored = await prisma.idBusinessV2RechargeCardName.findUniqueOrThrow({
      where: { numberHash: encryption.hash(number)! }
    });
    expect(stored.nameEncrypted).not.toBe(results[0].name);
    expect(encryption.decrypt(stored.nameEncrypted)).toBe(results[0].name);
    expect(stored.nameId).toBeNull();
  });
  it('已有确认姓名绑定不会被新生成规则替换', async () => {
    const f = await fixture();
    const number = '4000000000000002';
    await prisma.idBusinessV2RechargeCardName.create({
      data: {
        numberHash: encryption.hash(number)!,
        nameEncrypted: encryption.encrypt('Legacy Example')!,
        confirmed: true
      }
    });
    expect(await f.names.match({ number }, f.operator)).toMatchObject({
      name: 'Legacy Example',
      confirmed: true
    });
  });
  it('姓名审计失败时新绑定一起回滚', async () => {
    class FailingAudit extends V2TransactionalAuditService {
      override append(): never {
        throw new Error('synthetic-name-audit-failure');
      }
    }
    const f = await fixture(new FailingAudit());
    const number = '5555555555554444';
    await expect(f.names.match({ number }, f.operator)).rejects.toThrow(
      'synthetic-name-audit-failure'
    );
    expect(
      await prisma.idBusinessV2RechargeCardName.findUnique({
        where: { numberHash: encryption.hash(number)! }
      })
    ).toBeNull();
  });
});
