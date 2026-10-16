import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeAssetsRepository } from '../online-recharge/persistence/assets.repository';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';

function setup() {
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    onlineRechargeCard: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'card' }),
      update: vi.fn(),
      delete: vi.fn()
    },
    onlineRechargeTask: { count: vi.fn().mockResolvedValue(0) },
    onlineRechargeBill: { count: vi.fn().mockResolvedValue(0) },
    idBusinessV2BankRechargeCard: { findUnique: vi.fn().mockResolvedValue(null) }
  };
  const repository = { transaction: vi.fn(async (_key, work) => work(tx)), log: vi.fn() };
  const memory = { putCards: vi.fn(), forgetCvc: vi.fn() };
  const assets = new OnlineRechargeAssetsRepository(
    {} as never,
    repository as never,
    { hash: () => 'hash-only', encrypt: () => 'encrypted-only' } as never,
    memory as never
  );
  return { assets, tx, memory, repository };
}
const operator = { id: 'operator', roles: ['admin'], permissions: [] } as never;
describe('共享卡池管理', () => {
  it('旧账号删除入口也保护线上占用和历史，无线上历史时同步删除共享卡', async () => {
    const { tx } = setup();
    const pool = new SharedBankCardRepository({} as never, {} as never, {} as never, {} as never);
    tx.onlineRechargeCard.findUnique.mockResolvedValue({ id: 'shared', leaseOwner: 'online-job' });
    await expect(pool.removeLegacyData(tx as never, 'hash')).rejects.toThrow(
      '请在银行卡共享池停用'
    );
    tx.onlineRechargeCard.findUnique.mockResolvedValue({ id: 'shared', leaseOwner: null });
    tx.onlineRechargeTask.count.mockResolvedValue(1);
    await expect(pool.removeLegacyData(tx as never, 'hash')).rejects.toThrow(
      '请在银行卡共享池停用'
    );
    expect(tx.onlineRechargeCard.delete).not.toHaveBeenCalled();
    tx.onlineRechargeTask.count.mockResolvedValue(0);
    await pool.removeLegacyData(tx as never, 'hash');
    expect(tx.onlineRechargeCard.delete).toHaveBeenCalledWith({ where: { id: 'shared' } });
  });
  it('可不填写安全码添加仅限 Plus 的卡，审计不含卡号', async () => {
    const { assets, tx, memory, repository } = setup();
    await assets.action(
      'cards',
      'create',
      {
        number: '4111111111111111',
        expiryMonth: 12,
        expiryYear: 2099,
        cvc: '',
        allowedPlans: ['plus']
      },
      operator
    );
    expect(tx.onlineRechargeCard.create.mock.calls[0]?.[0].data.allowedPlans).toEqual(['plus']);
    expect(memory.putCards).toHaveBeenCalledWith([]);
    expect(JSON.stringify(repository.log.mock.calls)).not.toContain('4111111111111111');
  });
  it('不能保存空套餐范围，不能修改被比特任务占用的卡', async () => {
    const { assets, tx } = setup();
    const id = '22222222-2222-4222-8222-222222222222';
    tx.onlineRechargeCard.findUnique.mockResolvedValue({
      id,
      numberHash: 'hash',
      status: 'active',
      leaseOwner: null
    });
    await expect(
      assets.action('cards', 'update', { id, allowedPlans: [] }, operator)
    ).rejects.toThrow('至少选择');
    expect(tx.onlineRechargeCard.update).not.toHaveBeenCalled();
    tx.onlineRechargeCard.findUnique.mockResolvedValue({ id, leaseOwner: 'bit-job' });
    await expect(
      assets.action('cards', 'update', { id, allowedPlans: ['plus'] }, operator)
    ).rejects.toThrow('不能更改');
  });
  it('保留有比特历史关联的共享卡，避免删除后重新导入丢失限制', async () => {
    const { assets, tx } = setup();
    const id = '22222222-2222-4222-8222-222222222222';
    tx.onlineRechargeCard.findUnique.mockResolvedValue({
      id,
      numberHash: 'hash',
      leaseOwner: null
    });
    tx.idBusinessV2BankRechargeCard.findUnique.mockResolvedValue({ id: 'historical-card' });
    await expect(assets.action('cards', 'delete', { id }, operator)).rejects.toThrow('改为停用');
    expect(tx.onlineRechargeCard.delete).not.toHaveBeenCalled();
  });
});
