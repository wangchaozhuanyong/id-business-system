import { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceApprovalService } from './id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceExecutionService } from './id-business-v2-data-governance-execution.service';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';

const databaseUrl = process.env.V2_DATA_GOVERNANCE_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const REQUESTER: AuthenticatedUser = {
  id: 'd1000000-0000-4000-8000-000000000001',
  username: 'governance-requester',
  displayName: '治理申请管理员',
  roles: ['admin'],
  permissions: []
};
const APPROVER: AuthenticatedUser = {
  id: 'd1000000-0000-4000-8000-000000000002',
  username: 'governance-approver',
  displayName: '治理审批管理员',
  roles: ['admin'],
  permissions: []
};
const CUSTOMER_ID = 'd2000000-0000-4000-8000-000000000001';
const RESTORE_KEY = 'governance:integration:restore:001';
const EXECUTION_KEY = 'governance:integration:execute:001';

describeWithPostgres('data governance PostgreSQL two-administrator workflow', () => {
  let prisma: PrismaClient;
  let previewService: IdBusinessV2DataGovernancePreviewService;
  let approvalService: IdBusinessV2DataGovernanceApprovalService;
  let executionService: IdBusinessV2DataGovernanceExecutionService;

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl!);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const commandRepository = new IdBusinessV2DataGovernanceRepository(prisma as never);
    const queryRepository = new IdBusinessV2DataGovernanceQueryRepository(prisma as never);
    const transactionManager = new V2CommandTransactionManager(prisma as never);
    const transactionalAudit = new V2TransactionalAuditService();
    const queryService = new IdBusinessV2DataGovernanceQueryService(queryRepository);
    const itemExecutor = new IdBusinessV2DataGovernanceItemExecutorService(
      commandRepository,
      transactionManager,
      transactionalAudit
    );

    previewService = new IdBusinessV2DataGovernancePreviewService(
      commandRepository,
      queryRepository,
      transactionManager,
      transactionalAudit,
      queryService
    );
    approvalService = new IdBusinessV2DataGovernanceApprovalService(
      commandRepository,
      transactionManager,
      transactionalAudit,
      queryService
    );
    executionService = new IdBusinessV2DataGovernanceExecutionService(
      commandRepository,
      transactionManager,
      transactionalAudit,
      itemExecutor,
      queryService
    );

    await assertEmptyGovernanceDatabase();
    await prisma.user.createMany({
      data: [
        {
          id: REQUESTER.id,
          username: REQUESTER.username,
          displayName: REQUESTER.displayName,
          passwordHash: 'integration-only-not-a-login-secret'
        },
        {
          id: APPROVER.id,
          username: APPROVER.username,
          displayName: APPROVER.displayName,
          passwordHash: 'integration-only-not-a-login-secret'
        }
      ]
    });
    await prisma.idBusinessV2Customer.create({
      data: {
        id: CUSTOMER_ID,
        name: '隔离库待恢复客户',
        createdByUserId: REQUESTER.id,
        updatedByUserId: REQUESTER.id,
        deletedAt: new Date('2026-08-01T07:00:00.000Z')
      }
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$disconnect();
  });

  it('freezes the preview, rejects self approval, executes once and replays idempotently', async () => {
    const preview = await previewService.createRestoreJob(
      {
        items: [{ entity: 'customer', id: CUSTOMER_ID }],
        reason: '隔离库误删除客户恢复演练',
        backupEvidence: '本地恢复演练备份 SHA256 已核对',
        idempotencyKey: RESTORE_KEY
      },
      REQUESTER,
      { requestId: 'governance-integration-preview' }
    );

    expect(preview).toMatchObject({
      status: 'pending_approval',
      requestedByUserId: REQUESTER.id,
      totalItems: 1,
      items: [
        {
          entityType: 'customer',
          entityId: CUSTOMER_ID,
          safeLabel: '隔离库待恢复客户',
          status: 'pending'
        }
      ]
    });
    expect(preview.previewHash).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      approvalService.decide(
        preview.id,
        { decision: 'approved', reason: '申请人不能自行批准' },
        REQUESTER,
        { requestId: 'governance-integration-self-approval' }
      )
    ).rejects.toThrow('申请人不能审批自己的');
    expect(await prisma.idBusinessV2GovernanceApproval.count()).toBe(0);

    const approved = await approvalService.decide(
      preview.id,
      { decision: 'approved', reason: '已复核备份证据和恢复范围' },
      APPROVER,
      { requestId: 'governance-integration-approval' }
    );
    expect(approved).toMatchObject({
      status: 'approved',
      approval: {
        approverUserId: APPROVER.id,
        decision: 'approved',
        previewHash: preview.previewHash
      }
    });

    await expect(
      prisma.idBusinessV2GovernanceJob.update({
        where: { id: preview.id },
        data: { previewHash: 'f'.repeat(64) }
      })
    ).rejects.toThrow('governance job preview fields are immutable');

    const executed = await executionService.execute(
      preview.id,
      { batchSize: 1, idempotencyKey: EXECUTION_KEY },
      APPROVER,
      { requestId: 'governance-integration-execution' }
    );
    expect(executed).toMatchObject({
      idempotentReplay: false,
      checkpoint: { status: 'completed', attemptedItems: 1, succeededItems: 1 },
      job: { status: 'succeeded', succeededItems: 1, skippedItems: 0, failedItems: 0 }
    });

    const [customer, item, auditCount, checkpointCount] = await Promise.all([
      prisma.idBusinessV2Customer.findUniqueOrThrow({ where: { id: CUSTOMER_ID } }),
      prisma.idBusinessV2GovernanceJobItem.findFirstOrThrow({ where: { jobId: preview.id } }),
      prisma.auditLog.count({ where: { module: 'id_business_v2_data_governance' } }),
      prisma.idBusinessV2GovernanceCheckpoint.count({ where: { jobId: preview.id } })
    ]);
    expect(customer).toMatchObject({ deletedAt: null, updatedByUserId: APPROVER.id });
    expect(item).toMatchObject({ status: 'succeeded', resultCode: 'customer_restored' });
    expect(item.resultAuditLogId).toMatch(/^[0-9a-f-]{36}$/);
    expect(auditCount).toBe(4);
    expect(checkpointCount).toBe(1);

    const replay = await executionService.execute(
      preview.id,
      { batchSize: 1, idempotencyKey: EXECUTION_KEY },
      APPROVER,
      { requestId: 'governance-integration-replay' }
    );
    expect(replay).toMatchObject({
      idempotentReplay: true,
      checkpoint: { id: executed.checkpoint.id },
      job: { status: 'succeeded' }
    });
    expect(
      await prisma.idBusinessV2GovernanceCheckpoint.count({ where: { jobId: preview.id } })
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { module: 'id_business_v2_data_governance' } })
    ).toBe(auditCount);
  });

  async function assertEmptyGovernanceDatabase() {
    const [users, customers, jobs, approvals] = await Promise.all([
      prisma.user.count(),
      prisma.idBusinessV2Customer.count(),
      prisma.idBusinessV2GovernanceJob.count(),
      prisma.idBusinessV2GovernanceApproval.count()
    ]);
    expect({ users, customers, jobs, approvals }).toEqual({
      users: 0,
      customers: 0,
      jobs: 0,
      approvals: 0
    });
  }
});

function assertDisposableDatabase(value: string) {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1);
  expect(['127.0.0.1', 'localhost', '::1']).toContain(url.hostname);
  expect(databaseName).toMatch(/^id_business_v2_governance_drill_[a-z0-9_]+$/);
}
