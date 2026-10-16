import { describe, expect, it, vi } from 'vitest';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';
import { OnlineRechargeAssetsRepository } from '../online-recharge/persistence/assets.repository';
import { RechargeNameService } from '../auto-recharge/recharge-name.service';

const cardId = '22222222-2222-4222-8222-222222222222';
const operator = { id: 'operator', roles: ['admin'], permissions: [] } as never;

function fixture() {
  const shared = {
    id: cardId,
    numberHash: 'synthetic-hash',
    status: 'disabled',
    allowedPlans: ['plus'],
    leaseOwner: null as string | null,
    successCount: 0,
    declineCount: 0
  };
  const legacy = {
    id: 'legacy-card',
    numberHash: shared.numberHash,
    numberEncrypted: 'synthetic-encrypted',
    last4: '1111',
    expiry: '12/99',
    currencyCode: 'USD',
    active: false
  };
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    onlineRechargeCard: {
      findUnique: vi.fn(async () => shared),
      upsert: vi.fn(async () => shared),
      update: vi.fn(async ({ data }) => Object.assign(shared, data)),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          shared.status !== where.status ||
          (shared.leaseOwner && shared.leaseOwner !== where.OR[1].leaseOwner)
        )
          return { count: 0 };
        Object.assign(shared, { leaseOwner: data.leaseOwner });
        return { count: 1 };
      })
    },
    onlineRechargeConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    onlineRechargeTask: { count: vi.fn().mockResolvedValue(0) }
  };
  const transactions = { execute: vi.fn(async (work) => work(tx)) };
  const encryption = {
    hash: () => shared.numberHash,
    decrypt: () => 'Synthetic Person'
  };
  const pool = new SharedBankCardRepository(
    {} as never,
    encryption as never,
    transactions as never,
    {} as never
  );
  const assets = new OnlineRechargeAssetsRepository(
    {} as never,
    {
      transaction: async (_key: unknown, work: (tx: unknown) => unknown) => work(tx),
      log: vi.fn()
    } as never,
    encryption as never,
    {} as never
  );
  const names = new RechargeNameService(
    {
      lock: vi.fn(),
      card: async () => legacy,
      cardById: async () => legacy,
      binding: async () => ({ confirmed: true, nameEncrypted: 'synthetic-encrypted' })
    } as never,
    transactions as never,
    { append: vi.fn() } as never,
    encryption as never,
    pool
  );
  return { shared, legacy, tx, pool, assets, names };
}

describe('共享池权威状态与跨币种调用', () => {
  it('共享池重新启用旧停用卡后，姓名匹配、登记和跨币种执行都可使用', async () => {
    const { assets, names, shared, legacy, tx } = fixture();
    await assets.action('cards', 'status', { id: cardId, status: 'active' }, operator);
    expect(legacy.active).toBe(false);
    expect(await names.match({ number: '4111111111111111' }, operator)).toMatchObject({
      name: 'Synthetic Person',
      cardId: legacy.id
    });
    expect(
      await names.prepare(
        {
          number: '4111111111111111',
          expiry: '12/99',
          name: 'Synthetic Person',
          currencyCode: 'PHP',
          plan: 'plus'
        },
        operator
      )
    ).toEqual({ cardId: legacy.id });
    expect(
      await names.localCard(tx as never, legacy.id, 'Synthetic Person', 'PHP', 'plus', 'job')
    ).toBe(legacy);
    expect(shared.leaseOwner).toBe('job');
    expect(legacy.currencyCode).toBe('USD');
  });

  it('共享池停用、套餐不符或其他任务占用时，旧资料不能绕过限制', async () => {
    const { names, shared, tx, legacy } = fixture();
    legacy.active = true;
    await expect(names.match({ number: '4111111111111111' }, operator)).rejects.toThrow('已停用');
    await expect(
      names.localCard(tx as never, legacy.id, 'Synthetic Person', 'PHP', 'plus', 'job')
    ).rejects.toThrow('已停用');
    shared.status = 'active';
    await expect(
      names.localCard(tx as never, legacy.id, 'Synthetic Person', 'PHP', 'pro-20x', 'job')
    ).rejects.toThrow('不允许');
    shared.leaseOwner = 'other-job';
    await expect(
      names.localCard(tx as never, legacy.id, 'Synthetic Person', 'PHP', 'plus', 'job')
    ).rejects.toThrow('正被');
  });
});
