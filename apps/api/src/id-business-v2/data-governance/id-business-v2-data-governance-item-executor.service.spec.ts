import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';

const DELETED_AT = new Date('2026-07-31T10:00:00.000Z');
const ITEM = {
  id: '50000000-0000-4000-8000-000000000001',
  jobId: '50000000-0000-4000-8000-000000000002',
  sequence: 1,
  entityType: 'account' as const,
  entityId: '50000000-0000-4000-8000-000000000003',
  safeLabel: 'ab***@example.com',
  sourceDeletedAt: DELETED_AT,
  eligibility: { eligible: true, code: 'eligible', detail: '可以恢复' },
  status: 'processing' as const,
  resultCode: null,
  resultMessage: null,
  resultAuditLogId: null,
  processedAt: null,
  createdAt: new Date('2026-07-31T10:01:00.000Z'),
  updatedAt: new Date('2026-07-31T10:01:00.000Z')
};
const JOB = { id: ITEM.jobId, jobNo: 'GOV-20260731-00000001', type: 'recycle_restore' as const };
const OPERATOR = {
  id: '50000000-0000-4000-8000-000000000004',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};

describe('IdBusinessV2DataGovernanceItemExecutorService', () => {
  it('restores an account as disabled and records the item audit id in one transaction', async () => {
    const tx = {
      idBusinessV2Account: {
        findUnique: vi.fn().mockResolvedValue({
          deletedAt: DELETED_AT,
          lossReportedAt: null,
          soldByOrderId: null
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      idBusinessV2GovernanceJobItem: { update: vi.fn(), updateMany: vi.fn() },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: '50000000-0000-4000-8000-000000000005' })
      }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2DataGovernanceItemExecutorService(
      new IdBusinessV2DataGovernanceRepository(prisma as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService()
    );

    await expect(service.process(ITEM, JOB, OPERATOR)).resolves.toBe('succeeded');

    expect(tx.idBusinessV2Account.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: null,
          recordStatus: 'disabled',
          updatedByUserId: OPERATOR.id
        })
      })
    );
    expect(tx.idBusinessV2GovernanceJobItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'succeeded',
          resultCode: 'account_restored_disabled',
          resultAuditLogId: '50000000-0000-4000-8000-000000000005'
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterData: expect.objectContaining({ recordStatus: 'disabled' })
        })
      })
    );
  });

  it('rolls the item command into a separately audited failure state when result audit fails', async () => {
    const tx = {
      idBusinessV2Account: {
        findUnique: vi.fn().mockResolvedValue({
          deletedAt: DELETED_AT,
          lossReportedAt: null,
          soldByOrderId: null
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      idBusinessV2GovernanceJobItem: {
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      auditLog: {
        create: vi
          .fn()
          .mockRejectedValueOnce(new Error('audit unavailable'))
          .mockResolvedValueOnce({ id: '50000000-0000-4000-8000-000000000006' })
      }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2DataGovernanceItemExecutorService(
      new IdBusinessV2DataGovernanceRepository(prisma as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService()
    );

    await expect(
      service.process(ITEM, JOB, OPERATOR, { requestId: 'request-item-audit' })
    ).resolves.toBe('failed');

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2GovernanceJobItem.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GovernanceJobItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'failed',
          resultAuditLogId: '50000000-0000-4000-8000-000000000006'
        })
      })
    );
  });

  it('restores only supplier wallets disabled by the matching option deletion', async () => {
    const optionItem = {
      ...ITEM,
      entityType: 'option' as const,
      eligibility: {
        eligible: true,
        code: 'eligible',
        detail: '可以恢复',
        originalUniqueKey: 'topup_supplier:root:供应商a',
        originalStatus: 'active' as const,
        dependentServices: []
      }
    };
    const tx = {
      idBusinessV2Option: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            deletedAt: DELETED_AT,
            uniqueKey: `deleted:${optionItem.entityId}:topup_supplier:root:供应商a`,
            type: 'topup_supplier',
            status: 'active',
            statusBeforeDeletion: 'active'
          })
          .mockResolvedValueOnce(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      idBusinessV2TopupSupplierAccount: {
        updateMany: vi.fn().mockResolvedValue({ count: 2 })
      },
      idBusinessV2GovernanceJobItem: { update: vi.fn(), updateMany: vi.fn() },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: '50000000-0000-4000-8000-000000000007' })
      }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2DataGovernanceItemExecutorService(
      new IdBusinessV2DataGovernanceRepository(prisma as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService()
    );

    await expect(service.process(optionItem, JOB, OPERATOR)).resolves.toBe('succeeded');

    expect(tx.idBusinessV2TopupSupplierAccount.updateMany).toHaveBeenCalledWith({
      where: {
        supplierOptionId: optionItem.entityId,
        status: 'disabled',
        disabledByOptionDeletionAt: DELETED_AT
      },
      data: {
        status: 'active',
        disabledByOptionDeletionAt: null,
        updatedByUserId: OPERATOR.id
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterData: expect.objectContaining({ restoredSupplierWalletCount: 2 })
        })
      })
    );
  });

  it('restores a parent option and all dependent services with their prior statuses', async () => {
    const dependentId = '50000000-0000-4000-8000-000000000008';
    const optionItem = {
      ...ITEM,
      entityType: 'option' as const,
      eligibility: {
        eligible: true,
        code: 'eligible',
        detail: '可以恢复',
        originalUniqueKey: 'business_category:root:ai',
        originalStatus: 'active' as const,
        dependentServices: [
          {
            id: dependentId,
            currentUniqueKey: `deleted:${dependentId}:service:country:category:chatgpt`,
            originalUniqueKey: 'service:country:category:chatgpt',
            originalStatus: 'disabled' as const
          }
        ]
      }
    };
    const tx = {
      idBusinessV2Option: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            deletedAt: DELETED_AT,
            uniqueKey: `deleted:${optionItem.entityId}:business_category:root:ai`,
            type: 'business_category',
            status: 'active',
            statusBeforeDeletion: 'active'
          })
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            deletedAt: DELETED_AT,
            uniqueKey: `deleted:${dependentId}:service:country:category:chatgpt`,
            type: 'service',
            status: 'disabled',
            statusBeforeDeletion: 'disabled',
            deletedByParentOptionId: optionItem.entityId
          })
          .mockResolvedValueOnce(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      },
      idBusinessV2GovernanceJobItem: { update: vi.fn(), updateMany: vi.fn() },
      auditLog: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: 'child-audit' })
          .mockResolvedValueOnce({ id: 'item-audit' })
      }
    };
    const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new IdBusinessV2DataGovernanceItemExecutorService(
      new IdBusinessV2DataGovernanceRepository(prisma as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService()
    );

    await expect(service.process(optionItem, JOB, OPERATOR)).resolves.toBe('succeeded');

    expect(tx.idBusinessV2Option.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: dependentId,
          statusBeforeDeletion: 'disabled'
        }),
        data: expect.objectContaining({
          uniqueKey: 'service:country:category:chatgpt',
          status: 'disabled',
          statusBeforeDeletion: null,
          deletedAt: null
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'id_business_v2.option.restore',
          objectId: dependentId
        })
      })
    );
  });
});
