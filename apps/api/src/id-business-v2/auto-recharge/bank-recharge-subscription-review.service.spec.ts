import { describe, expect, it, vi } from 'vitest';
import { BankRechargeSubscriptionReviewService } from './bank-recharge-subscription-review.service';
const id = '123e4567-e89b-42d3-a456-426614174000';
const accountId = '123e4567-e89b-42d3-a456-426614174001';
const date = new Date('2026-10-04T08:00:00.000Z');
function setup() {
  const order = {
    id,
    source: 'automatic',
    rechargeJobId: id,
    status: 'pending_details',
    verifiedAt: date,
    deletedAt: null,
    updatedAt: date,
    accountId,
    customerId: null,
    plan: 'plus',
    openedAt: null,
    dueAt: null
  };
  const repository = {
    originalPaymentAccountKey: vi.fn().mockResolvedValue({ accountKey: 'verified' }),
    read: vi.fn((work) => work({})),
    lock: vi.fn(),
    order: vi.fn(async () => order),
    account: vi
      .fn()
      .mockResolvedValue({ id: accountId, status: 'active', officialAccountKey: 'verified' }),
    subscription: vi.fn().mockResolvedValue(null),
    command: vi.fn().mockResolvedValue(null),
    updateDates: vi.fn(async () => order),
    activateReviewed: vi.fn()
  };
  const audit = { append: vi.fn() };
  const transactions = { execute: vi.fn((work) => work({})) };
  const service = new BankRechargeSubscriptionReviewService(
    repository as never,
    transactions as never,
    audit as never
  );
  const input = {
    expectedUpdatedAt: date.toISOString(),
    expectedCurrentOrderId: null,
    expectedSubscriptionUpdatedAt: null,
    openedAt: '2026-10-01T08:00:00.000Z',
    dueAt: '2026-11-01T08:00:00.000Z',
    dateEvidenceRef: 'official_invoice_reference',
    reason: '核对真实官网订阅日期',
    operationId: id,
    confirmedOfficialDates: true,
    makeCurrent: true
  };
  const operator = { id, roles: ['admin'] } as never;
  return { service, repository, audit, order, input, operator };
}
describe('订阅日期受控核对', () => {
  it('无投影时通过明确官网日期及原版本核对建立订阅，不财务入账', async () => {
    const f = setup();
    await f.service.verify(id, f.input, f.operator);
    expect(f.repository.updateDates).toHaveBeenCalledWith(
      {},
      id,
      new Date(f.input.openedAt),
      new Date(f.input.dueAt),
      id
    );
    expect(f.repository.activateReviewed).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ accountId, id })
    );
    expect(f.audit.append).toHaveBeenCalledOnce();
  });
  it.each(['2026-09-01T08:00:00.000Z', '2026-10-03T08:00:00.000Z'])(
    '历史或同时间订单拒绝覆盖当前较新订阅 %s',
    async (openedAt) => {
      const f = setup();
      const currentOrderId = '123e4567-e89b-42d3-a456-426614174002';
      f.repository.subscription.mockResolvedValue({
        currentOrderId,
        status: 'active',
        openedAt: new Date('2026-10-03T08:00:00.000Z'),
        updatedAt: date
      });
      await expect(
        f.service.verify(
          id,
          {
            ...f.input,
            openedAt,
            expectedCurrentOrderId: currentOrderId,
            expectedSubscriptionUpdatedAt: date.toISOString()
          },
          f.operator
        )
      ).rejects.toThrow('历史或同时间');
      expect(f.repository.updateDates).not.toHaveBeenCalled();
      expect(f.repository.activateReviewed).not.toHaveBeenCalled();
    }
  );
  it('历史日期可只回填原单，不抢占新订阅', async () => {
    const f = setup();
    f.repository.subscription.mockResolvedValue({
      currentOrderId: accountId,
      status: 'active',
      openedAt: date,
      updatedAt: date
    });
    await f.service.verify(
      id,
      {
        ...f.input,
        makeCurrent: false,
        expectedCurrentOrderId: accountId,
        expectedSubscriptionUpdatedAt: date.toISOString()
      },
      f.operator
    );
    expect(f.repository.updateDates).toHaveBeenCalledOnce();
    expect(f.repository.activateReviewed).not.toHaveBeenCalled();
  });

  it.each(['expired', 'cancelled'])('非活动但较新指针同样不能被旧日期替换：%s', async (status) => {
    const f = setup();
    const currentOrderId = '123e4567-e89b-42d3-a456-426614174002';
    f.repository.subscription.mockResolvedValue({
      currentOrderId,
      status,
      openedAt: new Date('2026-10-03T08:00:00.000Z'),
      updatedAt: date
    });
    await expect(
      f.service.verify(
        id,
        {
          ...f.input,
          expectedCurrentOrderId: currentOrderId,
          expectedSubscriptionUpdatedAt: date.toISOString()
        },
        f.operator
      )
    ).rejects.toThrow('历史或同时间');
    expect(f.repository.activateReviewed).not.toHaveBeenCalled();
  });

  it('并发当前指针变化、来源账号未绑定、软删状态均拒绝', async () => {
    const f = setup();
    f.repository.subscription.mockResolvedValue({
      currentOrderId: accountId,
      status: 'active',
      openedAt: date,
      updatedAt: date
    });
    await expect(f.service.verify(id, f.input, f.operator)).rejects.toThrow('已变化');
    f.repository.subscription.mockResolvedValue(null);
    f.repository.account.mockResolvedValue({ status: 'active' });
    await expect(f.service.verify(id, f.input, f.operator)).rejects.toThrow('官网身份');
    Object.assign(f.order, { deletedAt: date });
    await expect(f.service.preview(id)).rejects.toThrow('已删除');
  });
  it('缺少凭据确认与无效日期停止；审计失败传播到事务', async () => {
    const f = setup();
    await expect(
      f.service.verify(id, { ...f.input, confirmedOfficialDates: false }, f.operator)
    ).rejects.toThrow('请确认');
    await expect(
      f.service.verify(id, { ...f.input, dueAt: f.input.openedAt }, f.operator)
    ).rejects.toThrow('范围无效');
    f.audit.append.mockRejectedValue(new Error('audit fail'));
    await expect(f.service.verify(id, f.input, f.operator)).rejects.toThrow('audit fail');
  });
  it('重复同一核对回执不重新切换订阅，修改载荷不能重用操作编号', async () => {
    const f = setup();
    const first = await f.service.verify(id, f.input, f.operator);
    f.repository.command.mockResolvedValue({
      afterData: f.audit.append.mock.calls[0][1].afterData
    });
    f.repository.activateReviewed.mockClear();
    expect(await f.service.verify(id, f.input, f.operator)).toEqual(first);
    expect(f.repository.activateReviewed).not.toHaveBeenCalled();
    await expect(
      f.service.verify(id, { ...f.input, reason: '另外修改' }, f.operator)
    ).rejects.toThrow('操作编号');
  });
});
