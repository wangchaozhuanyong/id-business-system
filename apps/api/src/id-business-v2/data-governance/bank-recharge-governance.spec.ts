import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

const id = '22222222-2222-4222-8222-222222222222';
const deletedAt = new Date('2026-10-04T01:00:00Z');
const updatedAt = new Date('2026-10-04T01:01:00Z');
const operator = { id: '11111111-1111-4111-8111-111111111111', roles: ['admin'], permissions: [] };
function setup(entity: 'chatgpt_account' | 'bank_recharge_order') {
  const account = {
    id,
    emailMasked: 'fi***@example.invalid',
    status: 'disabled',
    deletedAt,
    updatedAt,
    officialAccountKey: null,
    subscription: null,
    _count: { jobs: 0, orders: 0, registrationJobs: 0 }
  };
  const bankOrder = {
    id,
    orderNo: 'BC-SYNTHETIC',
    source: 'manual',
    status: 'cancelled',
    financeStatus: 'unposted',
    deletedAt,
    updatedAt,
    verifiedAt: null,
    rechargeJobId: null,
    checkoutIdentifier: null,
    paymentEvidenceId: null,
    receivedAmount: null,
    activeSubscription: { status: 'cancelled' },
    renewedBy: null
  };
  const tx = {
    idBusinessV2ChatgptAccount: {
      findUnique: vi.fn().mockResolvedValue(account),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    idBusinessV2BankRechargeOrder: {
      findUnique: vi.fn().mockResolvedValue(bankOrder),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    idBusinessV2FinanceJournal: { count: vi.fn().mockResolvedValue(0) },
    idBusinessV2GovernanceJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'job' })
    },
    idBusinessV2GovernanceJobItem: { update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    user: { count: vi.fn().mockResolvedValue(1) }
  };
  const prisma = {
    idBusinessV2GovernanceJob: { findUnique: vi.fn().mockResolvedValue(null) },
    idBusinessV2Account: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2Customer: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2Option: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2Order: { findMany: vi.fn().mockResolvedValue([]) },
    idBusinessV2ChatgptAccount: { findMany: vi.fn().mockResolvedValue([account]) },
    idBusinessV2BankRechargeOrder: { findMany: vi.fn().mockResolvedValue([bankOrder]) },
    idBusinessV2FinanceJournal: { findMany: vi.fn().mockResolvedValue([]) },
    user: { count: vi.fn().mockResolvedValue(1) },
    $transaction: vi.fn(async (work) => work(tx))
  };
  const repository = new IdBusinessV2DataGovernanceRepository(prisma as never);
  const transactions = new V2CommandTransactionManager(prisma as never);
  const audit = new V2TransactionalAuditService();
  const preview = new IdBusinessV2DataGovernancePreviewService(
    repository,
    new IdBusinessV2DataGovernanceQueryRepository(prisma as never),
    transactions,
    audit,
    { job: vi.fn().mockResolvedValue({ id: 'job' }) } as never
  );
  const executor = new IdBusinessV2DataGovernanceItemExecutorService(
    repository,
    transactions,
    audit
  );
  const item = {
    id: 'item',
    jobId: 'job',
    sequence: 1,
    entityType: entity,
    entityId: id,
    safeLabel: 'safe',
    sourceDeletedAt: deletedAt,
    eligibility: {
      eligible: true,
      code: 'eligible',
      detail: 'safe',
      sourceUpdatedAt: updatedAt.toISOString()
    }
  };
  const job = { id: 'job', jobNo: 'GOV-SYNTHETIC', type: 'recycle_restore' as const };
  const request = {
    items: [{ entity, id }],
    reason: '恢复已核验的误删除资料',
    backupEvidence: '隔离备份编号 SYNTHETIC-01',
    idempotencyKey: 'restore:synthetic:01'
  };
  return { account, bankOrder, prisma, tx, preview, executor, item, job, request };
}

