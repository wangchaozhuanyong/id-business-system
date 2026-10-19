import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { SharedBankCardRepository } from '../bank-card-pool/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { BankRechargeCardRepository } from './persistence/bank-recharge-card.repository';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { RechargeManualSettlementService } from './recharge-manual-settlement.service';
import { rechargeAvailability } from './recharge-availability';
import { hash, object } from './recharge-validation';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('人工结单真实 MySQL 幂等、记账衔接及事务回滚', () => {
  let prisma: PrismaService,
    repository: RechargeRepository,
    transactions: V2CommandTransactionManager;
  let encryption: FieldEncryptionService;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      process.env.GITHUB_ACTIONS !== 'true' ||
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !/^\/id_business_v2_financial_integrity_\d+$/.test(parsed.pathname)
    )
      throw new Error('人工结单数据库验收仅允许 GitHub Actions 自有空隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    repository = new RechargeRepository(prisma);
    transactions = new V2CommandTransactionManager(prisma);
    encryption = new FieldEncryptionService({
      get: (key: string) =>
        key === 'FIELD_ENCRYPTION_KEY' ? 'manual-settlement-ci-only' : 'manual-settlement-ci-hash'
    } as never);
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'PHP' },
      create: { code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true },
      update: { active: true, minorUnits: 2 }
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  async function fixture() {
    const ownerId = randomUUID(),
      accountKey = hash(randomUUID()),
      id = randomUUID(),
      cardHash = hash(randomUUID()),
      newLease = randomUUID();
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'manual-settlement-' + ownerId,
        displayName: '人工结单隔离验收',
        passwordHash: 'synthetic-not-valid-password'
      }
    });
    const operator = {
      id: ownerId,
      username: 'fixture',
      displayName: '合成管理员',
      roles: ['admin'],
      permissions: []
    };
    const account = await prisma.idBusinessV2ChatgptAccount.create({
      data: {
        emailEncrypted: encryption.encrypt(id + '@example.invalid')!,
        emailHash: hash(id + '@example.invalid'),
        emailMasked: 'synthetic@example.invalid',
        officialAccountKey: accountKey
      }
    });
    const legacy = await prisma.idBusinessV2BankRechargeCard.create({
      data: { label: '人工结单合成卡', last4: '4242', currencyCode: 'PHP', numberHash: cardHash }
    });
    const shared = await prisma.onlineRechargeCard.create({
      data: {
        numberEncrypted: encryption.encrypt('synthetic-not-a-card')!,
        numberHash: cardHash,
        last4: '4242',
        expiryMonth: 12,
        expiryYear: 2039,
        leaseOwner: newLease,
        leaseExpiresAt: new Date(Date.now() + 60000)
      }
    });
    const identifier = 'oaics_manual_' + id.replaceAll('-', '');
    const facts = {
      account_key: accountKey,
      target_plan: 'plus',
      checkout_identifier: identifier,
      payment_status: 'requires_action',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      status: 'payment_result_unknown'
    };
    const source = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id,
        ownerId,
        accountKey,
        chatgptAccountId: account.id,
        cardId: legacy.id,
        action: 'bitbrowser',
        plan: 'plus',
        state: 'finished',
        leaseUntil: new Date(0),
        createdAt: new Date(Date.now() - 180000),
        result: toV2JsonDocument({
          ...facts,
          _shared_card_attempt_v1: {
            cardId: shared.id,
            authorizedAt: new Date(Date.now() - 120000).toISOString(),
            outcome: 'pending',
            holdReleasedAt: new Date().toISOString()
          }
        })
      }
    });
    await prisma.idBusinessV2RechargeRecord.createMany({
      data: [
        {
          ownerId,
          accountKey,
          fileKey: accountKey + '.json',
          revision: 2,
          document: {
            ...facts,
            payment_attempted: false,
            payment_requests_sent: 0,
            confirmation_requests_sent: 0,
            payment_status: 'not_attempted'
          }
        },
        {
          ownerId,
          accountKey,
          fileKey: `payments/${hash(identifier)}.json`,
          revision: 3,
          document: facts
        },
        { ownerId, accountKey, fileKey: 'history/synthetic.json', revision: 1, document: facts }
      ]
    });
    const service = (audit = new V2TransactionalAuditService()) => {
      const bankRepo = new BankRechargeRepository(prisma);
      const accounts = new BankRechargeAccountService(bankRepo, transactions, audit, encryption);
      const cards = new BankRechargeCardService(
        new BankRechargeCardRepository(prisma),
        accounts,
        transactions,
        audit,
        encryption,
        new SharedBankCardRepository(prisma, encryption, transactions, audit)
      );
      const orders = new BankRechargeOrderService(
        transactions,
        audit,
        accounts,
        bankRepo,
        new BankRechargeFeesService(bankRepo, {} as never),
        encryption
      );
      return new RechargeManualSettlementService(repository, orders, cards, audit, transactions);
    };
    const common = {
      operationId: randomUUID(),
      expectedUpdatedAt: source.updatedAt.toISOString(),
      identifier,
      confirmed: true,
      reason: '核对银行及订阅的最终结果'
    };
    const failure = {
      ...common,
      outcome: 'failure',
      noDebitConfirmed: true,
      notActivatedConfirmed: true
    };
    const success = {
      ...common,
      outcome: 'success',
      subscriptionConfirmed: true,
      amount: '982.14',
      currency: 'PHP',
      evidenceRef: 'BANK-' + id,
      openedAt: new Date(Date.now() - 60000).toISOString(),
      dueAt: new Date(Date.now() + 30 * 86400000).toISOString()
    };
    return {
      id,
      source,
      ownerId,
      accountKey,
      account,
      legacy,
      shared,
      newLease,
      operator,
      failure,
      success,
      service
    };
  }
  it('并发成功和重放只生成一个待补全订单、一次成功额度及订阅投影，保留新租约', async () => {
    const f = await fixture(),
      service = f.service();
    const [a, b] = await Promise.all([
      service.settle(f.id, f.success, f.operator),
      service.settle(f.id, f.success, f.operator)
    ]);
    expect(a.orderId).toBe(b.orderId);
    expect([a.alreadyResolved, b.alreadyResolved].sort()).toEqual([false, true]);
    const order = await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { rechargeJobId: f.id }
    });
    expect(order).toMatchObject({
      source: 'manual',
      channel: 'bitbrowser',
      status: 'pending_details',
      financeStatus: 'unposted',
      accountId: f.account.id,
      cardId: f.legacy.id,
      chargeCurrencyCode: 'PHP',
      verifiedAt: null,
      paymentEvidenceId: null
    });
    expect(order.chargeAmount?.toFixed(2)).toBe('982.14');
    const card = await prisma.onlineRechargeCard.findUniqueOrThrow({ where: { id: f.shared.id } });
    expect(card).toMatchObject({ successCount: 1, leaseOwner: f.newLease });
    expect(
      await prisma.idBusinessV2BankRechargeSubscription.findUnique({
        where: { accountId: f.account.id }
      })
    ).toMatchObject({ currentOrderId: order.id, plan: 'plus' });
    const job = await repository.findJob(prisma as never, f.id);
    expect(object(job!.result)).toMatchObject({
      payment_status: 'requires_action',
      confirmation_requests_sent: 1,
      manual_settlement: { outcome: 'success', orderId: order.id }
    });
    expect(
      await prisma.auditLog.count({
        where: { objectId: f.id, action: 'id_business_v2.auto_recharge.manual_settlement.complete' }
      })
    ).toBe(1);
    await expect(service.settle(f.id, f.failure, f.operator)).rejects.toThrow('已经结单');
  });
  it('失败释放原账号原单，保留事实和历史，不生成成功订单或订阅投影', async () => {
    const f = await fixture();
    await f.service().settle(f.id, f.failure, f.operator);
    const job = (await repository.findJob(prisma as never, f.id))!;
    const records = await repository.records(prisma as never, f.accountKey);
    expect(rechargeAvailability(job, records)).toMatchObject({
      payment: 'resolved',
      accountPaymentRestricted: false
    });
    expect(object(job.result)).toMatchObject({
      payment_attempted: true,
      confirmation_requests_sent: 1,
      _shared_card_attempt_v1: { outcome: 'resolved' }
    });
    expect(records.find((r) => r.fileKey.startsWith('history/'))!.document).not.toHaveProperty(
      'manual_settlement'
    );
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
    ).toBe(0);
    expect(
      await prisma.idBusinessV2BankRechargeSubscription.count({
        where: { accountId: f.account.id }
      })
    ).toBe(0);
    expect(
      await prisma.onlineRechargeCard.findUnique({ where: { id: f.shared.id } })
    ).toMatchObject({ successCount: 0, leaseOwner: f.newLease });
  });
  it.each(['success', 'failure'])(
    '%s 审计失败整笔回滚，包括订单、订阅、账本、任务及额度',
    async (outcome) => {
      const f = await fixture(),
        audit = new V2TransactionalAuditService(),
        original = audit.append.bind(audit);
      vi.spyOn(audit, 'append').mockImplementation((tx, event) => {
        if (event.action === 'id_business_v2.auto_recharge.manual_settlement.complete')
          throw new Error('synthetic audit fault');
        return original(tx, event);
      });
      await expect(
        f.service(audit).settle(f.id, outcome === 'success' ? f.success : f.failure, f.operator)
      ).rejects.toThrow('synthetic audit fault');
      const job = (await repository.findJob(prisma as never, f.id))!;
      expect(object(job.result).manual_settlement).toBeUndefined();
      expect(object(job.result)._shared_card_attempt_v1).toMatchObject({ outcome: 'pending' });
      const records = await repository.records(prisma as never, f.accountKey);
      expect(records.find((r) => r.fileKey === f.accountKey + '.json')!.revision).toBe(2);
      expect(records.every((r) => !object(r.document).manual_settlement)).toBe(true);
      expect(
        await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: f.id } })
      ).toBe(0);
      expect(
        await prisma.idBusinessV2BankRechargeSubscription.count({
          where: { accountId: f.account.id }
        })
      ).toBe(0);
      expect(
        await prisma.onlineRechargeCard.findUnique({ where: { id: f.shared.id } })
      ).toMatchObject({ successCount: 0, leaseOwner: f.newLease });
    }
  );
});
