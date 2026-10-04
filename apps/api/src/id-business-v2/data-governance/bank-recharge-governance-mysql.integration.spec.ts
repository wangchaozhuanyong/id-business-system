import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceApprovalService } from './id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceExecutionService } from './id-business-v2-data-governance-execution.service';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';

const url = process.env.V2_BANK_RECHARGE_TEST_DATABASE_URL;
const mysql = url ? describe : describe.skip;
mysql('银充治理恢复：真实隔离MySQL事务', () => {
  let prisma: PrismaService;
  let requester: AuthenticatedUser;
  let approver: AuthenticatedUser;
  let preview: IdBusinessV2DataGovernancePreviewService;
  let approval: IdBusinessV2DataGovernanceApprovalService;
  let execution: IdBusinessV2DataGovernanceExecutionService;
  let faultExecution: IdBusinessV2DataGovernanceExecutionService;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      !(
        /^\/id_business_v2_financial_integrity_\d+$/.test(parsed.pathname) ||
        parsed.pathname.includes('bank_recharge_')
      )
    )
      throw new Error('只允许本机隔离库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    const repository = new IdBusinessV2DataGovernanceRepository(prisma);
    const queries = new IdBusinessV2DataGovernanceQueryService(
      new IdBusinessV2DataGovernanceQueryRepository(prisma)
    );
    const transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    preview = new IdBusinessV2DataGovernancePreviewService(
      repository,
      new IdBusinessV2DataGovernanceQueryRepository(prisma),
      transactions,
      audit,
      queries
    );
    approval = new IdBusinessV2DataGovernanceApprovalService(
      repository,
      transactions,
      audit,
      queries
    );
    execution = new IdBusinessV2DataGovernanceExecutionService(
      repository,
      transactions,
      audit,
      new IdBusinessV2DataGovernanceItemExecutorService(repository, transactions, audit),
      queries
    );
    const faultAudit = {
      append: async (
        tx: Parameters<typeof audit.append>[0],
        input: Parameters<typeof audit.append>[1]
      ) => {
        if (input.action === 'id_business_v2.data_governance.item_succeeded')
          throw new Error('synthetic final audit failure');
        return audit.append(tx, input);
      }
    };
    faultExecution = new IdBusinessV2DataGovernanceExecutionService(
      repository,
      transactions,
      audit,
      new IdBusinessV2DataGovernanceItemExecutorService(
        repository,
        transactions,
        faultAudit as never
      ),
      queries
    );
    const role = await prisma.role.upsert({
      where: { code: 'admin' },
      create: { code: 'admin', name: '隔离治理管理员' },
      update: {}
    });
    const operators: AuthenticatedUser[] = [];
    for (let index = 0; index < 2; index++) {
      const id = randomUUID();
      const username = `gov-bank-${id}`;
      await prisma.user.create({
        data: {
          id,
          username,
          displayName: '隔离治理管理员',
          passwordHash: 'synthetic-not-login-secret',
          userRoles: { create: { roleId: role.id } },
          v2AuthIdentity: {
            create: {
              authUserId: randomUUID(),
              usernameNormalized: username,
              authEmail: `${id}@example.invalid`,
              enabled: true
            }
          }
        }
      });
      operators.push({
        id,
        username,
        displayName: '隔离治理管理员',
        roles: ['admin'],
        permissions: []
      });
    }
    [requester, approver] = operators as [AuthenticatedUser, AuthenticatedUser];
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'CNY' },
      create: { code: 'CNY', name: '人民币', minorUnits: 2 },
      update: {}
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function account(deleted = true) {
    const id = randomUUID();
    return prisma.idBusinessV2ChatgptAccount.create({
      data: {
        id,
        emailEncrypted: 'synthetic-placeholder',
        emailHash: createHash('sha256').update(id).digest('hex'),
        emailMasked: 'sy***@example.invalid',
        status: deleted ? 'disabled' : 'active',
        deletedAt: deleted ? new Date() : null,
        createdByUserId: requester.id
      }
    });
  }
  async function order(accountId?: string, deleted = true) {
    return prisma.idBusinessV2BankRechargeOrder.create({
      data: {
        orderNo: `BC-GOV-${randomUUID().replace(/-/g, '')}`,
        source: 'manual',
        manualEvidenceRef: `synthetic-${randomUUID()}`,
        chargeAmount: '100',
        chargeCurrencyCode: 'CNY',
        plan: 'plus',
        status: deleted ? 'cancelled' : 'pending_details',
        financeStatus: 'unposted',
        accountId,
        deletedAt: deleted ? new Date() : null,
        openedAt: new Date(deleted ? '2026-10-01T00:00:00Z' : '2026-10-03T00:00:00Z'),
        dueAt: new Date(deleted ? '2026-10-31T00:00:00Z' : '2026-11-01T00:00:00Z'),
        createdByUserId: requester.id
      }
    });
  }
  async function approve(items: Array<{ entity: string; id: string }>) {
    const job = await preview.createRestoreJob(
      {
        items,
        reason: '已核对隔离库误删除记录并恢复',
        backupEvidence: '隔离备份证据 SYNTHETIC-MYSQL-01',
        idempotencyKey: `bank-governance:${randomUUID()}`
      },
      requester
    );
    expect(job.status).toBe('pending_approval');
    await expect(
      approval.decide(
        job.id,
        { decision: 'approved', reason: '发起人不能审批自己的恢复' },
        requester
      )
    ).rejects.toThrow();
    await approval.decide(
      job.id,
      { decision: 'approved', reason: '独立管理员已核对冻结预览和备份' },
      approver
    );
    return job;
  }
  it('独立审批后恢复两类资料；重复执行不改新订阅或金额', async () => {
    const deletedAccount = await account();
    const subscribedAccount = await account(false);
    const historical = await order(subscribedAccount.id);
    const current = await order(subscribedAccount.id, false);
    const subscription = await prisma.idBusinessV2BankRechargeSubscription.create({
      data: {
        accountId: subscribedAccount.id,
        currentOrderId: current.id,
        plan: 'plus',
        status: 'active',
        openedAt: new Date('2026-10-03T00:00:00Z'),
        dueAt: new Date('2026-11-01T00:00:00Z')
      }
    });
    const job = await approve([
      { entity: 'chatgpt_account', id: deletedAccount.id },
      { entity: 'bank_recharge_order', id: historical.id }
    ]);
    const key = `bank-governance-execute:${randomUUID()}`;
    await execution.execute(job.id, { batchSize: 10, idempotencyKey: key }, approver);
    await execution.execute(job.id, { batchSize: 10, idempotencyKey: key }, approver);
    const restoredAccount = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: deletedAccount.id }
    });
    const restoredOrder = await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { id: historical.id }
    });
    expect(restoredAccount.deletedAt).toBeNull();
    expect(restoredAccount.status).toBe('disabled');
    expect(restoredOrder).toMatchObject({
      status: 'pending_details',
      financeStatus: 'unposted',
      deletedAt: null,
      openedAt: null,
      dueAt: null
    });
    expect(restoredOrder.chargeAmount.toString()).toBe('100');
    expect(
      await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
        where: { id: subscription.id }
      })
    ).toEqual(subscription);
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { sourceType: 'bank_recharge', sourceId: historical.id }
      })
    ).toBe(0);
    const items = await prisma.idBusinessV2GovernanceJobItem.findMany({ where: { jobId: job.id } });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === 'succeeded' && item.resultAuditLogId)).toBe(true);
  });
  it('审批后资料版本变化，执行只记录跳过且仍在回收站', async () => {
    const item = await account();
    const job = await approve([{ entity: 'chatgpt_account', id: item.id }]);
    await prisma.idBusinessV2ChatgptAccount.update({
      where: { id: item.id },
      data: { remark: '合成后续修改', updatedAt: new Date(item.updatedAt.getTime() + 1000) }
    });
    await execution.execute(
      job.id,
      { idempotencyKey: `bank-governance-stale:${randomUUID()}` },
      approver
    );
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: item.id } }))
        .deletedAt
    ).not.toBeNull();
    expect(
      (await prisma.idBusinessV2GovernanceJobItem.findFirstOrThrow({ where: { jobId: job.id } }))
        .resultCode
    ).toBe('source_changed');
  });
  it('最后成功审计失败，真实恢复写入回滚，并保存失败检查点', async () => {
    const item = await order();
    const job = await approve([{ entity: 'bank_recharge_order', id: item.id }]);
    await faultExecution.execute(
      job.id,
      { idempotencyKey: `bank-governance-fault:${randomUUID()}` },
      approver
    );
    const after = await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { id: item.id }
    });
    expect(after).toEqual(item);
    const result = await prisma.idBusinessV2GovernanceJobItem.findFirstOrThrow({
      where: { jobId: job.id }
    });
    expect(result.status).toBe('failed');
    expect(result.resultAuditLogId).not.toBeNull();
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { sourceType: 'bank_recharge', sourceId: item.id }
      })
    ).toBe(0);
  });
});
