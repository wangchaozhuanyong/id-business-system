import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceExecutionService } from './id-business-v2-data-governance-execution.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';

const JOB_ID = '60000000-0000-4000-8000-000000000001';
const CHECKPOINT_ID = '60000000-0000-4000-8000-000000000002';
const OPERATOR = {
  id: '60000000-0000-4000-8000-000000000003',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

describe('IdBusinessV2DataGovernanceExecutionService', () => {
  it('reconciles an approved job with no pending items into a terminal checkpoint', async () => {
    const checkpoint = {
      id: CHECKPOINT_ID,
      jobId: JOB_ID,
      batchNo: 1,
      idempotencyKey: 'batch:reconcile:001',
      status: 'completed'
    };
    const tx = {
      idBusinessV2GovernanceJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: JOB_ID,
          jobNo: 'GOV-20260731-00000001',
          type: 'recycle_restore',
          status: 'approved',
          previewHash: 'a'.repeat(64),
          startedAt: null,
          updatedAt: new Date(),
          approval: { decision: 'approved', previewHash: 'a'.repeat(64) }
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({})
      },
      idBusinessV2GovernanceCheckpoint: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(checkpoint)
      },
      idBusinessV2GovernanceJobItem: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0)
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-id' }) }
    };
    const prisma = {
      idBusinessV2GovernanceCheckpoint: {
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockResolvedValue(checkpoint)
      },
      $transaction: vi.fn(async (callback) => callback(tx))
    };
    const itemExecutor = { process: vi.fn() };
    const queryService = { job: vi.fn().mockResolvedValue({ id: JOB_ID, status: 'succeeded' }) };
    const repository = new IdBusinessV2DataGovernanceRepository(prisma as never);
    const service = new IdBusinessV2DataGovernanceExecutionService(
      repository,
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService(),
      itemExecutor as never,
      queryService as never
    );

    const result = await service.execute(
      JOB_ID,
      { batchSize: 50, idempotencyKey: 'batch:reconcile:001' },
      OPERATOR
    );

    expect(itemExecutor.process).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GovernanceCheckpoint.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: JOB_ID,
        status: 'completed'
      })
    });
    expect(tx.idBusinessV2GovernanceJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) })
    );
    expect(result).toMatchObject({
      idempotentReplay: false,
      checkpoint: { id: CHECKPOINT_ID },
      job: { status: 'succeeded' }
    });
  });
});
