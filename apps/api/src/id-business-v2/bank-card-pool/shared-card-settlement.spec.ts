import { describe, expect, it, vi } from 'vitest';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';

describe('比特释放后原付款结算', () => {
  it('旧任务迟到成功只计原尝试，保留新任务银行卡租约', async () => {
    const card = {
      id: 'shared',
      leaseOwner: 'new-job',
      successCount: 0,
      declineCount: 0,
      status: 'active'
    };
    const tx = {
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      onlineRechargeConfig: { findUnique: vi.fn(async () => null) },
      onlineRechargeCard: {
        findFirst: vi.fn(async ({ where }) => (where.leaseOwner === card.leaseOwner ? card : null)),
        findUnique: vi.fn(async () => card),
        updateMany: vi.fn(async ({ where, data }) => {
          if (where.leaseOwner && where.leaseOwner !== card.leaseOwner) return { count: 0 };
          for (const [key, value] of Object.entries(data))
            (card as Record<string, unknown>)[key] =
              value && typeof value === 'object' && 'increment' in value
                ? Number((card as Record<string, unknown>)[key]) + Number(value.increment)
                : value;
          return { count: 1 };
        })
      }
    };
    const pool = new SharedBankCardRepository({} as never, {} as never, {} as never, {} as never);
    const attempt = {
      cardId: card.id,
      authorizedAt: new Date().toISOString(),
      outcome: 'pending' as const
    };
    const settled = await pool.finishBitBrowser(
      tx as never,
      'old-job',
      { payment_status: 'paid', payment_attempted: true },
      true,
      attempt
    );
    expect(card).toMatchObject({ successCount: 1, leaseOwner: 'new-job' });
    expect(settled).toMatchObject({ outcome: 'paid', cardId: 'shared' });
    await pool.finishBitBrowser(
      tx as never,
      'old-job',
      { payment_status: 'paid', payment_attempted: true },
      true,
      settled
    );
    expect(card).toMatchObject({ successCount: 1, leaseOwner: 'new-job' });
  });
});