describe('银充数据治理恢复', () => {
  it.each(['chatgpt_account', 'bank_recharge_order'] as const)(
    '%s 预览冻结版本、删除时刻和备份证据，不读取凭据',
    async (entity) => {
      const f = setup(entity);
      await f.preview.createRestoreJob(f.request, operator as never);
      const created = f.tx.idBusinessV2GovernanceJob.create.mock.calls[0]![0].data;
      expect(created.status).toBeUndefined();
      expect(created.backupEvidence).toBe(f.request.backupEvidence);
      expect(created.items.create[0]).toMatchObject({
        entityType: entity,
        sourceDeletedAt: deletedAt,
        eligibility: { eligible: true, sourceUpdatedAt: updatedAt.toISOString() }
      });
      const selects = [
        ...f.prisma.idBusinessV2ChatgptAccount.findMany.mock.calls,
        ...f.prisma.idBusinessV2BankRechargeOrder.findMany.mock.calls
      ];
      expect(JSON.stringify(selects)).not.toMatch(
        /passwordEncrypted|totpSecretEncrypted|emailEncrypted/
      );
    }
  );
  it('恢复ChatGPT账号只恢复可见性并保持停用', async () => {
    const f = setup('chatgpt_account');
    expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('succeeded');
    expect(f.tx.idBusinessV2ChatgptAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt, updatedAt }),
        data: { deletedAt: null, status: 'disabled', updatedByUserId: operator.id }
      })
    );
    expect(f.tx.idBusinessV2BankRechargeOrder.updateMany).not.toHaveBeenCalled();
  });
  it('误录单恢复为待补全和空日期，不重启已取消订阅或财务', async () => {
    const f = setup('bank_recharge_order');
    expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('succeeded');
    expect(f.tx.idBusinessV2BankRechargeOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          deletedAt: null,
          status: 'pending_details',
          openedAt: null,
          dueAt: null,
          updatedByUserId: operator.id
        }
      })
    );
    expect(f.tx.auditLog.create.mock.calls[0]![0].data.afterData).toMatchObject({
      financialMutation: false,
      subscriptionActivated: false
    });
  });
  it.each(['chatgpt_account', 'bank_recharge_order'] as const)(
    '%s 审批后被修改版本即跳过',
    async (entity) => {
      const f = setup(entity);
      Object.assign(entity === 'chatgpt_account' ? f.account : f.bankOrder, {
        updatedAt: new Date(updatedAt.getTime() + 1000)
      });
      expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('skipped');
      expect(f.tx.idBusinessV2ChatgptAccount.updateMany).not.toHaveBeenCalled();
      expect(f.tx.idBusinessV2BankRechargeOrder.updateMany).not.toHaveBeenCalled();
    }
  );
  it.each([
    { officialAccountKey: 'new-binding' },
    { _count: { jobs: 1, orders: 0, registrationJobs: 0 } },
    { subscription: { id: 'new-subscription' } }
  ])('新账号绑定/引用 %j 阻止恢复', async (patch) => {
    const f = setup('chatgpt_account');
    Object.assign(f.account, patch);
    expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('skipped');
    expect(f.tx.idBusinessV2ChatgptAccount.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    { source: 'automatic' },
    { verifiedAt: updatedAt },
    { receivedAmount: new Prisma.Decimal('1') },
    { activeSubscription: { status: 'active' } },
    { renewedBy: { id: 'successor' } }
  ])('新付款/引用 %j 阻止银充恢复', async (patch) => {
    const f = setup('bank_recharge_order');
    Object.assign(f.bankOrder, patch);
    expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('skipped');
    expect(f.tx.idBusinessV2BankRechargeOrder.updateMany).not.toHaveBeenCalled();
  });
  it('即使已审批，新增财务凭证仍阻止恢复', async () => {
    const f = setup('bank_recharge_order');
    f.tx.idBusinessV2FinanceJournal.count.mockResolvedValue(1);
    expect(await f.executor.process(f.item as never, f.job, operator as never)).toBe('skipped');
    expect(f.tx.idBusinessV2BankRechargeOrder.updateMany).not.toHaveBeenCalled();
  });
});
