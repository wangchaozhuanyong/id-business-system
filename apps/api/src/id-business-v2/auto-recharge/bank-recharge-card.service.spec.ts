import { describe, expect, it, vi } from 'vitest';
import { BankRechargeCardService } from './bank-recharge-card.service';

const cardId = '123e4567-e89b-42d3-a456-426614174000';
const number = '5555555555554444';

function setup() {
  const tx = {};
  const repository = {
    create: vi.fn().mockResolvedValue({
      id: cardId,
      label: '银行卡 ····4444',
      last4: '4444',
      currencyCode: 'USD',
      active: true
    }),
    findByNumberHash: vi.fn().mockResolvedValue(null),
    findInTransaction: vi.fn().mockResolvedValue(null),
    hasOrders: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue({ id: cardId })
  };
  const accounts = { requireCurrency: vi.fn().mockResolvedValue({ code: 'USD' }) };
  const transactions = {
    execute: vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx))
  };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const encryption = {
    encrypt: vi.fn((value: string) => `encrypted:${value}`),
    decrypt: vi.fn((value: string | null) => value?.replace('encrypted:', '') ?? null),
    hash: vi.fn((value: string) => `hash:${value}`)
  };
  const service = new BankRechargeCardService(
    repository as never,
    accounts as never,
    transactions as never,
    audit as never,
    encryption as never
  );
  return { service, repository, transactions, audit, encryption };
}

describe('银行卡管理', () => {
  it('批量导入先验证，成功时在同一事务加密且审计不含卡号', async () => {
    const { service, repository, transactions, audit } = setup();
    const operator = { id: 'operator-id' } as never;
    await expect(
      service.importCards(
        {
          currencyCode: 'USD',
          cards: [
            { number, expiry: '12/39' },
            { number: '4111111111111111', expiry: '12/39', cvc: '123' }
          ]
        },
        operator
      )
    ).rejects.toThrow('第 2 行');
    expect(transactions.execute).not.toHaveBeenCalled();
    const result = await service.importCards(
      { currencyCode: 'USD', cards: [{ number, expiry: '12/39' }] },
      operator
    );
    expect(result).toEqual({ imported: 1 });
    expect(transactions.execute).toHaveBeenCalledTimes(1);
    expect(repository.create.mock.calls[0]?.[1].numberEncrypted).toBe(`encrypted:${number}`);
    expect(repository.create.mock.calls[0]?.[1].numberHash).toBe(`hash:${number}`);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(number);
  });

  it('停用卡号不可充值，已有订单的银行卡不可删除', async () => {
    const { service, repository } = setup();
    repository.findByNumberHash.mockResolvedValue({ id: cardId, active: false });
    await expect(service.checkAvailability({ number })).rejects.toThrow('已停用');
    repository.findInTransaction.mockResolvedValue({ id: cardId, label: '卡', last4: '4444' });
    repository.hasOrders.mockResolvedValue({ id: 'order-id' });
    await expect(service.delete(cardId, { id: 'operator-id' } as never)).rejects.toThrow(
      '已有订单'
    );
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('查看完整卡号留审计，不在审计中写入卡号', async () => {
    const { service, repository, audit } = setup();
    repository.findInTransaction.mockResolvedValue({
      id: cardId,
      label: '卡',
      numberEncrypted: `encrypted:${number}`,
      last4: '4444',
      expiry: '12/39',
      currencyCode: 'USD',
      active: true,
      remark1: null,
      remark2: null
    });
    const detail = await service.detail(cardId, { id: 'operator-id' } as never);
    expect(detail.number).toBe(number);
    expect(JSON.stringify(audit.append.mock.calls)).not.toContain(number);
  });
});
