import { describe, expect, it, vi } from 'vitest';
import { Prisma, type OnlineRechargeBill } from '@prisma/client';
import { onlineBillAmountMeaning, onlineBillingSummary } from './persistence/billing-summary';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';

const operator = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'billing-fixture',
  displayName: '合成账务用户',
  roles: ['admin'],
  permissions: []
};
const billId = '20000000-0000-4000-8000-000000000001';
const taskId = '30000000-0000-4000-8000-000000000001';
function bill(values: Partial<OnlineRechargeBill> = {}): OnlineRechargeBill {
  return {
    id: billId,
    taskId,
    cardId: null,
    cardLast4: '0001',
    plan: 'plus',
    status: 'success',
    amount: new Prisma.Decimal('20.1234'),
    estimatedAmount: null,
    currency: 'USD',
    checkoutId: 'synthetic-checkout',
    idempotencyKey: 'synthetic-billing',
    errorCode: null,
    message: '合成账务记录',
    createdAt: new Date('2026-10-19T00:00:00Z'),
    ...values
  };
}
function fixture(rows: OnlineRechargeBill[], eligibleTaskCount = 0) {
  const db = {
    onlineRechargeBill: {
      findUnique: vi.fn(async () => rows[0] ?? null),
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn(async () => ({ count: rows.length })),
      groupBy: vi.fn(async () => [
        {
          cardLast4: '0001',
          currency: 'USD',
          _sum: {
            amount: rows.some((r) => r.amount !== null)
              ? rows.reduce((sum, row) => sum.add(row.amount ?? 0), new Prisma.Decimal(0))
              : null
          },
          _count: { _all: rows.length, amount: rows.filter((r) => r.amount !== null).length }
        }
      ])
    },
    onlineRechargeTask: { count: vi.fn(async () => eligibleTaskCount) }
  };
  const repository = {
    read: async <T>(work: (client: typeof db) => Promise<T>) => work(db),
    transaction: async <T>(_key: string, work: (client: typeof db) => Promise<T>) => work(db),
    log: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ items: rows, total: rows.length }))
  };
  const service = new OnlineRechargeAdminRepository(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  );
  return { service, repository, db };
}

describe('独立代充账单金额口径', () => {
  it('完整金额保持四位精度，零元也是已知金额', () => {
    expect(
      onlineBillingSummary({
        _sum: { amount: new Prisma.Decimal('20.1234') },
        _count: { _all: 2, amount: 2 }
      })
    ).toMatchObject({
      amount: '20.1234',
      knownAmount: '20.1234',
      count: 2,
      knownAmountCount: 2,
      unknownAmountCount: 0,
      isComplete: true
    });
    expect(
      onlineBillingSummary({
        _sum: { amount: new Prisma.Decimal(0) },
        _count: { _all: 1, amount: 1 }
      })
    ).toMatchObject({ amount: '0', isComplete: true });
  });
  it('混合未知金额只返回已知小计，完整总额保持未知', async () => {
    const { service, db } = fixture([bill(), bill({ id: 'second', amount: null })]);
    expect(await service.action('billing', 'summary', {}, operator)).toEqual([
      {
        cardLast4: '0001',
        currency: 'USD',
        amount: null,
        knownAmount: '20.1234',
        count: 2,
        knownAmountCount: 1,
        unknownAmountCount: 1,
        isComplete: false
      }
    ]);
    expect(db.onlineRechargeBill.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['cardLast4', 'currency'],
        where: { status: 'success' },
        _count: { _all: true, amount: true }
      })
    );
  });
  it('全部未知不会被转换为零', () => {
    expect(
      onlineBillingSummary({ _sum: { amount: null }, _count: { _all: 3, amount: 0 } })
    ).toMatchObject({ amount: null, knownAmount: null, unknownAmountCount: 3, isComplete: false });
  });
  it('空结果和币种分组不合并为一个金额', async () => {
    const { service, db } = fixture([]);
    db.onlineRechargeBill.groupBy.mockResolvedValueOnce([]);
    expect(await service.action('billing', 'summary', {}, operator)).toEqual([]);
    expect(db.onlineRechargeBill.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['cardLast4', 'currency']
      })
    );
  });
  it('未知卡尾号只查询未关联卡片的分组，不扩大为全部卡片', async () => {
    const { service, db } = fixture([]);
    await service.action('billing', 'summary', { cardLast4: null }, operator);
    expect(db.onlineRechargeBill.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'success', cardLast4: null }
      })
    );
  });
  it('失败和待核对记录明确标为结账金额，详情和导出使用相同说明', async () => {
    for (const status of ['failed', 'result_unknown']) {
      const row = bill({ status });
      const { service } = fixture([row]);
      const meaning = onlineBillAmountMeaning(row);
      expect(meaning).toContain('未确认扣款');
      expect(await service.action('billing', 'detail', { id: billId }, operator)).toMatchObject({
        amountMeaning: meaning
      });
      const result = (await service.action('billing', 'export', {}, operator)) as {
        content: string;
      };
      expect(result.content).toContain('结账金额');
      expect(result.content).toContain(meaning);
      expect(result.content).not.toContain('实际金额');
    }
  });
});

describe('独立代充账单清理保护', () => {
  it.each(['success', 'result_unknown'])('禁止物理删除 %s 账单', async (status) => {
    const { service, db, repository } = fixture([bill({ status })], 1);
    await expect(service.action('billing', 'delete', { ids: [billId] }, operator)).rejects.toThrow(
      '必须保留'
    );
    expect(db.onlineRechargeBill.deleteMany).not.toHaveBeenCalled();
    expect(repository.log).not.toHaveBeenCalled();
  });
  it('混合选择成功与失败账单时整批拒绝，不部分删除', async () => {
    const { service, db } = fixture([bill(), bill({ id: 'second', status: 'failed' })], 1);
    await expect(
      service.action('billing', 'delete', { ids: [billId] }, operator)
    ).rejects.toThrow();
    expect(db.onlineRechargeBill.deleteMany).not.toHaveBeenCalled();
  });
  it('任务未明确失败、已付款或缺少原任务时均拒绝清理', async () => {
    const { service, db } = fixture([bill({ status: 'failed' })], 0);
    await expect(service.action('billing', 'clear-failed', {}, operator)).rejects.toThrow(
      '不能清理'
    );
    expect(db.onlineRechargeTask.count).toHaveBeenCalledWith({
      where: { id: { in: [taskId] }, status: 'failed', confirmedPaid: false }
    });
    expect(db.onlineRechargeBill.deleteMany).not.toHaveBeenCalled();
  });
  it('允许清理明确失败且未付款的账单，并逐条保留非敏感快照', async () => {
    const row = bill({ status: 'failed' });
    const { service, db, repository } = fixture([row], 1);
    expect(await service.action('billing', 'delete', { ids: [billId] }, operator)).toMatchObject({
      success: true,
      count: 1
    });
    expect(db.onlineRechargeBill.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [billId] }, status: 'failed' }
    });
    expect(repository.log).toHaveBeenCalledWith(
      expect.anything(),
      'billing.delete',
      operator,
      billId,
      {
        count: 1,
        deletedBill: {
          id: billId,
          taskId,
          cardLast4: '0001',
          status: 'failed',
          amount: '20.1234',
          estimatedAmount: null,
          currency: 'USD',
          checkoutId: 'synthetic-checkout',
          createdAt: '2026-10-19T00:00:00.000Z'
        }
      }
    );
  });
});
