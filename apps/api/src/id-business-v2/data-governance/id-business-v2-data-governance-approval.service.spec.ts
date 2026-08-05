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

  it('lets the requester cancel a pending approval task and writes the reason to audit', async () => {
    const requester = { ...APPROVER, id: REQUESTER_ID };
    const { service, tx, queryService } = createService();
    queryService.job.mockResolvedValue({ id: JOB_ID, status: 'cancelled' });

    const result = await service.cancel(JOB_ID, { reason: '影响范围需要重新确认' }, requester);

    expect(tx.idBusinessV2GovernanceJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: JOB_ID,
        requestedByUserId: REQUESTER_ID,
        status: 'pending_approval',
        approval: null
      },
      data: { status: 'cancelled', completedAt: expect.any(Date) }
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.data_governance.job_cancelled',
        afterData: expect.objectContaining({
          status: 'cancelled',
          reason: '影响范围需要重新确认'
        })
      })
    });
    expect(result).toMatchObject({ status: 'cancelled' });
  });

  it('rejects cancellation by an administrator who did not request the task', async () => {
    const { service, tx } = createService();

    await expect(service.cancel(JOB_ID, { reason: '非申请人尝试取消' }, APPROVER)).rejects.toThrow(
      '只有申请人可以取消'
    );

    expect(tx.idBusinessV2GovernanceJob.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects cancellation after the task has left pending approval', async () => {
    const requester = { ...APPROVER, id: REQUESTER_ID };
    const { service, tx } = createService();
    tx.idBusinessV2GovernanceJob.findUnique.mockResolvedValue({
      id: JOB_ID,
      jobNo: 'GOV-20260731-00000001',
      status: 'approved',
      previewHash: 'a'.repeat(64),
      requestedByUserId: REQUESTER_ID,
      approval: { id: 'approval-id' }
    });

    await expect(
      service.cancel(JOB_ID, { reason: '审批后尝试取消任务' }, requester)
    ).rejects.toThrow('只有待审批的数据治理任务可以取消');

    expect(tx.idBusinessV2GovernanceJob.updateMany).not.toHaveBeenCalled();
  });

  it('does not return a cancelled task when transactional audit fails', async () => {
    const requester = { ...APPROVER, id: REQUESTER_ID };
    const { service, tx, queryService } = createService();
    tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.cancel(JOB_ID, { reason: '影响范围需要重新确认' }, requester, {
        requestId: 'request-cancel-audit'
      })
    ).rejects.toThrow('audit unavailable');

    expect(tx.idBusinessV2GovernanceJob.updateMany).toHaveBeenCalledOnce();
    expect(queryService.job).not.toHaveBeenCalled();
  });
});
