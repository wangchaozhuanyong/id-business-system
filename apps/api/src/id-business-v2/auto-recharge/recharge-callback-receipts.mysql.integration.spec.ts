import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeAddressRepository } from './persistence/recharge-address.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { RechargeService } from './recharge.service';
import { RechargeLocalService } from './recharge-local.service';
import { hash } from './recharge-validation';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('本机回执真实MySQL并发和回滚', () => {
  let prisma: PrismaService;
  let repository: RechargeRepository;
  let local: RechargeLocalService;
  let service: RechargeService;
  const ownerId = randomUUID();
  const operator = {
    id: ownerId,
    username: 'receipt-fixture',
    displayName: '收据合成验收',
    roles: ['admin'],
    permissions: []
  };
  const quote = {
    plan: 'plus',
    today: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    tax: { amount: '0.00', amount_minor: 0, currency: 'USD' },
    renewal: { amount: '20.00', amount_minor: 2000, currency: 'USD' },
    renewal_interval: 'monthly'
  };

  const create = (audit = new V2TransactionalAuditService()) => {
    const transactions = new V2CommandTransactionManager(prisma);
    const addresses = new RechargeAddressRepository(prisma);
    const orders = new BankRechargeOrderService(
      transactions,
      audit,
      {
        ensureVerifiedCurrency: async () => ({ minorUnits: 2 }),
        ensureAccountForVerifiedPayment: async () => null
      } as never,
      new BankRechargeRepository(prisma),
      {} as never,
      new FieldEncryptionService(
        new ConfigService({
          FIELD_ENCRYPTION_KEY: 'synthetic-test-only',
          HASH_SECRET: 'synthetic-only'
        })
      )
    );
    const service = new RechargeService(
      repository,
      addresses,
      transactions,
      audit,
      undefined,
      orders
    );
    return {
      service,
      local: new RechargeLocalService(
        repository,
        addresses,
        {} as never,
        service,
        transactions,
        audit
      )
    };
  };

  const fixture = async () => {
    const id = randomUUID();
    const addressId = randomUUID();
    const accountKey = hash(randomUUID());
    const token = 'synthetic-token-' + randomUUID();
    const checkout = 'cs_' + randomUUID().replaceAll('-', '');
    await prisma.idBusinessV2RechargeAddress.create({
      data: { id: addressId, ownerId, line1: 'Synthetic Receipt ' + id }
    });
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id,
        ownerId,
        accountKey,
        action: 'bitbrowser',
        state: 'running',
        plan: 'plus',
        nonceHash: hash(token),
        leaseUntil: new Date(Date.now() + 45 * 60000),
        result: {
          mode: 'payment',
          account_matched: true,
          addressId,
          checkout_identifier: checkout,
          quote,
          quote_authority: 'official_checkout_response',
          quote_digest: hash(checkout),
          payment_attempted: false,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        }
      }
    });
    const report = (paid = false) => ({
      account_key: accountKey,
      account_matched: true,
      target_plan: 'plus',
      checkout_identifier: checkout,
      quote,
      quote_digest: hash(checkout),
      quote_authority: 'official_checkout_response',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      payment_status: paid ? 'paid' : 'unknown',
      status: paid ? 'subscription_activated' : 'payment_result_unknown',
      ...(paid
        ? {
            payment_outcome: 'subscription_activated',
            payment_evidence: {
              kind: 'checkout_session',
              identifier: checkout,
              amount_minor: 2000,
              currency: 'USD'
            }
          }
        : {})
    });
    return {
      id,
      addressId,
      accountKey,
      token,
      checkout,
      report,
      callback: (value: unknown) => local.callback(id, token, value)
    };
  };

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !/^\/id_business_v2_employee_connections_flow_\d+$/.test(parsed.pathname)
    )
      throw new Error('收据测试只允许连接本次自有空隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'receipts-' + ownerId,
        displayName: operator.displayName,
        passwordHash: 'synthetic-not-valid-password'
      }
    });
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'USD' },
      create: { code: 'USD', name: '美元', minorUnits: 2, active: true },
      update: {}
    });
    repository = new RechargeRepository(prisma);
    ({ local, service } = create());
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('并发成功终态只建一个订单、一次地址使用、一条审计，重启后精确重放零重复副作用', async () => {
    const f = await fixture();
    const input = { type: 'finished', result: f.report(true) };
    const results = await Promise.all([f.callback(input), f.callback(input)]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    const before = await repository.byId(f.id);
    const audits = await prisma.auditLog.count({ where: { objectId: f.id } });
    ({ local, service } = create());
    await expect(f.callback(input)).resolves.toEqual({ ok: true });
    const after = await repository.byId(f.id);
    expect(after.result).toEqual(before.result);
    expect(after.nonceHash).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
    ).toBe(1);
    expect(await prisma.idBusinessV2RechargeAddressUse.count({ where: { jobId: f.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { objectId: f.id } })).toBe(audits);
    expect(JSON.stringify(await service.list(operator))).not.toContain('_callback_private_v1');
  });

  it('完成为未知后并发补收真实付款，绑定原单，不重新占窗口，不产生第二个订单', async () => {
    const f = await fixture();
    const first = { type: 'finished', result: f.report() };
    await f.callback(first);
    const unknown = await repository.byId(f.id);
    const nextId = randomUUID();
    await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: nextId,
        ownerId,
        action: 'bitbrowser',
        state: 'running',
        plan: 'plus',
        accountKey: f.accountKey,
        leaseUntil: new Date(Date.now() + 600000),
        result: { mode: 'open_browser' }
      }
    });
    const success = { type: 'finished', result: f.report(true) };
    await Promise.all([f.callback(success), f.callback(success)]);
    await f.callback(first);
    const result = await repository.byId(f.id);
    expect(result).toMatchObject({
      state: 'finished',
      nonceHash: null,
      result: { payment_status: 'paid' }
    });
    expect(result.leaseUntil).toEqual(unknown.leaseUntil);
    expect((await repository.byId(nextId)).state).toBe('running');
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
    ).toBe(1);
    expect(await prisma.idBusinessV2RechargeAddressUse.count({ where: { jobId: f.id } })).toBe(1);
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: nextId },
      data: { state: 'finished' }
    });
  });

  it('账本同n内容并发提交只递增一次，相同重发不再保存和记审计，不同内容严格冲突', async () => {
    const f = await fixture();
    const receipt = {
      type: 'ledger',
      accountKey: f.accountKey,
      fileKey: `payments/${hash(f.checkout)}.json`,
      revision: 0,
      document: f.report()
    };
    await Promise.all([f.callback(receipt), f.callback(receipt)]);
    const record = await prisma.idBusinessV2RechargeRecord.findUnique({
      where: {
        accountKey_fileKey: { accountKey: f.accountKey, fileKey: receipt.fileKey }
      }
    });
    expect(record?.revision).toBe(1);
    const audits = await prisma.auditLog.count({ where: { objectId: f.id } });
    await expect(f.callback(receipt)).resolves.toEqual({ revision: 1 });
    expect(await prisma.auditLog.count({ where: { objectId: f.id } })).toBe(audits);
    await expect(
      f.callback({ ...receipt, document: { ...receipt.document, stage: 'changed' } })
    ).rejects.toThrow('版本冲突');
    expect(await prisma.idBusinessV2RechargeAddressUse.count({ where: { jobId: f.id } })).toBe(1);
  });

  it('付款结果写入后审计失败整体回滚，旧nonce和地址保留，可用同一回执安全恢复', async () => {
    const f = await fixture();
    const before = await repository.byId(f.id);
    const audit = new V2TransactionalAuditService();
    const append = audit.append.bind(audit);
    audit.append = (async (
      tx: Parameters<typeof append>[0],
      input: Parameters<typeof append>[1]
    ) => {
      await append(tx, input);
      if (input.action === 'id_business_v2.bank_recharge.order.create_from_verified_payment')
        throw new Error('synthetic audit rollback');
    }) as unknown as typeof audit.append;
    const failed = create(audit);
    const input = { type: 'finished', result: f.report(true) };
    await expect(failed.local.callback(f.id, f.token, input)).rejects.toThrow(
      'synthetic audit rollback'
    );
    expect((await repository.byId(f.id)).nonceHash).toBe(before.nonceHash);
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
    ).toBe(0);
    expect(await prisma.idBusinessV2RechargeAddressUse.count({ where: { jobId: f.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { objectId: f.id } })).toBe(0);
    await expect(f.callback(input)).resolves.toEqual({ ok: true });
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
    ).toBe(1);
  });
});
