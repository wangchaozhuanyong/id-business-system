import { describe, expect, it, vi } from 'vitest';
import { BankRechargeOrderService } from './bank-recharge-order.service';

const id = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const updatedAt = new Date('2026-10-04T00:00:00Z');
const context = { businessTime: updatedAt, markChangedScopes: vi.fn() } as never;
function setup(source = 'manual') {
  const order = {
    id,
    source,
    rechargeJobId: 'source',
    status: 'pending_details',
    updatedAt,
    chargeCurrencyCode: 'CNY',
    chargeAmount: '100',
    plan: 'plus',
    accountId: null,
    customerId: null,
    cardId: null,
    cardLast4: null,
    customerFeeRate: '0',
    customerFeeAmount: '0',
    customerFeeOverridden: false,
    bankFeeAmount: null,
    bankFeeCurrencyCode: null,
    receivedAmount: null,
    receivedCurrencyCode: null,
    chargeFxRateToCny: '2',
    bankFeeFxRateToCny: null,
    receivedFxRateToCny: null,
    openedAt: null,
    dueAt: null
  };
  const repository = {
    findOrder: vi.fn().mockResolvedValue(order),
    findRechargeJob: vi.fn().mockResolvedValue({ accountKey: 'original' }),
    updateOrder: vi.fn(async (_tx, args) => ({ ...order, ...args.data }))
  };
  const accounts = {
    requireCurrency: vi.fn().mockResolvedValue({ minorUnits: 2 }),
    requireActive: vi.fn().mockResolvedValue({ officialAccountKey: 'wrong' })
  };
  const audit = { append: vi.fn() };
  const service = new BankRechargeOrderService(
    {} as never,
    audit as never,
    accounts as never,
    repository as never,
    {} as never,
    {} as never
  );
  const input = { expectedUpdatedAt: updatedAt.toISOString() };
  return { service, repository, order, audit, input };
}

describe('银充编辑边界', () => {
  it.each([{ chargeFxRateToCny: '2' }, {}])('人民币非1汇率不可新写入或沿用 %j', async (patch) => {
    const { service, repository, input } = setup();
    await expect(
      service.updateInTransaction(
        {} as never,
        id,
        { ...input, ...patch },
        {
          id: 'operator'
        } as never,
        context
      )
    ).rejects.toThrow('人民币时必须为 1');
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });
  it('明确更正为1时保留原2和新1的审计快照', async () => {
    const { service, audit, input } = setup();
    const saved = await service.updateInTransaction(
      {} as never,
      id,
      { ...input, chargeFxRateToCny: '1' },
      { id: 'operator' } as never,
      context
    );
    expect(saved.chargeFxRateToCny).not.toBeNull();
    expect(saved.chargeFxRateToCny!.toString()).toBe('1');
    expect(audit.append).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        beforeData: expect.objectContaining({ chargeFxRateToCny: '2' }),
        afterData: expect.objectContaining({ chargeFxRateToCny: '1' })
      })
    );
  });
  it('自动单不能人工选中另一个官网身份的账号', async () => {
    const { service, repository, input } = setup('automatic');
    await expect(
      service.updateInTransaction(
        {} as never,
        id,
        { ...input, accountId, chargeFxRateToCny: '1' },
        { id: 'operator' } as never,
        context
      )
    ).rejects.toThrow('原官网付款身份不一致');
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });
  it('自动单普通编辑不能给未知开通时间填当前时间', async () => {
    const { service, repository, input } = setup('automatic');
    await expect(
      service.updateInTransaction(
        {} as never,
        id,
        { ...input, openedAt: '2026-10-04T10:00:00Z' },
        {
          id: 'operator'
        } as never,
        context
      )
    ).rejects.toThrow('核对订阅');
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });
});
