import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceApprovalService } from './id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';

const JOB_ID = '40000000-0000-4000-8000-000000000001';
const REQUESTER_ID = '40000000-0000-4000-8000-000000000002';
const APPROVER = {
  id: '40000000-0000-4000-8000-000000000003',
  username: 'admin-b',
  displayName: '管理员 B',
  roles: ['admin'],
  permissions: []
};

function createService(requestedByUserId = REQUESTER_ID) {
  const tx = {
    idBusinessV2GovernanceJob: {
      findUnique: vi.fn().mockResolvedValue({
        id: JOB_ID,
        jobNo: 'GOV-20260731-00000001',
        status: 'pending_approval',
        previewHash: 'a'.repeat(64),
        requestedByUserId,
        approval: null
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    idBusinessV2GovernanceApproval: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-id' }) }
  };
  const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
  const queryService = { job: vi.fn().mockResolvedValue({ id: JOB_ID, status: 'approved' }) };
  const repository = new IdBusinessV2DataGovernanceRepository(prisma as never);
  return {
    service: new IdBusinessV2DataGovernanceApprovalService(
      repository,
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService(),
      queryService as never
    ),
    tx,
    queryService
  };
}

describe('IdBusinessV2DataGovernanceApprovalService', () => {
  it('binds a different administrator approval to the preview hash', async () => {
    const { service, tx } = createService();

    await service.decide(
      JOB_ID,
      { decision: 'approved', reason: '已复核备份和影响范围' },
      APPROVER
    );

    expect(tx.idBusinessV2GovernanceApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: JOB_ID,
        approverUserId: APPROVER.id,
        decision: 'approved',
        previewHash: 'a'.repeat(64)
      })
    });
    expect(tx.idBusinessV2GovernanceJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'approved' }) })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.data_governance.approval_decided'
      })
    });
  });

  it('rejects self approval before creating an approval record', async () => {
    const { service, tx } = createService(APPROVER.id);

    await expect(
      service.decide(JOB_ID, { decision: 'approved', reason: '申请人尝试自批' }, APPROVER)
    ).rejects.toThrow('申请人不能审批自己的');
    expect(tx.idBusinessV2GovernanceApproval.create).not.toHaveBeenCalled();
  });

  it('does not expose an approved result when the in-transaction audit fails', async () => {
    const { service, tx, queryService } = createService();
    tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.decide(JOB_ID, { decision: 'approved', reason: '已复核备份和影响范围' }, APPROVER, {
        requestId: 'request-approval-audit'
      })
    ).rejects.toThrow('audit unavailable');

    expect(tx.idBusinessV2GovernanceApproval.create).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2GovernanceJob.updateMany).toHaveBeenCalledOnce();
    expect(queryService.job).not.toHaveBeenCalled();
  });
});
