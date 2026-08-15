import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

const OPERATOR = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'admin-a',
  displayName: '管理员 A',
  roles: ['admin'],
  permissions: []
};

function createService() {
  const countActiveAdmins = vi
    .fn()
    .mockImplementation(async (input: { where: { id?: { not?: string } } }) =>
      input.where.id?.not ? 1 : 2
    );
  const countActiveAdminsInTransaction = vi
    .fn()
    .mockImplementation(async (input: { where: { id?: { not?: string } } }) =>
      input.where.id?.not ? 1 : 2
    );
  const tx = {
    idBusinessV2GovernanceJob: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null)
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-id' }) },
    user: { count: countActiveAdminsInTransaction }
  };
  const prisma = {
    idBusinessV2GovernanceJob: { findUnique: vi.fn().mockResolvedValue(null) },
    idBusinessV2Account: { findMany: vi.fn() },
    idBusinessV2Customer: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2Option: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2Order: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2ExchangeRateRun: { findMany: vi.fn(), count: vi.fn() },
    idBusinessV2ExchangeRateSettings: {
      findUnique: vi.fn().mockResolvedValue({ retentionDays: 30 })
    },
    user: { count: countActiveAdmins },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (callback) => callback(tx))
  };
  const queryService = { job: vi.fn(async (id: string) => ({ id })) };
  const repository = new IdBusinessV2DataGovernanceRepository(prisma as never);
  return {
    service: new IdBusinessV2DataGovernancePreviewService(
      repository,
      new IdBusinessV2DataGovernanceQueryRepository(prisma as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService(),
      queryService as never
    ),
    prisma,
    tx,
    queryService
  };
}

