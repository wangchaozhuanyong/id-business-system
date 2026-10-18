import { SharedBankCardRepository } from '../bank-card-pool/public-api';
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
import { BankRechargeCardService } from './bank-recharge-card.service';
import { BankRechargeCardRepository } from './persistence/bank-recharge-card.repository';
import { finalizeRechargeCardBilling } from './recharge-card-billing';

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
      encryption,
      new SharedBankCardRepository(prisma, encryption, tx, audit)
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

  it('超过一页已用历史时仍在分页前选出最早未使用地址', async () => {
    const f = await fixture();
    const oldestId = randomUUID();
    await prisma.idBusinessV2RechargeAddress.createMany({
      data: [
        {
          id: oldestId,
          ownerId: f.operator.id,
          line1: 'Synthetic oldest ' + oldestId,
          status: 'unused',
          createdAt: new Date('2020-01-01T00:00:00Z')
        },
        ...Array.from({ length: 2000 }, (_, index) => ({
          ownerId: f.operator.id,
          line1: 'Synthetic used ' + oldestId + ' ' + index,
          status: 'used',
          usedAt: new Date('2026-10-01T00:00:00Z'),
          createdAt: new Date('2026-10-01T00:00:00Z')
        }))
      ]
    });
    const query = { page: 1, pageSize: 2000, keyword: '' };
    const recent = await f.addresses.list(f.operator.id, { ...query, status: 'all' });
    expect(recent.items).toHaveLength(2000);
    expect(recent.items.some((item) => item.id === oldestId)).toBe(false);
    const unused = await f.addresses.list(f.operator.id, { ...query, status: 'unused' });
    expect(unused.items.map((item) => item.id)).toEqual([oldestId]);
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
  it('同一卡两笔合成成功分别消费下一条地址，卡片首次地址和两笔任务历史均保留', async () => {
    const f = await fixture();
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'USD' },
      create: { code: 'USD', name: '美元', minorUnits: 2, active: true },
      update: {}
    });
    const transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    const cards = new BankRechargeCardService(
      new BankRechargeCardRepository(prisma),
      {} as never,
      transactions,
      audit,
      encryption,
      new SharedBankCardRepository(prisma, encryption, transactions, audit)
    );
    await f.service.generateAddresses({ count: 2 }, f.operator);
    const card = await transactions.execute(
      (tx) =>
        f.names.prepareCard(
          tx,
          {
            number: '4000000000009995',
            expiry: '12/39',
            name: 'Synthetic Owner',
            currencyCode: 'USD'
          },
          f.operator
        ),
      {
        changedScopes: ['auto-recharge', 'online-recharge'],
        requestId: randomUUID(),
        operator: f.operator
      }
    );
    const consumed: string[] = [];
    const jobIds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const candidate = (
        await f.addresses.list(f.operator.id, {
          page: 1,
          pageSize: 1,
          keyword: '',
          status: 'unused'
        })
      ).items[0]!;
      consumed.push(candidate.id);
      const job = await prisma.idBusinessV2RechargeJob.create({
        data: {
          id: randomUUID(),
          ownerId: f.operator.id,
          cardId: card.id,
          action: 'bitbrowser',
          state: 'finished',
          plan: 'plus',
          leaseUntil: new Date(0),
          billingNameEncrypted: encryption.encrypt('Synthetic Owner'),
          result: { addressId: candidate.id, status: 'subscription_activated' }
        }
      });
      jobIds.push(job.id);
      await transactions.execute(
        async (tx) => {
          await finalizeRechargeCardBilling(tx, job, { cardId: card.id }, cards, f.names);
          await f.addresses.markUsed(tx, f.operator.id, candidate.id, job.id);
        },
        {
          changedScopes: ['auto-recharge', 'online-recharge'],
          requestId: randomUUID(),
          operator: f.operator
        }
      );
    }
    expect(new Set(consumed).size).toBe(2);
    expect(
      (await prisma.idBusinessV2BankRechargeCard.findUniqueOrThrow({ where: { id: card.id } }))
        .billingAddressId
    ).toBe(consumed[0]);
    const uses = await prisma.idBusinessV2RechargeAddressUse.findMany({
      where: { jobId: { in: jobIds } }
    });
    expect(uses).toHaveLength(2);
    expect(uses.map((item) => item.addressId).sort()).toEqual([...consumed].sort());
    for (const [index, jobId] of jobIds.entries()) {
      const stored = await prisma.idBusinessV2RechargeJob.findUniqueOrThrow({
        where: { id: jobId }
      });
      expect(stored.result).toMatchObject({ addressId: consumed[index] });
    }
    expect(
      (
        await f.addresses.list(f.operator.id, {
          page: 1,
          pageSize: 1,
          keyword: '',
          status: 'unused'
        })
      ).total
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          userId: f.operator.id,
          action: 'id_business_v2.bank_recharge.card.billing_conflict'
        }
      })
    ).toBe(0);
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
