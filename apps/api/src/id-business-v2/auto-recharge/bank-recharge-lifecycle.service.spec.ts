import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { BankRechargeLifecycleService } from './bank-recharge-lifecycle.service';
const id = '123e4567-e89b-42d3-a456-426614174000';
const date = new Date('2026-10-04T08:00:00.000Z');
function setup() {
  const account = {
    id,
    emailMasked: 'a***@example.test',
    status: 'active',
    officialAccountKey: null,
    deletedAt: null,
    updatedAt: date
  };
  const order = {
    id,
    orderNo: 'BANK-TEST',
    status: 'pending_details',
    source: 'manual',
    financeStatus: 'unposted',
    accountId: id,
    deletedAt: null,
    updatedAt: date,
    verifiedAt: null,
    receivedAmount: null
  };
  const repository = {
    read: vi.fn((work) => work({})),
    lock: vi.fn(),
    account: vi.fn(async () => account),
    order: vi.fn(async () => order),
    accountReferences: vi
      .fn()
      .mockResolvedValue({ jobs: 0, orders: 0, subscriptions: 0, registrations: 0 }),
    orderReferences: vi.fn().mockResolvedValue({
      journals: 0,
      successor: 0,
      currentOrderId: id,
      subscriptionUpdatedAt: date.toISOString()
    }),
    command: vi.fn().mockResolvedValue(null),
    updateAccount: vi.fn(async (_tx, _id, deletedAt) => ({
      ...account,
      status: 'disabled',
      deletedAt
    })),
    updateOrder: vi.fn(async (_tx, _id, deletedAt, restoring) => ({
      ...order,
      status: restoring ? 'pending_details' : 'cancelled',
      deletedAt
    })),
    cancelProjection: vi.fn()
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn((work) => work({})) };
  const service = new BankRechargeLifecycleService(
    repository as never,
    transactions as never,
    audit as never
  );
  const operator = { id, roles: ['admin'] } as never;
  const input = (preview: Awaited<ReturnType<typeof service.preview>>) => ({
    expectedUpdatedAt: preview.expectedUpdatedAt,
    previewFingerprint: preview.previewFingerprint,
    operationId: id,
    reason: '核实误录',
    confirmNoPaymentOrReceipt: true
  });
  return { service, repository, audit, account, order, operator, input };
}
describe('银充生命周期安全闭环', () => {
  it('账号软删保留凭据引用，恢复需独立审批', async () => {
    const f = setup();
    const preview = await f.service.preview('account', id, 'delete');
    const result = (await f.service.execute(
      'account',
      id,
      'delete',
      f.input(preview),
      f.operator
    )) as { status: string };
    expect(result.status).toBe('disabled');
    expect(f.repository.updateAccount).toHaveBeenCalledWith({}, id, expect.any(Date), id);
    expect(f.audit.append).toHaveBeenCalledOnce();
    Object.assign(f.account, { deletedAt: date, status: 'disabled' });
    await expect(f.service.preview('account', id, 'restore')).rejects.toThrow('另一管理员审批');
  });
  it('关联账号及官网绑定账号不能删除', async () => {
    const f = setup();
    f.repository.accountReferences.mockResolvedValue({
      jobs: 0,
      orders: 1,
      subscriptions: 0,
      registrations: 0
    });
    await expect(f.service.preview('account', id, 'delete')).rejects.toThrow('业务关联');
    f.repository.accountReferences.mockResolvedValue({
      jobs: 0,
      orders: 0,
      subscriptions: 0,
      registrations: 0
    });
    Object.assign(f.account, { officialAccountKey: 'official' });
    await expect(f.service.preview('account', id, 'delete')).rejects.toThrow('官网核验');
    expect(f.repository.updateAccount).not.toHaveBeenCalled();
  });
  it('作废只取消本单投影，不自动建立其他订阅；恢复只回待补全', async () => {
    const f = setup();
    const preview = await f.service.preview('order', id, 'cancel');
    await f.service.execute('order', id, 'cancel', f.input(preview), f.operator);
    expect(f.repository.cancelProjection).toHaveBeenCalledWith({}, id);
    Object.assign(f.order, { status: 'cancelled' });
    const restore = await f.service.preview('order', id, 'restore');
    f.repository.cancelProjection.mockClear();
    await f.service.execute('order', id, 'restore', f.input(restore), f.operator);
    expect(f.repository.updateOrder).toHaveBeenLastCalledWith({}, id, null, true, id);
    expect(f.repository.cancelProjection).not.toHaveBeenCalled();
  });
  it.each([
    { source: 'automatic' },
    { verifiedAt: date },
    { receivedAmount: new Prisma.Decimal(1) },
    { financeStatus: 'posted' },
    { paymentEvidenceId: 'pi_paid' },
    { rechargeJobId: id }
  ])('任何真实付款/收款事实阻止作废：%o', async (patch) => {
    const f = setup();
    Object.assign(f.order, patch);
    await expect(f.service.preview('order', id, 'cancel')).rejects.toThrow('付款');
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
  it('未作废不能删除；已作废只软删', async () => {
    const f = setup();
    await expect(f.service.preview('order', id, 'delete')).rejects.toThrow('先作废');
    Object.assign(f.order, { status: 'cancelled' });
    const preview = await f.service.preview('order', id, 'delete');
    await f.service.execute('order', id, 'delete', f.input(preview), f.operator);
    expect(f.repository.updateOrder).toHaveBeenCalledWith({}, id, expect.any(Date), false, id);
  });
  it('预览后依赖或版本改变拒绝写入', async () => {
    const f = setup();
    const preview = await f.service.preview('order', id, 'cancel');
    f.repository.orderReferences.mockResolvedValue({
      journals: 0,
      successor: 0,
      currentOrderId: 'new-order',
      subscriptionUpdatedAt: date.toISOString()
    });
    await expect(
      f.service.execute('order', id, 'cancel', f.input(preview), f.operator)
    ).rejects.toThrow('重新预览');
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
  });
  it('重复操作返回首次回执且不重新写；更换内容不能重用操作编号', async () => {
    const f = setup();
    const preview = await f.service.preview('order', id, 'cancel');
    const input = f.input(preview);
    const first = await f.service.execute('order', id, 'cancel', input, f.operator);
    const data = f.audit.append.mock.calls[0][1].afterData;
    f.repository.command.mockResolvedValue({ afterData: data });
    f.repository.updateOrder.mockClear();
    expect(await f.service.execute('order', id, 'cancel', input, f.operator)).toEqual(first);
    expect(f.repository.updateOrder).not.toHaveBeenCalled();
    await expect(
      f.service.execute('order', id, 'cancel', { ...input, reason: '其他原因' }, f.operator)
    ).rejects.toThrow('操作编号');
  });
  it('缺少无付款确认拒绝；审计失败向事务传播', async () => {
    const f = setup();
    const preview = await f.service.preview('order', id, 'cancel');
    await expect(
      f.service.execute(
        'order',
        id,
        'cancel',
        { ...f.input(preview), confirmNoPaymentOrReceipt: false },
        f.operator
      )
    ).rejects.toThrow('核对');
    f.audit.append.mockRejectedValue(new Error('audit fail'));
    await expect(
      f.service.execute('order', id, 'cancel', f.input(preview), f.operator)
    ).rejects.toThrow('audit fail');
  });
});
