import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { RechargeService } from './recharge.service';
import { hash } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';

const url = process.env.V2_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('付款可用性真实 MySQL 归属、互斥及审计事务', () => {
  let prisma: PrismaService;
  let repository: RechargeRepository;
  const service = (audit = new V2TransactionalAuditService()) =>
    new RechargeService(repository, {} as never, new V2CommandTransactionManager(prisma), audit);
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      !/^\/id_business_v2_employee_connections_flow_\d+$/.test(parsed.pathname)
    )
      throw new Error('付款可用性测试只允许本次自有空隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    repository = new RechargeRepository(prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  async function fixture(paymentStatus = 'declined', resultPatch: Record<string, unknown> = {}) {
    const ownerId = randomUUID(),
      accountKey = hash(randomUUID()),
      sourceId = randomUUID();
    const checkout = 'cs_fixture_' + sourceId.replaceAll('-', '');
    await prisma.user.create({
      data: {
        id: ownerId,
        username: 'availability-' + ownerId,
        displayName: '隔离付款核验',
        passwordHash: 'synthetic-not-valid-password'
      }
    });
    const operator = {
      id: ownerId,
      username: 'fixture',
      displayName: '隔离核验',
      roles: ['admin'],
      permissions: []
    };
    const source = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: sourceId,
        ownerId,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        createdAt: new Date(Date.now() - 60000),
        updatedAt: new Date(Date.now() - 30000),
        leaseUntil: new Date(Date.now() - 20000),
        result: toV2JsonDocument({
          window_name: '核对窗口-' + sourceId,
          payment_attempted: true,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1,
          payment_status: paymentStatus,
          checkout_identifier: checkout,
          ...resultPatch
        })
      }
    });
    const verification = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId,
        accountKey,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(),
        result: {
          mode: 'open_browser',
          account_matched: true,
          current_plan: 'free',
          payment_attempted: false,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        }
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
            account_key: accountKey,
            target_plan: 'plus',
            checkout_identifier: checkout,
            payment_status: 'not_attempted',
            payment_attempted: false,
            confirmation_requests_sent: 0
          }
        },
        {
          ownerId,
          accountKey,
          fileKey: 'payments/' + hash(checkout) + '.json',
          revision: 3,
          document: {
            account_key: accountKey,
            target_plan: 'plus',
            checkout_identifier: checkout,
            payment_status: paymentStatus,
            payment_attempted: true,
            payment_requests_sent: 1,
            confirmation_requests_sent: 1
          }
        }
      ]
    });
    const input = { confirmNoDebit: true, verificationJobId: verification.id };
    return { ownerId, operator, accountKey, source, verification, input };
  }
  it('分页及 JSON 窗口搜索只返回当前操作人的资料，读取不写审计', async () => {
    const a = await fixture(),
      b = await fixture();
    const before = await prisma.auditLog.count({ where: { userId: a.ownerId } });
    const page = await service().review({ page: 1, pageSize: 1, search: '核对窗口-' }, a.operator);
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(a.source.id);
    expect(page.items[0]).not.toHaveProperty('accountKey', a.accountKey);
    expect(page.items.some((j) => j.ownerId === b.ownerId)).toBe(false);
    expect(
      (await service().review({ page: 2, pageSize: 1, search: '核对窗口-' }, a.operator)).items
    ).toEqual([]);
    expect(await prisma.auditLog.count({ where: { userId: a.ownerId } })).toBe(before);
  });
  it('并发处理与重放只产生一个处理任务和一条审计，并保留原付款事实', async () => {
    const f = await fixture();
    const result = await Promise.all([
      service().resolveDeclined(f.source.id, f.input, f.operator),
      service().resolveDeclined(f.source.id, f.input, f.operator)
    ]);
    expect(result[0]!.id).toBe(result[1]!.id);
    const records = await repository.records(prisma as never, f.accountKey);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.fileKey.startsWith('payments/'))!.document).toMatchObject({
      payment_status: 'declined',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      operator_resolution: 'confirmed_declined_no_charge'
    });
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: {
          objectId: f.source.id,
          action: 'id_business_v2.auto_recharge.decline_resolution.complete'
        }
      })
    ).toBe(1);
    expect(await repository.findRunningJob(prisma as never, f.ownerId)).toBeNull();
  });
  it.each(['unknown', 'requires_action', 'paid'])('拒绝 %s 原单且保持持久事实', async (status) => {
    const f = await fixture(status),
      before = await repository.records(prisma as never, f.accountKey);
    await expect(service().resolveDeclined(f.source.id, f.input, f.operator)).rejects.toThrow();
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(before);
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(2);
  });
  it('审计写入失败时标记、任务和记录版本一起回滚', async () => {
    const f = await fixture(),
      before = await repository.records(prisma as never, f.accountKey);
    class FailingAudit extends V2TransactionalAuditService {
      override append(): never {
        throw new Error('synthetic-audit-failure');
      }
    }
    await expect(
      service(new FailingAudit()).resolveDeclined(f.source.id, f.input, f.operator)
    ).rejects.toThrow('synthetic-audit-failure');
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(before);
    expect(await repository.byId(f.source.id)).toEqual(f.source);
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(2);
  });
  it('不能用付款之前的免费版核实或其他操作人的账号解除限制', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(service().resolveDeclined(f.source.id, f.input, other.operator)).rejects.toThrow();
    await prisma.idBusinessV2RechargeJob.update({
      where: { id: f.verification.id },
      data: {
        createdAt: new Date(f.source.createdAt.getTime() - 1000),
        result: toV2JsonDocument(f.verification.result as object)
      }
    });
    await expect(service().resolveDeclined(f.source.id, f.input, f.operator)).rejects.toThrow(
      '需要付款之后'
    );
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(2);
  });
  it('网页直连原单人工验证失败声明并发重放仅处理一次，保留原未知付款和次数', async () => {
    const f = await fixture('unknown', {
      transport: 'web_direct',
      reason: 'unexpected_payment_observed',
      _direct_unexpected_payment_v1: { observed: true, observedRequests: 1 }
    });
    const original = f.source.result as Record<string, unknown>;
    const input = {
      ...f.input,
      verificationFailureObservation: {
        checkoutIdentifier: String(original.checkout_identifier),
        officialMessage: 'payment_method_verification_failed'
      }
    };
    const results = await Promise.all([
      service().resolveDeclined(f.source.id, input, f.operator),
      service().resolveDeclined(f.source.id, input, f.operator)
    ]);
    expect(results[0]!.id).toBe(results[1]!.id);
    const source = await repository.byId(f.source.id);
    expect(source?.result).toMatchObject({
      ...original,
      operator_resolution: 'confirmed_verification_failed_no_charge',
      resolution_basis: 'operator_observed_official_failure'
    });
    const records = await repository.records(prisma as never, f.accountKey);
    expect(records.find((r) => r.fileKey.startsWith('payments/'))?.document).toMatchObject({
      payment_status: 'unknown',
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      operator_resolution: 'confirmed_verification_failed_no_charge',
      resolution_basis: 'operator_observed_official_failure'
    });
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: {
          objectId: f.source.id,
          action: 'id_business_v2.auto_recharge.verification_failure_resolution.complete'
        }
      })
    ).toBe(1);
  });
  it('同档新结算原单完整归档与替换原子提交，失败回滚且重放仅留一份归档', async () => {
    const f = await fixture('unknown', {
      transport: 'web_direct',
      reason: 'official_payment_method_verification_failed'
    });
    await service().resolveDeclined(f.source.id, f.input, f.operator);
    const before = await repository.records(prisma as never, f.accountKey);
    const checkout = before.find((record) => record.fileKey === `${f.accountKey}.json`)!;
    const archiveKey = `history/${rechargeDocumentDigest(checkout.document)}.json`;
    const input = {
      accountKey: f.accountKey,
      ownerId: f.ownerId,
      fileKey: checkout.fileKey,
      revision: checkout.revision,
      allowResolvedDeclineReplacement: true,
      document: {
        account_key: f.accountKey,
        target_plan: 'plus',
        status: 'checkout_attempted',
        stage: 'checkout_create',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        retry_of: rechargeDocumentDigest(checkout.document)
      }
    };
    const transactions = new V2CommandTransactionManager(prisma);
    await expect(
      transactions.execute(
        async (tx) => {
          await repository.lock(tx);
          await repository.saveRecord(tx, input);
          throw new Error('synthetic-post-archive-audit-failure');
        },
        { changedScopes: ['auto-recharge'], requestId: randomUUID(), retryMode: 'none' }
      )
    ).rejects.toThrow('synthetic-post-archive-audit-failure');
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(before);
    await transactions.execute(
      async (tx) => {
        await repository.lock(tx);
        const first = await repository.saveRecord(tx, input);
        const replay = await repository.saveRecord(tx, input);
        expect(replay).toMatchObject({ revision: first.revision, replayed: true });
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), retryMode: 'none' }
    );
    const after = await repository.records(prisma as never, f.accountKey);
    expect(after.filter((record) => record.fileKey === archiveKey)).toHaveLength(1);
    expect(after.find((record) => record.fileKey === archiveKey)?.document).toEqual(
      checkout.document
    );
    expect(after.find((record) => record.fileKey.startsWith('payments/'))).toEqual(
      before.find((record) => record.fileKey.startsWith('payments/'))
    );
  });
  it('网页直连人工处理审计失败时账本、原任务与处理任务全部回滚', async () => {
    const f = await fixture('unknown', {
      transport: 'web_direct',
      reason: 'official_payment_method_verification_failed'
    });
    const before = await repository.records(prisma as never, f.accountKey);
    class FailingAudit extends V2TransactionalAuditService {
      override append(): never {
        throw new Error('synthetic-verification-audit-failure');
      }
    }
    await expect(
      service(new FailingAudit()).resolveDeclined(f.source.id, f.input, f.operator)
    ).rejects.toThrow('synthetic-verification-audit-failure');
    expect(await repository.records(prisma as never, f.accountKey)).toEqual(before);
    expect(await repository.byId(f.source.id)).toEqual(f.source);
    expect(await prisma.idBusinessV2RechargeJob.count({ where: { ownerId: f.ownerId } })).toBe(2);
  });
});