describe('IdBusinessV2DataGovernancePreviewService', () => {
  it('creates an immutable safe restore preview without reading sensitive account fields', async () => {
    const { service, prisma, tx } = createService();
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T10:00:00.000Z'),
        lossReportedAt: null,
        soldByOrderId: null
      }
    ]);

    await service.createRestoreJob(
      {
        items: [
          {
            entity: 'account',
            id: '20000000-0000-4000-8000-000000000001'
          }
        ],
        reason: '恢复误删除的测试 ID',
        backupEvidence: '本地备份编号 backup-20260731',
        idempotencyKey: 'restore:preview:001'
      },
      OPERATOR
    );

    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          appleIdMasked: true,
          deletedAt: true,
          lossReportedAt: true,
          soldByOrderId: true
        }
      })
    );
    const createInput = tx.idBusinessV2GovernanceJob.create.mock.calls[0]?.[0];
    expect(createInput.data).toMatchObject({
      type: 'recycle_restore',
      requestedByUserId: OPERATOR.id,
      totalItems: 1
    });
    expect(createInput.data.previewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createInput.data.items.create[0]).toMatchObject({
      entityType: 'account',
      safeLabel: 'ab***@example.com',
      eligibility: { eligible: true, code: 'eligible' }
    });
    expect(JSON.stringify(createInput)).not.toContain('appleIdEncrypted');
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterData: expect.objectContaining({ backupEvidenceProvided: true })
      })
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ v2AuthIdentity: { is: { enabled: true } } })
    });
    expect(tx.user.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ v2AuthIdentity: { is: { enabled: true } } })
    });
  });

  it('rejects cleanup windows shorter than the configured retention policy', async () => {
    const { service, prisma, tx } = createService();
    prisma.idBusinessV2ExchangeRateSettings.findUnique.mockResolvedValue({ retentionDays: 90 });

    await expect(
      service.createCleanupJob(
        {
          olderThanDays: 30,
          reason: '清理超期汇率采集历史',
          backupEvidence: '备份编号 backup-20260814 已核对',
          idempotencyKey: 'cleanup:retention:blocked'
        },
        OPERATOR
      )
    ).rejects.toThrow('不得小于汇率设置中的 90 天');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GovernanceJob.create).not.toHaveBeenCalled();
  });

  it('freezes the configured retention policy in an eligible cleanup preview', async () => {
    const { service, prisma, tx } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: '40000000-0000-4000-8000-000000000001',
          status: 'success',
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          snapshotId: '40000000-0000-4000-8000-000000000002'
        }
      ])
      .mockResolvedValueOnce([{ total: 1 }]);

    await service.createCleanupJob(
      {
        olderThanDays: 30,
        reason: '清理超期汇率采集历史',
        backupEvidence: '备份编号 backup-20260814 已核对',
        idempotencyKey: 'cleanup:retention:eligible'
      },
      OPERATOR
    );

    const createInput = tx.idBusinessV2GovernanceJob.create.mock.calls[0]?.[0];
    expect(createInput.data.previewSummary).toMatchObject({
      olderThanDays: 30,
      configuredRetentionDays: 30,
      eligibleTotal: 1
    });
    expect(createInput.data.items.create[0].eligibility).toMatchObject({
      retentionDays: 30,
      snapshotId: '40000000-0000-4000-8000-000000000002'
    });
  });

  it('rejects duplicate restore selections before writing a job', async () => {
    const { service, tx } = createService();
    const item = { entity: 'customer', id: '30000000-0000-4000-8000-000000000001' };

    await expect(
      service.createRestoreJob(
        {
          items: [item, item],
          reason: '恢复误删除的客户资料',
          backupEvidence: '本地备份编号 backup-20260731',
          idempotencyKey: 'restore:preview:002'
        },
        OPERATOR
      )
    ).rejects.toThrow('不能重复选择');
    expect(tx.idBusinessV2GovernanceJob.create).not.toHaveBeenCalled();
  });

  it('rejects a new preview before reading business data when no independent approver exists', async () => {
    const { service, prisma, tx } = createService();
    prisma.user.count.mockImplementation(async (input: { where: { id?: { not?: string } } }) =>
      input.where.id?.not ? 0 : 1
    );

    await expect(
      service.createRestoreJob(
        {
          items: [{ entity: 'account', id: '20000000-0000-4000-8000-000000000001' }],
          reason: '恢复误删除的测试 ID',
          backupEvidence: '本地备份编号 backup-20260731',
          idempotencyKey: 'restore:preview:blocked'
        },
        OPERATOR
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.idBusinessV2Account.findMany).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GovernanceJob.create).not.toHaveBeenCalled();
  });

  it('re-checks approval readiness inside the creation transaction', async () => {
    const { service, prisma, tx } = createService();
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T10:00:00.000Z'),
        lossReportedAt: null,
        soldByOrderId: null
      }
    ]);
    tx.user.count.mockImplementation(async (input: { where: { id?: { not?: string } } }) =>
      input.where.id?.not ? 0 : 1
    );

    await expect(
      service.createRestoreJob(
        {
          items: [{ entity: 'account', id: '20000000-0000-4000-8000-000000000001' }],
          reason: '恢复误删除的测试 ID',
          backupEvidence: '本地备份编号 backup-20260731',
          idempotencyKey: 'restore:preview:transaction-blocked'
        },
        OPERATOR
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2GovernanceJob.create).not.toHaveBeenCalled();
  });

  it('re-reads and fully validates a matching idempotent preview after P2002', async () => {
    const { service, prisma, tx, queryService } = createService();
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T10:00:00.000Z'),
        lossReportedAt: null,
        soldByOrderId: null
      }
    ]);
    let fingerprint = '';
    tx.idBusinessV2GovernanceJob.create.mockImplementation(async (input) => {
      fingerprint = input.data.previewSummary.requestFingerprint;
      throw { code: 'P2002' };
    });
    tx.idBusinessV2GovernanceJob.findUnique.mockImplementation(async () => ({
      id: '20000000-0000-4000-8000-000000000099',
      type: 'recycle_restore',
      requestedByUserId: OPERATOR.id,
      previewSummary: { requestFingerprint: fingerprint }
    }));

    const result = await service.createRestoreJob(
      {
        items: [{ entity: 'account', id: '20000000-0000-4000-8000-000000000001' }],
        reason: '恢复误删除的测试 ID',
        backupEvidence: '本地备份编号 backup-20260731',
        idempotencyKey: 'restore:preview:003'
      },
      OPERATOR,
      { requestId: 'request-preview-replay' }
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2GovernanceJob.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'restore:preview:003' },
      select: { id: true, type: true, requestedByUserId: true, previewSummary: true }
    });
    expect(queryService.job).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000099');
    expect(result).toEqual({ id: '20000000-0000-4000-8000-000000000099' });
  });

  it('returns 409 when a P2002 replay key has different request evidence', async () => {
    const { service, prisma, tx, queryService } = createService();
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T10:00:00.000Z'),
        lossReportedAt: null,
        soldByOrderId: null
      }
    ]);
    tx.idBusinessV2GovernanceJob.create.mockRejectedValue({ code: 'P2002' });
    tx.idBusinessV2GovernanceJob.findUnique.mockResolvedValue({
      id: '20000000-0000-4000-8000-000000000099',
      type: 'recycle_restore',
      requestedByUserId: OPERATOR.id,
      previewSummary: { requestFingerprint: 'different-request-fingerprint' }
    });

    await expect(
      service.createRestoreJob(
        {
          items: [{ entity: 'account', id: '20000000-0000-4000-8000-000000000001' }],
          reason: '恢复误删除的测试 ID',
          backupEvidence: '本地备份编号 backup-20260731',
          idempotencyKey: 'restore:preview:004'
        },
        OPERATOR
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(queryService.job).not.toHaveBeenCalled();
  });

  it('does not return a created preview when its transactional audit fails', async () => {
    const { service, prisma, tx, queryService } = createService();
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: '20000000-0000-4000-8000-000000000001',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T10:00:00.000Z'),
        lossReportedAt: null,
        soldByOrderId: null
      }
    ]);
    tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.createRestoreJob(
        {
          items: [{ entity: 'account', id: '20000000-0000-4000-8000-000000000001' }],
          reason: '恢复误删除的测试 ID',
          backupEvidence: '本地备份编号 backup-20260731',
          idempotencyKey: 'restore:preview:005'
        },
        OPERATOR
      )
    ).rejects.toThrow('audit unavailable');
    expect(tx.idBusinessV2GovernanceJob.create).toHaveBeenCalledOnce();
    expect(queryService.job).not.toHaveBeenCalled();
  });
});
