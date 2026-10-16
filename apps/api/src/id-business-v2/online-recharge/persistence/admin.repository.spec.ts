import type { OnlineRechargeCodeStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeAdminRepository } from './admin.repository';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import type { OnlineRechargeSettingsService } from '../settings.service';

type Code = { status: OnlineRechargeCodeStatus; deletedAt: Date | null };

function fixture(codes: Code[]) {
  const db = {
    onlineRechargeTask: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
    onlineRechargeCode: {
      groupBy: vi.fn(async ({ where }: { where?: { deletedAt?: null } }) => {
        const counts = new Map<OnlineRechargeCodeStatus, number>();
        for (const code of codes) {
          if (where?.deletedAt === null && code.deletedAt !== null) continue;
          counts.set(code.status, (counts.get(code.status) ?? 0) + 1);
        }
        return [...counts].map(([status, _count]) => ({ status, _count }));
      })
    },
    onlineRechargeCard: { groupBy: vi.fn(async () => []) },
    onlineRechargeBill: { groupBy: vi.fn(async () => []) }
  };
  const repository = {
    read: async (callback: (client: typeof db) => unknown) => callback(db)
  } as unknown as OnlineRechargeRepository;
  const settings = {
    get: vi.fn(async () => ({ version: 0 }))
  } as unknown as OnlineRechargeSettingsService;
  return new OnlineRechargeAdminRepository(
    repository,
    {} as never,
    settings,
    {} as never,
    {} as never,
    {} as never
  );
}

describe('兑换码概览排除软删除记录', () => {
  for (const status of ['available', 'reserved', 'used', 'disabled'] as const) {
    it(`${status} 仅计入未删除记录`, async () => {
      const result = await fixture([
        { status, deletedAt: null },
        { status, deletedAt: new Date() }
      ]).overview();
      expect(result.codes).toEqual([{ status, _count: 1 }]);
    });
  }

  it('混合状态分别计数，保留原有返回结构', async () => {
    const rows: Code[] = [
      { status: 'available', deletedAt: null },
      { status: 'available', deletedAt: null },
      { status: 'used', deletedAt: null },
      { status: 'reserved', deletedAt: new Date() },
      { status: 'used', deletedAt: new Date() }
    ];
    expect((await fixture(rows).overview()).codes).toEqual([
      { status: 'available', _count: 2 },
      { status: 'used', _count: 1 }
    ]);
  });

  it('空记录和全部删除均不产生兑换码统计项', async () => {
    expect((await fixture([]).overview()).codes).toEqual([]);
    expect(
      (await fixture([{ status: 'available', deletedAt: new Date() }]).overview()).codes
    ).toEqual([]);
  });

  it('创建十个、软删除、再创建十个，数量为 10→0→10 且历史保留', async () => {
    const rows: Code[] = Array.from({ length: 10 }, () => ({
      status: 'available',
      deletedAt: null
    }));
    const admin = fixture(rows);
    const count = async () =>
      (await admin.overview()).codes.find((row) => row.status === 'available')?._count ?? 0;
    expect(await count()).toBe(10);
    for (const row of rows) row.deletedAt = new Date();
    expect(await count()).toBe(0);
    rows.push(
      ...Array.from({ length: 10 }, (): Code => ({ status: 'available', deletedAt: null }))
    );
    expect(await count()).toBe(10);
    expect(rows).toHaveLength(20);
  });
});
