import { describe, expect, it, vi } from 'vitest';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';

describe('银充资料查询完整性', () => {
  it('keeps all account options and provides real pagination with total count', async () => {
    const items = Array.from({ length: 501 }, (_, id) => ({
      id: String(id),
      emailHash: `hash-${id}`,
      emailMasked: `user-${id}`,
      status: 'active'
    }));
    const repository = {
      listAccounts: vi.fn(
        async ({ skip = 0, take = items.length }: { skip?: number; take?: number }) =>
          items.slice(skip, skip + take)
      ),
      countAccounts: vi.fn().mockResolvedValue(501),
      subscriptionsForAccounts: vi.fn().mockResolvedValue([]),
      loginNetworksByEmailHashes: vi.fn().mockResolvedValue([]),
      renewalWarningDays: vi.fn().mockResolvedValue(3)
    };
    const service = new BankRechargeAccountService(
      repository as never,
      {} as never,
      {} as never,
      {} as never
    );
    expect((await service.listAccounts()).items).toHaveLength(501);
    const page = await service.listAccounts({ page: '26', pageSize: '20' });
    expect(page.total).toBe(501);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe('500');
  });
  it('does not cap the card options at 500', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new BankRechargeRepository({
      idBusinessV2BankRechargeCard: { findMany }
    } as never);
    await repository.listCards();
    expect(findMany.mock.calls[0]?.[0].take).toBeUndefined();
  });
});
