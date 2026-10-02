import { describe, it, expect, vi } from 'vitest';
import { RechargeCardRemovalService } from './recharge-card-removal.service';
const id = '123e4567-e89b-42d3-a456-426614174000';
const operator = { id: 'operator' } as never;
function setup() {
  const card = {
    id: 'card-id',
    label: 'Test Card',
    last4: '4444',
    updatedAt: new Date('2026-10-02T08:00:00Z'),
    numberHash: 'hash-fixture',
    numberEncrypted: '5555555555554444',
    billingNameEncrypted: 'encrypted-name'
  };
  const repository = {
    lock: vi.fn(),
    account: vi.fn().mockResolvedValue({ id }),
    openingOrder: vi.fn().mockResolvedValue({ id: 'order-id', card }),
    accounts: vi.fn().mockResolvedValue([{ accountId: id }, { accountId: 'another' }]),
    orders: vi.fn().mockResolvedValue(3),
    activeJob: vi.fn().mockResolvedValue(null),
    remove: vi.fn()
  };
  const transactions = { execute: vi.fn(async (work) => work({})) };
  const names = { confirm: vi.fn() },
    audit = { append: vi.fn() };
  const input = {
    cardId: card.id,
    orderId: 'order-id',
    expectedUpdatedAt: card.updatedAt.toISOString(),
    linkedAccountCount: 2,
    orderCount: 3
  };
  return {
    repository,
    audit,
    names,
    input,
    service: new RechargeCardRemovalService(
      repository as never,
      transactions as never,
      audit as never,
      names as never,
      {
        decrypt: (value: string | null) => value,
        encrypt: (value: string) => `encrypted:${value}`
      } as never
    )
  };
}
describe('从开通账号删除银行卡', () => {
  it('预览共享影响；删除只移除卡片且保留姓名和历史', async () => {
    const { service, input, repository, audit, names } = setup();
    expect(await service.preview(id, operator)).toMatchObject({
      linkedAccountCount: 2,
      orderCount: 3,
      last4: '4444',
      numberSummary: '5*******55554444'
    });
    expect(await service.remove(id, input, operator)).toEqual({ deleted: true });
    expect(repository.remove).toHaveBeenCalledTimes(1);
    expect(repository.remove).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: 'card-id' }),
      'encrypted:5*******55554444'
    );
    expect(names.confirm).toHaveBeenCalledWith({}, 'hash-fixture', 'encrypted-name');
    expect(audit.append.mock.calls[0][1].afterData).toEqual({ historyPreserved: true });
  });
  it.each(['cardId', 'orderId', 'linkedAccountCount', 'orderCount'])(
    '拒绝删除确认后变化的 %s',
    async (key) => {
      const { service, input, repository } = setup();
      await expect(service.remove(id, { ...input, [key]: 'different' }, operator)).rejects.toThrow(
        '重新确认'
      );
      expect(repository.remove).not.toHaveBeenCalled();
    }
  );
  it('版本变化、任务未结束和银行卡已删除都不会继续删除', async () => {
    const { service, input, repository } = setup();
    await expect(
      service.remove(id, { ...input, expectedUpdatedAt: '2026-10-01T08:00:00Z' }, operator)
    ).rejects.toThrow('已被其他人修改');
    repository.activeJob.mockResolvedValue({ id: 'running' });
    await expect(service.remove(id, input, operator)).rejects.toThrow('未结束');
    repository.openingOrder.mockResolvedValue({ id: 'order-id', card: null });
    await expect(service.remove(id, input, operator)).rejects.toThrow('暂无可删除');
    expect(repository.remove).not.toHaveBeenCalled();
  });
});
