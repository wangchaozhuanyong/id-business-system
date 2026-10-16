import type { OnlineRechargeCodeStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { OnlineRechargeAdminRepository } from './admin.repository';
import type { OnlineRechargeRepository } from './online-recharge.repository';
import type { OnlineRechargeSettingsService } from '../settings.service';
import { OnlineRechargeTasksRepository } from './tasks.repository';

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

describe('线上代充业务资料完整显示', () => {
  function visibilityFixture(items: unknown[]) {
    const repository = {
      list: vi.fn(async () => ({ items, total: items.length, page: 1, pageSize: 20 })),
      read: vi.fn(async (callback: (db: unknown) => unknown) =>
        callback({
          onlineRechargeTask: {
            findMany: async () => [{ id: 'task-id', emailEncrypted: 'fixture@example.invalid' }]
          }
        })
      ),
      transaction: vi.fn(
        async (_key: string, callback: (tx: unknown) => unknown, scopes?: readonly string[]) => {
          void scopes;
          return callback({});
        }
      ),
      log: vi.fn(async () => undefined)
    };
    const encryption = { decrypt: vi.fn((value: string) => value) };
    const admin = new OnlineRechargeAdminRepository(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      encryption as never
    );
    return { admin, repository, encryption };
  }

  it('管理员直接看完整兑换码，留审计且不发布线上代充刷新事件', async () => {
    const code = 'KC-SYNTHETICVISIBLE';
    const f = visibilityFixture([
      { id: 'code-id', codeEncrypted: code, codeLast4: 'IBLE', codeHash: 'hash' }
    ]);
    const result = await f.admin.list('cdks', {}, { id: 'admin', roles: ['admin'] } as never);
    expect(result.items).toEqual([{ id: 'code-id', code: code, codeLast4: 'IBLE' }]);
    expect(f.repository.log).toHaveBeenCalledWith({}, 'cdks.list', expect.anything(), undefined, {
      ids: ['code-id'],
      fields: ['兑换码']
    });
    expect(f.repository.transaction.mock.calls[0]?.[2]).toEqual(['audit-logs']);
  });

  it('只读角色保持原有取密边界，不解密兑换码', async () => {
    const f = visibilityFixture([
      { id: 'code-id', codeEncrypted: 'synthetic-secret-code', codeLast4: 'CODE' }
    ]);
    const result = await f.admin.list('cdks', {}, { roles: ['reader'], permissions: [] } as never);
    expect(result.items[0]).toMatchObject({ code: '····CODE' });
    expect(f.encryption.decrypt).not.toHaveBeenCalled();
    expect(f.repository.log).not.toHaveBeenCalled();
  });

  it('账单账号列从原任务加密资料补齐完整邮箱，金额仍为原Decimal字符串', async () => {
    const f = visibilityFixture([
      { id: 'bill-id', taskId: 'task-id', amount: '9990.00', currency: 'PHP' }
    ]);
    const result = await f.admin.list('billing', {}, { roles: ['admin'] } as never);
    expect(result.items[0]).toMatchObject({
      email: 'fixture@example.invalid',
      amount: '9990.00',
      currency: 'PHP'
    });
  });

  it('管理员可看完整登录来源 IP，其他角色仍不能访问安全日志', async () => {
    const f = visibilityFixture([
      { id: 'login-id', username: 'fixture', status: 'success', ip: '203.0.113.123' }
    ]);
    expect(
      (await f.admin.list('login-logs', {}, { roles: ['admin'] } as never)).items[0]
    ).toMatchObject({ ipMasked: '203.0.113.123' });
    await expect(f.admin.list('login-logs', {}, { roles: ['reader'] } as never)).rejects.toThrow(
      '仅管理员'
    );
  });

  it('任务、会话和续费页面保留完整业务邮箱，公共结果不暴露邮箱或凭据', () => {
    const tasks = new OnlineRechargeTasksRepository(
      {} as never,
      {} as never,
      { decrypt: (value: string) => value } as never,
      {} as never,
      {} as never
    );
    const row = {
      id: 'task-id',
      operation: 'recharge',
      emailEncrypted: 'fixture@example.invalid',
      message: '账号 fixture@example.invalid',
      result: { email: 'fixture@example.invalid', token: 'synthetic-token' }
    } as never;
    expect(tasks.map(row)).toMatchObject({
      email: 'fixture@example.invalid',
      message: '账号 fixture@example.invalid',
      result: { email: 'fixture@example.invalid' }
    });
    const publicResult = tasks.map(row, true);
    expect(publicResult.email).toBeUndefined();
    expect(JSON.stringify(publicResult)).not.toContain('fixture@example.invalid');
    expect(JSON.stringify(publicResult)).not.toContain('synthetic-token');
  });
});
