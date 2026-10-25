import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { SharedBankCardRepository } from '../bank-card-pool/public-api';
import { RechargeBillingRepository } from './persistence/recharge-billing.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { RechargeNameRepository } from './persistence/recharge-name.repository';
import { RechargeNameService } from './recharge-name.service';
const url = process.env.V2_BILLING_ALLOCATION_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('账单永久排重真实MySQL及外键清理', () => {
  let prisma: PrismaService;
  const encryption = new FieldEncryptionService(
    new ConfigService({
      FIELD_ENCRYPTION_KEY: 'isolated-allocation-fixture',
      HASH_SECRET: 'isolated-allocation-fixture'
    })
  );
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !/^\/id_business_v2_billing_allocation_\d+$/.test(parsed.pathname)
    )
      throw new Error('仅允许本次GitHub隔离库');
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
        username: 'billing-' + id,
        displayName: '隔离测试',
        passwordHash: 'synthetic-invalid'
      }
    });
    const operator = {
      id,
      username: 'fixture',
      displayName: '隔离测试',
      roles: ['admin'],
      permissions: []
    };
    const transactions = new V2CommandTransactionManager(prisma),
      billing = new RechargeBillingRepository(encryption);
    const names = new RechargeNameService(
      new RechargeNameRepository(prisma),
      transactions,
      audit,
      encryption,
      new SharedBankCardRepository(prisma, encryption, transactions, audit),
      billing
    );
    const match = (allocationKey = randomUUID()) =>
      names.match({ number: '4111111111111111', allocationKey }, operator);
    return { operator, names, match, billing, transactions };
  }
  it('并发重读同一草稿只分配一份，空池恰好补充100条', async () => {
    const f = await fixture(),
      key = randomUUID();
    const [first, same] = await Promise.all([f.match(key), f.match(key)]);
    expect(first).toMatchObject({
      allocationId: same.allocationId,
      billingAddressId: same.billingAddressId,
      name: same.name
    });
    expect(
      await prisma.idBusinessV2RechargeAddress.count({ where: { ownerId: f.operator.id } })
    ).toBe(100);
    expect(
      await prisma.idBusinessV2RechargeBillingAllocation.count({
        where: { ownerId: f.operator.id }
      })
    ).toBe(1);
    const next = await f.match();
    expect(next.name).not.toBe(first.name);
    expect(next.billingAddressId).not.toBe(first.billingAddressId);
  });
  it('两个身份同时领取时姓名与地址指纹均不重复', async () => {
    const a = await fixture(),
      b = await fixture();
    const [left, right] = await Promise.all([a.match(), b.match()]);
    expect(left.name).not.toBe(right.name);
    expect(left.billingAddressId).not.toBe(right.billingAddressId);
    await expect(
      a.names.match(
        {
          number: '4111111111111111',
          allocationKey: randomUUID(),
          addressId: right.billingAddressId
        },
        a.operator
      )
    ).rejects.toThrow('已分配');
  });
  it('审计失败时100条地址、分配与新指纹整体回滚', async () => {
    class FailingAudit extends V2TransactionalAuditService {
      override append(): never {
        throw new Error('synthetic-audit-failure');
      }
    }
    const f = await fixture(new FailingAudit());
    await expect(f.match()).rejects.toThrow('synthetic-audit-failure');
    expect(
      await prisma.idBusinessV2RechargeAddress.count({ where: { ownerId: f.operator.id } })
    ).toBe(0);
    expect(
      await prisma.idBusinessV2RechargeBillingAllocation.count({
        where: { ownerId: f.operator.id }
      })
    ).toBe(0);
  });
  it('清理保留永久指纹与原使用记录，保护未知任务，迟到回调不重建', async () => {
    const f = await fixture(),
      first = await f.match(),
      oldAddressId = first.billingAddressId!;
    const oldAddress = await prisma.idBusinessV2RechargeAddress.findUniqueOrThrow({
      where: { id: oldAddressId }
    });
    const jobId = randomUUID(),
      unknownJobId = randomUUID();
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: jobId,
        ownerId: f.operator.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(),
        result: {
          addressId: oldAddressId,
          status: 'subscription_activated',
          payment_status: 'paid'
        }
      }
    });
    await prisma.idBusinessV2RechargeBillingAllocation.update({
      where: { id: first.allocationId },
      data: { jobId }
    });
    await prisma.idBusinessV2RechargeAddressUse.create({
      data: {
        jobId,
        ownerId: f.operator.id,
        addressId: oldAddressId,
        addressReference: oldAddressId
      }
    });
    await prisma.idBusinessV2RechargeAddress.update({
      where: { id: oldAddressId },
      data: { status: 'used', usedAt: new Date() }
    });
    const unknown = await prisma.idBusinessV2RechargeAddress.create({
      data: {
        ownerId: f.operator.id,
        line1: 'unknown-' + randomUUID(),
        status: 'used',
        usedAt: new Date()
      }
    });
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: unknownJobId,
        ownerId: f.operator.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'unknown',
        leaseUntil: new Date(),
        result: { addressId: unknown.id, payment_status: 'unknown' }
      }
    });
    await prisma.idBusinessV2RechargeAddress.updateMany({
      where: { ownerId: f.operator.id, status: 'unused' },
      data: { status: 'disabled' }
    });
    await f.match();
    expect(
      await prisma.idBusinessV2RechargeAddress.findUnique({ where: { id: oldAddressId } })
    ).toBeNull();
    expect(
      await prisma.idBusinessV2RechargeAddress.findUnique({ where: { id: unknown.id } })
    ).not.toBeNull();
    const use = await prisma.idBusinessV2RechargeAddressUse.findUniqueOrThrow({ where: { jobId } });
    expect(use).toMatchObject({ addressId: null, addressReference: oldAddressId });
    const kept = await prisma.idBusinessV2RechargeBillingAllocation.findUniqueOrThrow({
      where: { id: first.allocationId }
    });
    expect(kept.addressHash).toBe(f.billing.hashAddress(oldAddress));
    expect(kept.nameEncrypted).toBeNull();
    const addresses = new RechargeAddressRepository(prisma, f.billing);
    const replay = await f.transactions.execute(
      (tx) => addresses.markUsed(tx, f.operator.id, oldAddressId, jobId),
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator: f.operator }
    );
    expect(replay.changed).toBe(false);
    expect(
      await prisma.idBusinessV2RechargeAddress.findUnique({ where: { id: oldAddressId } })
    ).toBeNull();
  });
});
